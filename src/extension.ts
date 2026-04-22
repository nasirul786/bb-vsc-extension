import * as vscode from 'vscode';
import * as https from 'https';

export function activate(context: vscode.ExtensionContext) {
    const bbeFs = new BBEFileSystemProvider(context);
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('bbe', bbeFs, { isCaseSensitive: true }));

    const botsTreeProvider = new BotsTreeProvider(context);
    vscode.window.registerTreeDataProvider('bbe-bots', botsTreeProvider);

    let loginDisposable = vscode.commands.registerCommand('bbe.login', async () => {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your Bots Business API Key',
            placeHolder: 'API Key',
            password: true,
            ignoreFocusOut: true
        });

        if (!apiKey) { return; }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "BBE: Logging in...",
            cancellable: false
        }, async (_progress) => {
            try {
                const response = await fetchFromApi('user', apiKey);
                if (response.errors) {
                    vscode.window.showErrorMessage(`Login failed: ${response.errors.join(', ')}`);
                } else {
                    await context.globalState.update('bbe_user', response);
                    await context.secrets.store('bbe_api_key', apiKey);
                    vscode.window.showInformationMessage(`Login success! Welcome, ${response.email}`);
                    botsTreeProvider.refresh();
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error: ${error.message}`);
            }
        });
    });

    let loadBotsDisposable = vscode.commands.registerCommand('bbe.loadBots', async () => {
        botsTreeProvider.clearIsolation();
        // Reload window as requested (Ctrl + R)
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    });

    let openCommandDisposable = vscode.commands.registerCommand('bbe.openCommand', (cmd: any) => {
        bbeFs.cacheCommand(cmd);
        const uri = vscode.Uri.parse(`bbe:/${cmd.bot_id}/${cmd.id}.js`);
        vscode.window.showTextDocument(uri);
    });

    let createCommandDisposable = vscode.commands.registerCommand('bbe.createCommand', async (item: BotItem | FolderItem) => {
        const name = await vscode.window.showInputBox({ prompt: 'Enter command name (e.g. /start)', placeHolder: '/command' });
        if (!name) { return; }

        const apiKey = await context.secrets.get('bbe_api_key');
        if (!apiKey) { return; }

        const botId = item instanceof BotItem ? item.bot.id : item.botId;
        const folderId = item instanceof FolderItem ? item.folderId : undefined;

        try {
            const body: any = { command: name };
            if (folderId) { body.commands_folder_id = folderId; }

            const cmd = await postToApi(`bots/${botId}/commands`, apiKey, body);
            vscode.window.showInformationMessage(`Command "${name}" created.`);

            botsTreeProvider.refresh();
            // Open the new command
            vscode.commands.executeCommand('bbe.openCommand', cmd);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create command: ${error.message}`);
        }
    });

    let deleteCommandDisposable = vscode.commands.registerCommand('bbe.deleteCommand', async (item: CommandItem) => {
        const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete command "${item.cmd.command}"?`, { modal: true }, 'Delete');
        if (confirm !== 'Delete') { return; }

        const apiKey = await context.secrets.get('bbe_api_key');
        if (!apiKey) { return; }

        try {
            await deleteFromApi(`bots/${item.cmd.bot_id}/commands/${item.cmd.id}`, apiKey);
            vscode.window.showInformationMessage(`Command "${item.cmd.command}" deleted.`);
            botsTreeProvider.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to delete command: ${error.message}`);
        }
    });

    let createFolderDisposable = vscode.commands.registerCommand('bbe.createFolder', async (item: BotItem) => {
        const title = await vscode.window.showInputBox({ prompt: 'Enter folder title', placeHolder: 'Folder Title' });
        if (!title) { return; }

        const apiKey = await context.secrets.get('bbe_api_key');
        if (!apiKey) { return; }

        try {
            await postToApi(`bots/${item.bot.id}/commands_folders`, apiKey, { title });
            vscode.window.showInformationMessage(`Folder "${title}" created.`);
            botsTreeProvider.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create folder: ${error.message}`);
        }
    });

    let copyFolderIdDisposable = vscode.commands.registerCommand('bbe.copyFolderId', (item: FolderItem) => {
        vscode.env.clipboard.writeText(item.folderId.toString());
        vscode.window.showInformationMessage('Folder ID copied to clipboard');
    });

    let deleteFolderDisposable = vscode.commands.registerCommand('bbe.deleteFolder', async (item: FolderItem) => {
        const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete folder "${item.title}"?`, { modal: true }, 'Delete');
        if (confirm !== 'Delete') { return; }

        const apiKey = await context.secrets.get('bbe_api_key');
        if (!apiKey) { return; }

        try {
            await deleteFromApi(`bots/${item.botId}/commands_folders/${item.folderId}`, apiKey);
            vscode.window.showInformationMessage(`Folder "${item.title}" deleted.`);
            botsTreeProvider.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to delete folder: ${error.message}`);
        }
    });

    let refreshTreeDisposable = vscode.commands.registerCommand('bbe.refreshTree', () => {
        botsTreeProvider.refresh();
    });

    let loadLibrariesDisposable = vscode.commands.registerCommand('bbe.loadLibraries', async () => {
        const apiKey = await context.secrets.get('bbe_api_key');
        if (!apiKey) {
            vscode.window.showErrorMessage('No API Key found. Please login first.');
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'bbeLibraries',
            'Bots Business Libraries',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = `<html><body><h1 style="color: grey;">Loading store...</h1></body></html>`;

        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'copied':
                        vscode.window.showInformationMessage(`Copied to clipboard: ${message.text}`);
                        return;
                }
            },
            undefined,
            context.subscriptions
        );

        try {
            const libs = await fetchFromApi('store/libs', apiKey);
            panel.webview.html = getLibrariesStoreWebviewHtml(libs);
        } catch (error: any) {
            panel.webview.html = `<html><body><h1>Error loading libraries</h1><p>${error.message}</p></body></html>`;
        }
    });

    let botActions = ['bbe.startStopBot', 'bbe.copyBotId', 'bbe.installLib', 'bbe.viewInstalledLibs', 'bbe.uninstallLib', 'bbe.viewErrorLogs', 'bbe.botMore'].map(cmdId => 
        vscode.commands.registerCommand(cmdId, async (item: BotItem) => {
            if (!item || !item.bot) { return; }
            const botId = item.bot.id;
            const apiKey = await context.secrets.get('bbe_api_key');
            if (!apiKey) { return; }

            if (cmdId === 'bbe.startStopBot') {
                const currentStatus = item.bot.status;
                const works = currentStatus === 'works';
                const targetStatus = works ? 'start_stopping' : 'start_launch';
                const successState = works ? 'stopped' : 'started';

                // Instant UI Update
                item.bot.status = works ? 'stopped' : 'works'; 
                vscode.commands.executeCommand('bbe.refreshTree');

                try {
                    await postToApi(`bots/${botId}/status`, apiKey, { status: targetStatus });
                    vscode.window.showInformationMessage(`Bot "${item.bot.name}" ${successState}.`);
                } catch (error: any) {
                    // Revert on failure
                    item.bot.status = currentStatus;
                    vscode.commands.executeCommand('bbe.refreshTree');
                    vscode.window.showErrorMessage(`Failed to change bot status: ${error.message}`);
                }
                return;
            }

            if (cmdId === 'bbe.botMore') {
                const works = item.bot.status === 'works';
                const options = [
                    { label: works ? '$(primitive-square) Stop Bot' : '$(play) Start Bot', id: 'bbe.startStopBot' },
                    { label: '$(clippy) Copy Bot ID', id: 'bbe.copyBotId' },
                    { label: '$(plus) Install Lib', id: 'bbe.installLib' },
                    { label: '$(list-unordered) View Installed Libs', id: 'bbe.viewInstalledLibs' },
                    { label: '$(trash) Uninstall a Lib', id: 'bbe.uninstallLib' },
                    { label: '$(bug) Error logs', id: 'bbe.viewErrorLogs' }
                ];
                const selected = await vscode.window.showQuickPick<any>(options, { placeHolder: `Manage Bot: ${item.bot.name}` });
                if (selected) {
                    vscode.commands.executeCommand(selected.id, item);
                }
                return;
            }

            if (cmdId === 'bbe.copyBotId') {
                await vscode.env.clipboard.writeText(String(botId));
                vscode.window.showInformationMessage(`Bot ID ${botId} copied to clipboard.`);
                return;
            }

            if (cmdId === 'bbe.installLib') {
                const libId = await vscode.window.showInputBox({ 
                    prompt: 'Enter Library ID to install',
                    placeHolder: 'e.g. 10'
                });
                if (!libId) { return; }

                try {
                    const result = await postToApi(`bots/${botId}/libs`, apiKey, { lib_id: Number(libId) });
                    if (result === 'true' || result === true) {
                        vscode.window.showInformationMessage(`Library ${libId} installed successfully.`);
                    } else {
                        // Check for error JSON in string or object
                        const msg = typeof result === 'string' ? result : (result.error || JSON.stringify(result));
                        if (msg.includes('already installed')) {
                            vscode.window.showWarningMessage(`Library ${libId} is already installed.`);
                        } else {
                            vscode.window.showInformationMessage(`Install result: ${msg}`);
                        }
                    }
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to install lib: ${error.message}`);
                }
                return;
            }

            if (cmdId === 'bbe.viewInstalledLibs') {
                const panel = vscode.window.createWebviewPanel(
                    'bbeInstalledLibs',
                    `Installed Libs: ${item.bot.name}`,
                    vscode.ViewColumn.One,
                    { enableScripts: true }
                );

                try {
                    const libs = await fetchFromApi(`bots/${botId}/libs`, apiKey);
                    panel.webview.html = getInstalledLibsWebviewHtml(item.bot.name, libs);
                    
                    panel.webview.onDidReceiveMessage(message => {
                        if (message.command === 'copied') {
                            vscode.window.showInformationMessage(`Copied to clipboard: ${message.text}`);
                        }
                    });
                } catch (error: any) {
                    panel.webview.html = `<html><body><h1>Error</h1><p>${error.message}</p></body></html>`;
                }
                return;
            }

            if (cmdId === 'bbe.uninstallLib') {
                try {
                    const libs = await fetchFromApi(`bots/${botId}/libs`, apiKey);
                    if (!libs || libs.length === 0) {
                        vscode.window.showInformationMessage('No libraries to uninstall.');
                        return;
                    }

                    const items = libs.map((lib: any) => ({
                        label: lib.name,
                        description: `ID: ${lib.id}`,
                        libId: lib.id
                    }));

                    const selected = await vscode.window.showQuickPick<any>(items, { placeHolder: 'Select a library to UNINSTALL' });
                    if (!selected) { return; }

                    const confirm = await vscode.window.showWarningMessage(
                        `Are you sure you want to uninstall ${selected.label}?`,
                        { modal: true },
                        'Uninstall'
                    );
                    if (confirm !== 'Uninstall') { return; }

                    const result = await deleteFromApi(`bots/${botId}/libs/${selected.libId}`, apiKey);
                    if (result === 'true' || result === true) {
                        vscode.window.showInformationMessage(`Library ${selected.label} uninstalled successfully.`);
                    } else {
                        const msg = typeof result === 'string' ? result : (result.error || JSON.stringify(result));
                        vscode.window.showErrorMessage(`Failed to uninstall: ${msg}`);
                    }
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Error during uninstall: ${error.message}`);
                }
                return;
            }

            if (cmdId === 'bbe.viewErrorLogs') {
                const panel = vscode.window.createWebviewPanel(
                    'bbeErrorLogs',
                    `Error Logs: ${item.bot.name}`,
                    vscode.ViewColumn.One,
                    { enableScripts: true }
                );

                try {
                    const logs = await fetchFromApi(`bots/${botId}/error_logs`, apiKey);
                    panel.webview.html = getErrorLogsWebviewHtml(item.bot.name, logs);

                    panel.webview.onDidReceiveMessage(async (message) => {
                        if (message.command === 'clear') {
                            try {
                                await deleteFromApi(`bots/${botId}/error_logs`, apiKey);
                                vscode.window.showInformationMessage('Error logs cleared.');
                                // Refresh webview with empty list
                                panel.webview.html = getErrorLogsWebviewHtml(item.bot.name, []);
                            } catch (error: any) {
                                vscode.window.showErrorMessage(`Failed to clear logs: ${error.message}`);
                            }
                        }
                    });
                } catch (error: any) {
                    panel.webview.html = `<html><body><h1>Error</h1><p>${error.message}</p></body></html>`;
                }
                return;
            }

            vscode.window.showInformationMessage(`${cmdId} triggered for bot: ${item.bot.name} (Coming Soon)`);
        })
    );

    context.subscriptions.push(loginDisposable, loadBotsDisposable, openCommandDisposable, createCommandDisposable, deleteCommandDisposable, createFolderDisposable, copyFolderIdDisposable, deleteFolderDisposable, refreshTreeDisposable, loadLibrariesDisposable, ...botActions);
}

class BotsTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private isolatedBot: any | undefined;
    private suppressIsolation: boolean = false;

    constructor(private context: vscode.ExtensionContext) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    clearIsolation(): void {
        this.isolatedBot = undefined;
        this.suppressIsolation = true;
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        const apiKey = await this.context.secrets.get('bbe_api_key');
        if (!apiKey) {
            return [new TreeItem("Please login first", vscode.TreeItemCollapsibleState.None)];
        }

        if (!element) {
            if (this.isolatedBot) {
                const item = new BotItem(this.isolatedBot, this.context.extensionUri);
                item.contextValue = 'bot-isolated';
                return [item];
            }
            try {
                const bots = await fetchFromApi('bots', apiKey);
                this.suppressIsolation = false; // Reset after showing full list
                return bots.map((bot: any) => new BotItem(bot, this.context.extensionUri));
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to load bots: ${error.message}`);
                return [];
            }
        } else if (element instanceof BotItem) {
            // Isolate this bot
            if (!this.suppressIsolation && (!this.isolatedBot || this.isolatedBot.id !== element.bot.id)) {
                this.isolatedBot = element.bot;
                this.refresh();
                return []; // Will re-run for root and show only this bot
            }

            try {
                // Fetch All Folders
                const foldersData = await fetchFromApi(`bots/${element.bot.id}/commands_folders`, apiKey);

                // Fetch All Commands
                let allCommands: any[] = [];
                let page = 1;
                while (true) {
                    const commands = await fetchFromApi(`bots/${element.bot.id}/commands`, apiKey, page);
                    if (!commands || commands.length === 0) { break; }
                    allCommands = allCommands.concat(commands);
                    page++;
                }

                const items: TreeItem[] = [];
                const folderMap: Map<number, { id: number, title: string, commands: any[] }> = new Map();
                const topLevelCommands: any[] = [];

                // Initialize all folders from foldersData
                foldersData.forEach((f: any) => {
                    folderMap.set(f.id, { id: f.id, title: f.title, commands: [] });
                });

                // Place commands into folders
                allCommands.forEach((cmd: any) => {
                    const fid = cmd.commands_folder_id;
                    if (fid && folderMap.has(fid)) {
                        folderMap.get(fid)?.commands.push(cmd);
                    } else {
                        topLevelCommands.push(cmd);
                    }
                });

                const sortedFolders = Array.from(folderMap.values()).sort((a, b) => a.title.localeCompare(b.title));
                sortedFolders.forEach(f => items.push(new FolderItem(f.id, f.title, element.bot.id, f.commands)));

                topLevelCommands.forEach(cmd => items.push(new CommandItem(cmd)));

                return items;
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to load commands: ${error.message}`);
                return [];
            }
        } else if (element instanceof FolderItem) {
            return element.commands.map(cmd => new CommandItem(cmd));
        }

        return [];
    }
}

class TreeItem extends vscode.TreeItem { }

class BotItem extends TreeItem {
    constructor(public readonly bot: any, extensionUri: vscode.Uri) {
        super(bot.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.tooltip = `ID: ${bot.id}\nStatus: ${bot.status || 'unknown'}`;
        this.description = bot.status === 'works' ? 'Running' : 'Stopped';
        
        const iconName = bot.status === 'works' ? 'running.svg' : 'stopped.svg';
        this.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icons', iconName);
        
        this.contextValue = 'bot';
    }
}

class FolderItem extends TreeItem {
    constructor(public readonly folderId: number, public readonly title: string, public readonly botId: number, public readonly commands: any[]) {
        super(title, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = vscode.ThemeIcon.Folder;
        this.contextValue = 'folder';
        this.id = `folder-${folderId}`;
    }
}

class CommandItem extends TreeItem {
    constructor(public readonly cmd: any) {
        super(cmd.command, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `ID: ${cmd.id}`;
        this.contextValue = 'command';
        this.command = {
            command: 'bbe.openCommand',
            title: 'Open Command',
            arguments: [cmd]
        };
        this.iconPath = new vscode.ThemeIcon('code');
    }
}

class BBEFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    private commands: Map<string, any> = new Map();

    constructor(private context: vscode.ExtensionContext) { }

    cacheCommand(cmd: any) {
        this.commands.set(`${cmd.bot_id}/${cmd.id}`, cmd);
    }

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => { });
    }

    stat(_uri: vscode.Uri): vscode.FileStat {
        return { type: vscode.FileType.File, ctime: Date.now(), mtime: Date.now(), size: 0 };
    }

    readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(_uri: vscode.Uri): void { }

    readFile(uri: vscode.Uri): Uint8Array {
        const key = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        const cleanKey = key.replace('.js', '');
        const cmd = this.commands.get(cleanKey);
        if (!cmd) { return Buffer.from('// Command not found'); }

        const aliases = cmd.aliases?.map((a: any) => a.command) || [];
        const groups = cmd.commands_group ? [cmd.commands_group.title] : [];

        let header = `/**\n`;
        header += ` * cmd: "${cmd.command || ''}"\n`;
        header += ` * answer: "${cmd.answer || ''}"\n`;
        header += ` * keyboard: "${cmd.keyboard_body || ''}"\n`;
        header += ` * aliases: "${aliases.join(', ')}"\n`;
        header += ` * group: "${groups.join(', ')}"\n`;
        header += ` * help: "${cmd.help || ''}"\n`;
        header += ` * wait_for_answer: "${cmd.need_reply ? 'true' : 'false'}"\n`;
        header += ` * auto_retry_time: "${cmd.auto_retry_time || ''}"\n`;
        header += ` * folder_id: "${cmd.commands_folder_id || ''}"\n`;
        header += ` */\n\n`;

        return Buffer.from(header + (cmd.code || ''));
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean; }): Promise<void> {
        const key = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        const cleanKey = key.replace('.js', '');
        const botId = cleanKey.split('/')[0];
        const commandId = cleanKey.split('/')[1];

        const text = content.toString();
        const apiKey = await this.context.secrets.get('bbe_api_key');
        if (!apiKey) { throw vscode.FileSystemError.NoPermissions('No API Key'); }

        try {
            const parsed = this.parseCommandContent(text);
            const body: any = {
                command: String(parsed.metadata.cmd || ''),
                answer: String(parsed.metadata.answer || ''),
                keyboard_body: String(parsed.metadata.keyboard || ''),
                aliases: Array.isArray(parsed.metadata.aliases) ? parsed.metadata.aliases.join(', ') : String(parsed.metadata.aliases || ''),
                group: String(parsed.metadata.group || ''),
                help: String(parsed.metadata.help || ''),
                need_reply: String(parsed.metadata.wait_for_answer) === 'true',
                commands_folder_id: parsed.metadata.folder_id ? Number(parsed.metadata.folder_id) : undefined,
                bjs_code: String(parsed.code || '')
            };

            if (parsed.metadata.auto_retry_time) {
                body.auto_retry_time = String(parsed.metadata.auto_retry_time);
            }

            if (body.keyboard_body && !body.answer) {
                vscode.window.showWarningMessage('You must add an answer when you have a keyboard.');
            }

            const updatedCmd = await updateCommand(botId, commandId, apiKey, body);

            // Refresh cache with the updated command info from PUT response
            this.cacheCommand(updatedCmd);

            vscode.window.showInformationMessage('Command saved successfully!');

            // Trigger tree provider refresh to show new name or folder
            vscode.commands.executeCommand('bbe.refreshTree');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to save: ${error.message}`);
            throw error;
        }
    }

    private parseCommandContent(text: string): { metadata: any, code: string } {
        const headerMatch = text.match(/\/\*\*([\s\S]*?)\*\//);
        if (!headerMatch) { throw new Error('Invalid format: Missing metadata header'); }

        const header = headerMatch[1];
        const codeText = text.substring(headerMatch[0].length).trim();
        const metadata: any = {};

        const lines = header.split('\n');
        lines.forEach(line => {
            const match = line.match(/\*\s*(\w+):\s*(.*)/);
            if (match) {
                const key = match[1];
                let value = match[2].trim();

                // Strip quotes if present
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.substring(1, value.length - 1);
                }

                // Parse aliases as array if it looks like JSON
                if (key === 'aliases') {
                    if (value.startsWith('[') && value.endsWith(']')) {
                        try { value = JSON.parse(value); } catch (e) { /* ignore */ }
                    }
                }
                metadata[key] = value;
            }
        });

        if (!metadata.cmd) { throw new Error('Invalid format: "cmd" is required in metadata'); }

        return { metadata, code: codeText };
    }

    delete(_uri: vscode.Uri, _options: { recursive: boolean; }): void { }
    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean; }): void { }
}

