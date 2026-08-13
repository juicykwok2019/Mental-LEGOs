import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
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
import { AsrWorkerHost } from './asr-worker-host';

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
let asrWorkerHost: AsrWorkerHost | null = null;
const isPackagedSmokeTest = process.argv.includes('--smoke-test');
const isAgentE2eSmokeTest = process.argv.includes('--agent-e2e-smoke');
const agentE2eBashRuntimeDirectory = process.argv
  .find((argument) => argument.startsWith('--agent-e2e-bash-runtime='))
  ?.slice('--agent-e2e-bash-runtime='.length);
const asrSmokeModelDirectory = process.argv
  .find((argument) => argument.startsWith('--asr-smoke-model='))
  ?.slice('--asr-smoke-model='.length);
const asrSmokeAudioPath = process.argv
  .find((argument) => argument.startsWith('--asr-smoke-audio='))
  ?.slice('--asr-smoke-audio='.length);
const isAsrTranscriptionSmokeTest = Boolean(
  asrSmokeModelDirectory && asrSmokeAudioPath,
);
let rendererSmokeReady = false;
let agentSmokeReady = false;
let asrSmokeReady = false;

function completePackagedSmokeTest(): void {
  if (isPackagedSmokeTest && rendererSmokeReady && agentSmokeReady && asrSmokeReady) {
    agentWorkerHost?.close();
    asrWorkerHost?.close();
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
    bashProxyPath: app.isPackaged
      ? path.join(resourcesRoot, 'MentalLegos.BashProxy.exe')
      : path.join(
        resourcesRoot,
        'windows-sandbox',
        'MentalLegos.BashProxy.exe',
      ),
    providerProxyPath: app.isPackaged
      ? path.join(resourcesRoot, 'MentalLegos.ProviderProxy.exe')
      : path.join(
        resourcesRoot,
        'windows-sandbox',
        'MentalLegos.ProviderProxy.exe',
      ),
  };
}

async function runPackagedAgentE2eSmoke(): Promise<void> {
  if (!agentWorkerHost || !agentE2eBashRuntimeDirectory) {
    throw new Error('Packaged Agent E2E requires its verified Bash runtime path.');
  }
  const temporaryRoot = path.resolve(app.getPath('temp'));
  const sessionsRoot = path.join(
    temporaryRoot,
    `mental-legos-packaged-agent-e2e-${randomUUID()}`,
  );
  const relative = path.relative(temporaryRoot, sessionsRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Packaged Agent E2E temporary root is unsafe.');
  }
  const workspaceSessionId = `packaged-${randomUUID()}`;
  await mkdir(sessionsRoot, { recursive: false });
  const runtimePaths = getAgentRuntimePaths();
  const request = {
    prompt: 'Run the packaged synthetic multi-tool validation.',
    workspace: {
      sessionsRoot,
      sessionId: workspaceSessionId,
      create: true,
    },
    paths: runtimePaths,
    provider: {
      baseUrl: 'https://provider.invalid',
      apiKey: 'synthetic-packaged-host-only-key',
      model: 'claude-sonnet-4-6',
    },
    limits: { maxTurns: 8 },
    bashRuntime: {
      manifestPath: path.join(
        app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
        'bash-runtime',
        'windows-x64-wasmer-bash.json',
      ),
      runtimeDirectory: path.resolve(agentE2eBashRuntimeDirectory),
      cacheDirectory: path.join(sessionsRoot, '.wasmer-cache'),
    },
    governanceDatabasePath: path.join(sessionsRoot, 'governance.sqlite'),
  };
  try {
    const first = await agentWorkerHost.run(request);
    if (!JSON.stringify(first.messages).includes('packaged-agent-first-run-ok')) {
      throw new Error('Packaged Agent first-run response was not observed.');
    }
    const workspaceRoot = path.join(sessionsRoot, workspaceSessionId);
    const [adaptedScript, originalScript, skillResultSource] = await Promise.all([
      readFile(path.join(workspaceRoot, 'scratch', 'packaged-adapted.py'), 'utf8'),
      readFile(path.join(
        workspaceRoot,
        '.claude',
        'skills',
        'lego-extraction',
        'scripts',
        'validate-candidate.py',
      ), 'utf8'),
      readFile(path.join(workspaceRoot, 'output', 'packaged-skill-result.json'), 'utf8'),
    ]);
    const skillResult = JSON.parse(skillResultSource) as { valid?: unknown };
    if (
      !adaptedScript.includes('# packaged E2E adaptation')
      || originalScript.includes('# packaged E2E adaptation')
      || skillResult.valid !== true
    ) {
      throw new Error('Packaged Agent did not preserve the Skill copy-edit-execute boundary.');
    }
    const previewId = /preview_id=([a-f0-9-]{36})/u
      .exec(JSON.stringify(first.messages))?.[1];
    if (!previewId) throw new Error('Packaged Agent did not return its commit preview.');
    const confirmationToken = await agentWorkerHost.issueCommitToken(
      request.governanceDatabasePath,
      previewId,
    );
    const resumed = await agentWorkerHost.run({
      ...request,
      prompt: [
        'The host confirmed the exact packaged E2E preview.',
        `PACKAGED_E2E_COMMIT preview_id=${previewId}`,
        `confirmation_token=${confirmationToken}`,
      ].join(' '),
      workspace: { ...request.workspace, create: false },
      resume: first.agentSessionId,
    });
    if (
      resumed.agentSessionId !== first.agentSessionId
      || !JSON.stringify(resumed.messages).includes('packaged-agent-resume-ok')
    ) {
      throw new Error('Packaged Agent resume response was not observed.');
    }
  } finally {
    await rm(sessionsRoot, { recursive: true, force: true });
  }
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
    isAgentE2eSmokeTest,
  );
  void agentWorkerHost.diagnose(getAgentRuntimePaths()).then(async () => {
    if (isAgentE2eSmokeTest) await runPackagedAgentE2eSmoke();
    agentSmokeReady = true;
    completePackagedSmokeTest();
  }).catch((reason: unknown) => {
    console.error('Agent runtime diagnostic failed.', reason);
    if (isPackagedSmokeTest) app.exit(1);
  });

  asrWorkerHost = new AsrWorkerHost(
    path.join(__dirname, 'asr-worker.mjs'),
    isPackagedSmokeTest,
  );
  void asrWorkerHost.diagnose().then(async () => {
    if (asrSmokeModelDirectory && asrSmokeAudioPath) {
      const transcription = await asrWorkerHost?.transcribe({
        modelDirectory: asrSmokeModelDirectory,
        audioPath: asrSmokeAudioPath,
      });
      if (!transcription?.text.trim()) {
        throw new Error('The packaged local speech probe returned an empty transcript.');
      }
    }
    asrSmokeReady = true;
    completePackagedSmokeTest();
  }).catch((reason: unknown) => {
    console.error('Local speech runtime diagnostic failed.', reason);
    if (isPackagedSmokeTest) app.exit(1);
  });

  if (isPackagedSmokeTest) {
    setTimeout(() => {
      console.error('Packaged smoke test timed out before renderer readiness.');
      app.exit(1);
    }, isAgentE2eSmokeTest ? 300_000 : isAsrTranscriptionSmokeTest ? 30_000 : 8_000).unref();
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
  asrWorkerHost?.close();
  app.quit();
});
