const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;

// Start the Express server
function startServer() {
    return new Promise((resolve) => {
        const serverPath = path.join(__dirname, 'server.js');

        serverProcess = fork(serverPath, [], {
            cwd: __dirname,
            env: { ...process.env, PORT: '3001' },
            silent: true
        });

        serverProcess.stdout.on('data', (data) => {
            console.log(`Server: ${data}`);
        });

        serverProcess.stderr.on('data', (data) => {
            console.error(`Server Error: ${data}`);
        });

        // Give server time to start
        setTimeout(resolve, 3000);
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        title: 'Spam Scanner'
    });

    // Load the app
    mainWindow.loadURL('http://localhost:3001');

    // Handle navigation - open Google OAuth in system browser
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.includes('accounts.google.com') || url.includes('google.com/o/oauth2')) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    // Also handle link clicks
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('google.com')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    console.log('Starting server...');
    await startServer();
    console.log('Creating window...');
    createWindow();
});

app.on('window-all-closed', () => {
    // Kill server process
    if (serverProcess) {
        serverProcess.kill();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('quit', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
});