async function fetchFromApi(endpoint: string, apiKey: string, page?: number): Promise<any> {
    return new Promise((resolve, reject) => {
        let url = `https://api.bots.business/v2/${endpoint}?api_key=${apiKey}`;
        if (page) { url += `&page=${page}`; }

        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else if (res.statusCode === 404) {
                        reject(new Error('Not found'));
                    } else if (json.errors) {
                        reject(new Error(json.errors.join(', ')));
                    } else {
                        reject(new Error(`Server returned status code ${res.statusCode}`));
                    }
                } catch (e) {
                    reject(new Error('Failed to parse response from server'));
                }
            });
        }).on('error', (err) => { reject(err); });
    });
}

async function postToApi(endpoint: string, apiKey: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = `https://api.bots.business/v2/${endpoint}?api_key=${apiKey}`;
        const bodyStr = JSON.stringify(body);

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else if (json.errors) {
                        reject(new Error(json.errors.join(', ')));
                    } else {
                        reject(new Error(`Server error: ${res.statusCode}`));
                    }
                } catch (e) {
                    reject(new Error('Failed to parse response'));
                }
            });
        });

        req.on('error', (err) => { reject(err); });
        req.write(bodyStr);
        req.end();
    });
}

async function deleteFromApi(endpoint: string, apiKey: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = `https://api.bots.business/v2/${endpoint}?api_key=${apiKey}`;

        const options = {
            method: 'DELETE'
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else if (json.errors) {
                        reject(new Error(json.errors.join(', ')));
                    } else {
                        reject(new Error(`Server error: ${res.statusCode}`));
                    }
                } catch (e) {
                    // Sometimes DELETE returns no body or non-JSON
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({});
                    } else {
                        reject(new Error('Failed to parse response'));
                    }
                }
            });
        });

        req.on('error', (err) => { reject(err); });
        req.end();
    });
}

