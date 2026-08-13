import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
} from 'electron';

import { AgentWorkerHost } from './agent-worker-host';

import {
  APP_INFO_CHANNEL,
  RENDERER_READY_CHANNEL,
  appInfoSchema,
} from '../shared/contracts';
import {
  isPermittedRendererUrl,
  secureWebPreferences,
} from './security';
import {
  PACKAGED_CONTENT_SECURITY_POLICY,
  PACKAGED_RENDERER_URL,
  RENDERER_SCHEME,
  resolveRendererAssetPath,
} from './renderer-protocol';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let agentWorkerHost: AgentWorkerHost | null = null;
const isPackagedSmokeTest = process.argv.includes('--smoke-test');
let rendererSmokeReady = false;
let agentSmokeReady = false;

function completePackagedSmokeTest(): void {
  if (isPackagedSmokeTest && rendererSmokeReady && agentSmokeReady) {
    agentWorkerHost?.close();
    app.exit(0);
  }
}

function getAgentRuntimePaths() {
  const resourcesRoot = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');
  return {
    binaryPath: app.isPackaged
      ? path.join(resourcesRoot, 'claude.exe')
      : path.join(
        app.getAppPath(),
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-win32-x64',
        'claude.exe',
      ),
    runtimeManifestPath: path.join(resourcesRoot, 'agent-runtime-manifest.json'),
    capabilityBundlePath: path.join(resourcesRoot, 'capability-bundle'),
    sandboxLauncherPath: app.isPackaged
      ? path.join(resourcesRoot, 'MentalLegos.SandboxLauncher.exe')
      : path.join(
        resourcesRoot,
        'windows-sandbox',
        'MentalLegos.SandboxLauncher.exe',
      ),
    credentialVaultPath: app.isPackaged
      ? path.join(resourcesRoot, 'MentalLegos.CredentialVault.exe')
      : path.join(
        resourcesRoot,
        'windows-sandbox',
        'MentalLegos.CredentialVault.exe',
      ),
  };
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
    },
  },
]);

function registerPackagedRendererProtocol(): void {
  const rendererRoot = path.join(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}`,
  );

  protocol.handle(RENDERER_SCHEME, async (request) => {
    const assetPath = resolveRendererAssetPath(request.url, rendererRoot);
    if (!assetPath) {
      return new Response('Not found', { status: 404 });
    }

    const fileResponse = await net.fetch(pathToFileURL(assetPath).toString());
    if (path.extname(assetPath).toLowerCase() !== '.html') {
      return fileResponse;
    }

    const headers = new Headers(fileResponse.headers);
    headers.set(
      'Content-Security-Policy',
      PACKAGED_CONTENT_SECURITY_POLICY,
    );

    return new Response(fileResponse.body, {
      status: fileResponse.status,
      statusText: fileResponse.statusText,
      headers,
    });
  });
}

function assertTrustedIpcSender(senderId: number, senderUrl: string): void {
  if (!mainWindow || senderId !== mainWindow.webContents.id) {
    throw new Error('IPC request rejected: untrusted sender.');
  }

  if (!isPermittedRendererUrl(senderUrl, MAIN_WINDOW_VITE_DEV_SERVER_URL)) {
    throw new Error('IPC request rejected: untrusted renderer URL.');
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(APP_INFO_CHANNEL, (event) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) {
      throw new Error('IPC request rejected: missing sender frame.');
    }

    assertTrustedIpcSender(event.sender.id, senderUrl);

    return appInfoSchema.parse({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      phase: 'phase-0',
    });
  });

  ipcMain.handle(RENDERER_READY_CHANNEL, (event) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) {
      throw new Error('IPC request rejected: missing sender frame.');
    }

    assertTrustedIpcSender(event.sender.id, senderUrl);
    if (isPackagedSmokeTest) {
      rendererSmokeReady = true;
      completePackagedSmokeTest();
    }
  });
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f1e8',
    webPreferences: {
      ...secureWebPreferences,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isPermittedRendererUrl(url, MAIN_WINDOW_VITE_DEV_SERVER_URL)) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!isPackagedSmokeTest) {
      mainWindow?.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadURL(PACKAGED_RENDERER_URL);
  }
}

app.whenReady().then(async () => {
  registerPackagedRendererProtocol();
  registerIpcHandlers();
  await createMainWindow();

  agentWorkerHost = new AgentWorkerHost(
    path.join(__dirname, 'worker.mjs'),
    isPackagedSmokeTest,
  );
  void agentWorkerHost.diagnose(getAgentRuntimePaths()).then(() => {
    agentSmokeReady = true;
    completePackagedSmokeTest();
  }).catch((reason: unknown) => {
    console.error('Agent runtime diagnostic failed.', reason);
    if (isPackagedSmokeTest) app.exit(1);
  });

  if (isPackagedSmokeTest) {
    setTimeout(() => {
      console.error('Packaged smoke test timed out before renderer readiness.');
      app.exit(1);
    }, 8_000).unref();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}).catch((error: unknown) => {
  console.error('Failed to initialize Mental LEGOs.', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  agentWorkerHost?.close();
  app.quit();
});
