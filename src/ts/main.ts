import { app, BrowserWindow, globalShortcut, ipcMain, Menu, MenuItem, Tray, screen, ipcRenderer } from "electron";
import { autoUpdater } from "electron-updater";
import { join } from "path";
import { FilePathExecutionArgumentValidator } from "./execution-argument-validators/file-path-execution-argument-validator";
import { ExecutionService } from "./execution-service";
import { FilePathExecutor } from "./executors/file-path-executor";
import { Injector } from "./injector";
import { InputValidationService } from "./input-validation-service";
import { IpcChannels } from "./ipc-channels";
import * as isInDevelopment from "electron-is-dev";
import { platform } from "os";
import { WindowHelpers } from "./helpers/winow-helpers";
import { ExecutionArgumentValidatorExecutorCombinationManager } from "./execution-argument-validator-executor-combination-manager";
import { InputValidatorSearcherCombinationManager } from "./input-validator-searcher-combination-manager";
import { UeliHelpers } from "./helpers/ueli-helpers";
import { defaultConfig } from "./default-config";
import { ConfigFileRepository } from "./config-file-repository";
import { CountManager } from "./count-manager";
import { CountFileRepository } from "./count-file-repository";
import { ProductionIpcEmitter } from "./production-ipc-emitter";
import { AutoCompletionService } from "./auto-completion/autocompletion-service";
import { FilePathAutoCompletionValidator } from "./auto-completion/file-path-autocompletion-validator";
import { ElectronStoreAppConfigRepository } from "./app-config/electorn-store-app-config-repository";
import { AppConfig } from "./app-config/app-config";
import { ConfigOptions } from "./config-options";

let mainWindow: BrowserWindow;
let trayIcon: Tray;

const delayWhenHidingCommandlineOutputInMs = 25;
const filePathExecutor = new FilePathExecutor();
const appConfigRepository = new ElectronStoreAppConfigRepository();
const userConfigRepository = new ConfigFileRepository(defaultConfig, appConfigRepository.getAppConfig().userSettingsFilePath);
let config = userConfigRepository.getConfig();
let inputValidationService = new InputValidationService(config, new InputValidatorSearcherCombinationManager(config).getCombinations());
const ipcEmitter = new ProductionIpcEmitter();
let executionService = new ExecutionService(
    new ExecutionArgumentValidatorExecutorCombinationManager(config).getCombinations(),
    new CountManager(new CountFileRepository(UeliHelpers.countFilePath)),
    config,
    ipcEmitter);

const otherInstanceIsAlreadyRunning = app.makeSingleInstance(() => { /* do nothing */ });

if (otherInstanceIsAlreadyRunning) {
    app.quit();
} else {
    startApp();
}

function startApp(): void {
    app.on("ready", createMainWindow);
    app.on("window-all-closed", quitApp);
}

function createMainWindow(): void {
    hideAppInDock();

    mainWindow = new BrowserWindow({
        autoHideMenuBar: true,
        backgroundColor: "#00000000",
        center: true,
        frame: false,
        height: WindowHelpers.calculateMaxWindowHeight(config.userInputHeight, config.maxSearchResultCount, config.searchResultHeight),
        resizable: false,
        show: false,
        skipTaskbar: true,
        width: config.windowWidth,
    });

    mainWindow.loadURL(`file://${__dirname}/../main.html`);
    mainWindow.setSize(config.windowWidth, config.userInputHeight);

    mainWindow.on("close", quitApp);
    mainWindow.on("blur", hideMainWindow);

    if (config.showTrayIcon) {
        createTrayIcon();
    }

    registerGlobalHotKey();

    if (!isInDevelopment) {
        checkForUpdates();
        setAutostartSettings();
    }
}

function createTrayIcon(): void {
    if (trayIcon !== undefined && !trayIcon.isDestroyed()) {
        trayIcon.destroy();
    }

    trayIcon = new Tray(Injector.getTrayIconPath(platform(), join(__dirname, "../")));
    trayIcon.setToolTip(UeliHelpers.productName);
    trayIcon.setContextMenu(Menu.buildFromTemplate([
        { click: showWindow, label: "Show" },
        { click: quitApp, label: "Exit" },
    ]));
}

function registerGlobalHotKey(): void {
    globalShortcut.register(config.hotKey, toggleWindow);
}

function unregisterAllGlobalShortcuts(): void {
    globalShortcut.unregisterAll();
}

function hideAppInDock(): void {
    if (platform() === "darwin") {
        app.dock.hide();
    }
}

function checkForUpdates(): void {
    autoUpdater.autoDownload = false;
    autoUpdater.checkForUpdates();
}

function downloadUpdate(): void {
    autoUpdater.downloadUpdate();
}

autoUpdater.on("update-available", (): void => {
    addUpdateStatusToTrayIcon("Update is available");
    ipcMain.emit(IpcChannels.ueliUpdateWasFound);
});

autoUpdater.on("update-not-available", (): void => {
    addUpdateStatusToTrayIcon(`${UeliHelpers.productName} is up to date`);
});

autoUpdater.on("error", (): void => {
    addUpdateStatusToTrayIcon("Update check failed");
});

autoUpdater.on("update-downloaded", (): void => {
    autoUpdater.quitAndInstall();
});

function addUpdateStatusToTrayIcon(label: string, clickHandler?: any): void {
    const updateItem = clickHandler === undefined
        ? { label }
        : { label, click: clickHandler } as MenuItem;

    if (trayIcon !== undefined) {
        trayIcon.setContextMenu(Menu.buildFromTemplate([
            updateItem,
            { click: toggleWindow, label: "Show/Hide" },
            { click: quitApp, label: "Exit" },
        ]));
    }
}