async function updateCommand(botId: string, commandId: string, apiKey: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = `https://api.bots.business/v2/bots/${botId}/commands/${commandId}?api_key=${apiKey}`;
        const bodyStr = JSON.stringify(body);

        const options = {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else if (res.statusCode === 404) {
                        reject(new Error('Not found'));
                    } else if (json.errors) {
                        reject(new Error(json.errors.join(', ')));
                    } else if (json.error) {
                        reject(new Error(json.error));
                    } else {
                        reject(new Error(`Server error: ${res.statusCode}`));
                    }
                } catch (e) {
                    reject(new Error('Failed to parse response'));
                }
            });
        });

        req.on('error', (err) => { reject(err); });
        req.write(bodyStr);
        req.end();
    });
}

function getLibrariesStoreWebviewHtml(libs: any[]): string {
    const libCards = libs.map(lib => `
        <div class="card">
            <div class="thumbnail-container">
                <img src="${lib.img_url || 'https://app.bots.business/assets/images/bb-logo-lib.png'}" 
                     alt="${lib.name}" 
                     class="thumbnail"
                     onerror="this.onerror=null; this.parentElement.innerHTML='<span class=\\'img-err\\'>Failed to load image</span>';">
            </div>
            <div class="content">
                <div class="header">
                    <span class="lib-id">#${lib.id}</span>
                    <h2 class="name">${lib.name}</h2>
                </div>
                <div class="stats">
                    <span class="installations">📥 ${lib.installations_count.toLocaleString()} installs</span>
                </div>
                <p class="description">${lib.description ? lib.description.replace(/\n/g, '<br>') : 'No description available.'}</p>
                <div class="footer">
                    <button class="btn-copy" onclick="copyId('${lib.id}')">Copy ID</button>
                    <span class="date">Updated: ${new Date(lib.updated_at).toLocaleDateString()}</span>
                </div>
            </div>
        </div>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BBE Store</title>
    <style>
        body {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            margin: 0;
            padding: 2rem;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        h1 {
            font-size: 2rem;
            margin-bottom: 2rem;
            color: var(--vscode-textLink-foreground);
            font-weight: 700;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1.5rem;
            width: 100%;
            max-width: 1200px;
        }

        .card {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .thumbnail-container {
            width: 100%;
            height: 160px;
            overflow: hidden;
            background: var(--vscode-input-background);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--vscode-disabledForeground);
            font-size: 0.8rem;
        }

        .thumbnail {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .img-err {
            padding: 20px;
            text-align: center;
        }

        .content {
            padding: 1rem;
            flex-grow: 1;
            display: flex;
            flex-direction: column;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.5rem;
        }

        .lib-id {
            font-size: 0.7rem;
            color: var(--vscode-textLink-foreground);
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 0.2rem 0.4rem;
            border-radius: 4px;
        }

        .name {
            margin: 0;
            font-size: 1.1rem;
            font-weight: 600;
        }

        .stats {
            margin-bottom: 0.8rem;
        }

        .installations {
            font-size: 0.8rem;
            color: var(--vscode-descriptionForeground);
        }

        .description {
            font-size: 0.85rem;
            color: var(--vscode-foreground);
            line-height: 1.4;
            margin-bottom: 1rem;
            flex-grow: 1;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-top: 0.8rem;
            border-top: 1px solid var(--vscode-widget-border);
        }

        .date {
            font-size: 0.7rem;
            color: var(--vscode-descriptionForeground);
        }

        .btn-copy {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 0.4rem 0.8rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.8rem;
        }

        .btn-copy:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        /* Scrollbar */
        ::-webkit-scrollbar {
            width: 10px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
    </style>
</head>

<body>
    <h1>Bots Business Libraries Store</h1>
    <div class="grid">
        ${libCards}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function copyId(id) {
            navigator.clipboard.writeText(id).then(() => {
                vscode.postMessage({ command: 'copied', text: id });
                const btn = event.target;
                const originalText = btn.innerText;
                const originalBg = btn.style.backgroundColor;
                btn.innerText = 'Copied!';
                btn.style.backgroundColor = 'var(--vscode-button-secondaryBackground, #4ade80)';
                setTimeout(() => {
                    btn.innerText = originalText;
                    btn.style.backgroundColor = originalBg;
                }, 2000);
            });
        }
    </script>
</body>
</html>
    `;
}

function getInstalledLibsWebviewHtml(botName: string, libs: any[]): string {
    const listItems = libs.map(lib => `
        <div class="list-item">
            <div class="lib-info">
                <span class="lib-name">${lib.name}</span>
                <span class="lib-id">ID: ${lib.id}</span>
            </div>
            <button class="btn-copy" onclick="copyId('${lib.id}')">Copy ID</button>
        </div>
    `).join('');

    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            padding: 2rem;
        }
        h1 { color: var(--vscode-textLink-foreground); font-size: 1.5rem; margin-bottom: 2rem; }
        .list { display: flex; flex-direction: column; gap: 0.5rem; }
        .list-item {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            padding: 1rem;
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .lib-info { display: flex; flex-direction: column; gap: 0.2rem; }
        .lib-name { font-weight: 600; font-size: 1rem; }
        .lib-id { font-size: 0.8rem; color: var(--vscode-descriptionForeground); }
        .btn-copy {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 0.4rem 0.8rem;
            border-radius: 4px;
            cursor: pointer;
        }
        .btn-copy:hover { background: var(--vscode-button-hoverBackground); }
    </style>
</head>
<body>
    <h1>Libraries installed on ${botName}</h1>
    <div class="list">
        ${libs.length > 0 ? listItems : '<p>No libraries installed.</p>'}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function copyId(id) {
            navigator.clipboard.writeText(id).then(() => {
                vscode.postMessage({ command: 'copied', text: id });
            });
        }
    </script>
</body>
</html>`;
}

function getErrorLogsWebviewHtml(botName: string, logs: any[]): string {
    const errorItems = (Array.isArray(logs) ? logs : []).map(log => `
        <div class="error-card">
            <div class="error-header">
                <span class="error-id">ID: ${log.id}</span>
                <span class="error-date">${new Date(log.created_at).toLocaleString()}</span>
            </div>
            <h2 class="error-title">${log.title}</h2>
            ${log.scenario ? `<div class="error-scenario">Command: <code>${log.scenario.bot_command ? log.scenario.bot_command.command : 'Unknown'}</code></div>` : ''}
            <div class="error-stack">
                <pre>${log.stack_trace || 'No stack trace available'}</pre>
            </div>
        </div>
    `).join('');

    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            padding: 2rem;
        }
        h1 { color: var(--vscode-textLink-foreground); font-size: 1.5rem; margin: 0; }
        .header-container {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
        }
        .btn-clear {
            background-color: var(--vscode-button-secondaryBackground, #f43f5e);
            color: var(--vscode-button-secondaryForeground, white);
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85rem;
            font-weight: 600;
        }
        .btn-clear:hover {
            filter: brightness(1.1);
        }
        .grid { display: flex; flex-direction: column; gap: 1.5rem; }
        .error-card {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 1.5rem;
            display: flex;
            flex-direction: column;
            gap: 0.8rem;
        }
        .error-header {
            display: flex;
            justify-content: space-between;
            font-size: 0.75rem;
            color: var(--vscode-descriptionForeground);
        }
        .error-title {
            margin: 0;
            font-size: 1.1rem;
            color: var(--vscode-errorForeground);
            font-weight: 600;
        }
        .error-scenario {
            font-size: 0.85rem;
            padding: 0.4rem;
            background: var(--vscode-input-background);
            border-radius: 4px;
        }
        .error-stack {
            background: var(--vscode-input-background);
            padding: 1rem;
            border-radius: 4px;
            overflow-x: auto;
        }
        pre { margin: 0; font-family: var(--vscode-editor-font-family); font-size: 0.85rem; line-height: 1.4; }
        code { color: var(--vscode-textLink-foreground); }
    </style>
</head>
<body>
    <div class="header-container">
        <h1>Error Logs: ${botName}</h1>
        ${logs.length > 0 ? '<button class="btn-clear" onclick="clearLogs()">Clear All Logs</button>' : ''}
    </div>
    <div class="grid">
        ${logs.length > 0 ? errorItems : '<p>No error logs found for this bot.</p>'}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function clearLogs() {
            vscode.postMessage({ command: 'clear' });
        }
    </script>
</body>
</html>`;
}

export function deactivate() { }