function setAutostartSettings() {
    app.setLoginItemSettings({
        args: [],
        openAtLogin: config.autoStartApp,
        path: process.execPath,
    });
}

function toggleWindow(): void {
    if (mainWindow.isVisible()) {
        hideMainWindow();
    } else {
        showWindow();
    }
}

function updateWindowSize(searchResultCount: number): void {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        const newWindowHeight = WindowHelpers.calculateWindowHeight(searchResultCount, config.maxSearchResultCount, config.userInputHeight, config.searchResultHeight);
        mainWindow.setSize(config.windowWidth, newWindowHeight);
    }
}

function showWindow() {
    if (!config.alwaysShowOnPrimaryDisplay) {
        const mousePosition = screen.getCursorScreenPoint();
        const nearestDisplay = screen.getDisplayNearestPoint(mousePosition);
        mainWindow.setBounds(nearestDisplay.bounds);
    }
    resetWindowToDefaultSizeAndPosition();
    mainWindow.show();
}

function hideMainWindow(): void {
    mainWindow.webContents.send(IpcChannels.resetCommandlineOutput);
    mainWindow.webContents.send(IpcChannels.resetUserInput);
    mainWindow.webContents.send(IpcChannels.hideSettings);

    setTimeout(() => {
        if (mainWindow !== null && mainWindow !== undefined) {
            updateWindowSize(0);
            mainWindow.hide();
        }
    }, delayWhenHidingCommandlineOutputInMs); // to give user input and command line output time to reset properly delay hiding window
}

function reloadApp(): void {
    config = new ConfigFileRepository(defaultConfig, appConfigRepository.getAppConfig().userSettingsFilePath).getConfig();
    inputValidationService = new InputValidationService(config, new InputValidatorSearcherCombinationManager(config).getCombinations());
    executionService = new ExecutionService(
        new ExecutionArgumentValidatorExecutorCombinationManager(config).getCombinations(),
        new CountManager(new CountFileRepository(UeliHelpers.countFilePath)),
        config,
        ipcEmitter);

    mainWindow.reload();
    resetWindowToDefaultSizeAndPosition();
    unregisterAllGlobalShortcuts();
    registerGlobalHotKey();

    if (config.showTrayIcon) {
        createTrayIcon();
    } else {
        destroyTrayIcon();
    }
}

function destroyTrayIcon(): void {
    if (trayIcon !== undefined) {
        trayIcon.destroy();
    }
}

function resetWindowToDefaultSizeAndPosition(): void {
    mainWindow.setSize(config.windowWidth, WindowHelpers.calculateMaxWindowHeight(config.userInputHeight, config.maxSearchResultCount, config.searchResultHeight));
    mainWindow.center();
    updateWindowSize(0);
}

function quitApp(): void {
    destroyTrayIcon();
    unregisterAllGlobalShortcuts();
    app.quit();
}

ipcMain.on(IpcChannels.hideWindow, hideMainWindow);
ipcMain.on(IpcChannels.ueliReload, reloadApp);
ipcMain.on(IpcChannels.ueliExit, quitApp);
ipcMain.on(IpcChannels.ueliUpdateUeli, downloadUpdate);

ipcMain.on(IpcChannels.getSearch, (event: any, arg: string): void => {
    const userInput = arg;
    const result = inputValidationService.getSearchResult(userInput);
    updateWindowSize(result.length);
    event.sender.send(IpcChannels.getSearchResponse, result);
});

ipcMain.on(IpcChannels.execute, (event: any, arg: string): void => {
    const executionArgument = arg;
    executionService.execute(executionArgument);
});

ipcMain.on(IpcChannels.openFileLocation, (event: any, arg: string): void => {
    const filePath = arg;
    if (new FilePathExecutionArgumentValidator().isValidForExecution(filePath)) {
        filePathExecutor.openFileLocation(filePath);
    }
});

ipcMain.on(IpcChannels.autoComplete, (event: any, executionArgument: string): void => {
    const autoCompletionResult = new AutoCompletionService([
        new FilePathAutoCompletionValidator(),
    ]).getAutocompletionResult(executionArgument);

    if (autoCompletionResult !== undefined) {
        event.sender.send(IpcChannels.autoCompleteResponse, autoCompletionResult);
    }
});

ipcMain.on(IpcChannels.commandLineExecution, (arg: string): void => {
    mainWindow.webContents.send(IpcChannels.commandLineOutput, arg);
    updateWindowSize(config.maxSearchResultCount);
});

ipcMain.on(IpcChannels.resetUserInput, (): void => {
    mainWindow.webContents.send(IpcChannels.resetUserInput);
});

ipcMain.on(IpcChannels.ueliCheckForUpdates, (): void => {
    autoUpdater.checkForUpdates();
});

ipcMain.on(IpcChannels.showSettings, (): void => {
    updateWindowSize(config.maxSearchResultCount);
});

ipcMain.on(IpcChannels.hideSettings, (): void => {
    updateWindowSize(0);
});

ipcMain.on(IpcChannels.updateAppConfig, (event: Electron.Event, updatedAppConfig: AppConfig) => {
    appConfigRepository.setAppConfig(updatedAppConfig);
});

ipcMain.on(IpcChannels.updateUserConfig, (event: Electron.Event, updatedUserConfig: ConfigOptions) => {
    config = updatedUserConfig;
    userConfigRepository.saveConfig(updatedUserConfig);
});
