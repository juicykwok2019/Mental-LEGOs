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
import { BashRuntimeManager } from '../bash/runtime-manager';
import { loadBashRuntimeManifest } from '../bash/runtime-manifest';
import { CredentialVault } from './credential-vault';
import { ProviderCertificationService } from './provider-certification';
import { ProviderConfigurationService } from './provider-configuration';
import { ProviderSettingsStore } from './provider-settings-store';
import { TrainingSessionService } from './training-session';
import { loadVaultDataKeyProvider } from '../data/data-key';
import { ProductDatabase } from '../data/product-database';

import {
  APP_INFO_CHANNEL,
  AGENT_READINESS_GET_CHANNEL,
  BASH_RUNTIME_INSTALL_CHANNEL,
  PROVIDER_SETUP_CLEAR_CHANNEL,
  PROVIDER_CERTIFICATION_CANCEL_CHANNEL,
  PROVIDER_CERTIFICATION_CONFIRM_CHANNEL,
  PROVIDER_CERTIFICATION_START_CHANNEL,
  PROVIDER_SETUP_GET_CHANNEL,
  PROVIDER_SETUP_SAVE_CHANNEL,
  RENDERER_READY_CHANNEL,
  TRAINING_CLOSE_FIRST_CHANNEL,
  TRAINING_CONFIRM_CHANNEL,
  TRAINING_DIAGNOSE_CHANNEL,
  TRAINING_DUE_CHANNEL,
  TRAINING_EXTRACT_CHANNEL,
  TRAINING_HINT_CHANNEL,
  TRAINING_SECOND_CHANNEL,
  TRAINING_START_CHANNEL,
  appInfoSchema,
  agentReadinessStateSchema,
  providerSetupInputSchema,
  providerSetupStateSchema,
  providerCertificationDraftSchema,
  providerCertificationIdSchema,
  providerCertificationResultSchema,
  trainingCloseFirstInputSchema,
  trainingConfirmInputSchema,
  trainingDueListSchema,
  trainingHintLevelSchema,
  trainingSecondInputSchema,
  trainingStartInputSchema,
  trainingTurnStateSchema,
} from '../shared/contracts';
import { providerRegistry } from '../shared/providers';
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
let credentialVault: CredentialVault | null = null;
let providerConfiguration: ProviderConfigurationService | null = null;
let bashRuntimeManager: BashRuntimeManager | null = null;
let providerCertification: ProviderCertificationService | null = null;
let productDatabase: ProductDatabase | null = null;
let trainingService: TrainingSessionService | null = null;
let trainingServicePromise: Promise<TrainingSessionService> | null = null;
let agentRuntimeDiagnostic: 'checking' | 'ready' | 'error' = 'checking';
let agentRuntimeDiagnosticDetail: string | null = null;
let bashInstallPromise: Promise<unknown> | null = null;
let quitCleanupStarted = false;
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

function getBashRuntimeManifestPath(): string {
  const resourcesRoot = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');
  return path.join(
    resourcesRoot,
    'bash-runtime',
    'windows-x64-wasmer-bash.json',
  );
}

async function getAgentReadinessState() {
  if (!bashRuntimeManager) throw new Error('Bash runtime manager is unavailable.');
  const manifest = await loadBashRuntimeManifest(getBashRuntimeManifestPath());
  const status = await bashRuntimeManager.inspect(manifest, false);
  return agentReadinessStateSchema.parse({
    agentRuntime: agentRuntimeDiagnostic,
    bashRuntime: status.state === 'installed' ? 'ready' : status.state,
    bashRuntimeName: manifest.displayName,
    downloadBytes: manifest.runner.archive.bytes
      + manifest.packages.bash.artifact.bytes
      + manifest.packages.coreutils.artifact.bytes
      + manifest.packages.python.artifact.bytes,
    detail: status.state === 'invalid'
      ? `Managed runtime verification failed: ${status.reason}`
      : agentRuntimeDiagnosticDetail,
  });
}

async function getTrainingService(): Promise<TrainingSessionService> {
  if (trainingService) return trainingService;
  if (!trainingServicePromise) {
    trainingServicePromise = (async () => {
      if (!agentWorkerHost || !providerConfiguration || !bashRuntimeManager) {
        throw new Error('The training runtime is not initialized yet.');
      }
      const runtimePaths = getAgentRuntimePaths();
      const databaseDirectory = path.join(app.getPath('userData'), 'database');
      const keyProvider = await loadVaultDataKeyProvider({
        vaultExecutablePath: runtimePaths.credentialVaultPath,
        databaseDirectory,
      });
      productDatabase = new ProductDatabase(
        path.join(databaseDirectory, 'product.db'),
        keyProvider,
      );
      const agent = agentWorkerHost;
      const provider = providerConfiguration;
      const bashManager = bashRuntimeManager;
      trainingService = new TrainingSessionService({
        agent,
        provider,
        runtime: {
          paths: () => runtimePaths,
          manifestPath: getBashRuntimeManifestPath,
          resolveBashRuntimeDirectory: async () => {
            const manifest = await loadBashRuntimeManifest(getBashRuntimeManifestPath());
            const status = await bashManager.inspect(manifest, true);
            if (status.state !== 'installed') {
              throw new Error('先在设置中下载并校验离线 Bash 运行时，再开始训练。');
            }
            return status.runtimeDirectory;
          },
        },
        product: productDatabase,
        sessionsRoot: path.join(app.getPath('userData'), 'training-sessions'),
      });
      return trainingService;
    })().catch((reason: unknown) => {
      trainingServicePromise = null;
      throw reason;
    });
  }
  return trainingServicePromise;
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
      protocol: 'anthropic-messages' as const,
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

  ipcMain.handle(PROVIDER_SETUP_GET_CHANNEL, (event) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
    assertTrustedIpcSender(event.sender.id, senderUrl);
    if (!providerConfiguration) throw new Error('Provider configuration is unavailable.');
    return providerSetupStateSchema.parse({
      providers: providerRegistry,
      configured: providerConfiguration.getSummary(),
    });
  });

  ipcMain.handle(PROVIDER_SETUP_SAVE_CHANNEL, async (event, value: unknown) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
    assertTrustedIpcSender(event.sender.id, senderUrl);
    if (!providerConfiguration) throw new Error('Provider configuration is unavailable.');
    const configured = await providerConfiguration.save(
      providerSetupInputSchema.parse(value),
    );
    return providerSetupStateSchema.parse({ providers: providerRegistry, configured });
  });

  ipcMain.handle(PROVIDER_SETUP_CLEAR_CHANNEL, async (event) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
    assertTrustedIpcSender(event.sender.id, senderUrl);
    if (!providerConfiguration) throw new Error('Provider configuration is unavailable.');
    await providerConfiguration.clear();
    return providerSetupStateSchema.parse({
      providers: providerRegistry,
      configured: null,
    });
  });

  ipcMain.handle(AGENT_READINESS_GET_CHANNEL, async (event) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
    assertTrustedIpcSender(event.sender.id, senderUrl);
    return getAgentReadinessState();
  });

  ipcMain.handle(BASH_RUNTIME_INSTALL_CHANNEL, async (event) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
    assertTrustedIpcSender(event.sender.id, senderUrl);
    if (!bashRuntimeManager) throw new Error('Bash runtime manager is unavailable.');
    if (!bashInstallPromise) {
      bashInstallPromise = (async () => {
        const manifest = await loadBashRuntimeManifest(getBashRuntimeManifestPath());
        const status = await bashRuntimeManager?.inspect(manifest, true);
        if (status?.state !== 'installed') await bashRuntimeManager?.install(manifest);
      })().finally(() => { bashInstallPromise = null; });
    }
    await bashInstallPromise;
    return getAgentReadinessState();
  });

  ipcMain.handle(PROVIDER_CERTIFICATION_START_CHANNEL, async (event) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
    assertTrustedIpcSender(event.sender.id, senderUrl);
    if (!providerCertification) throw new Error('Provider certification is unavailable.');
    return providerCertificationDraftSchema.parse(await providerCertification.start());
  });

  ipcMain.handle(
    PROVIDER_CERTIFICATION_CONFIRM_CHANNEL,
    async (event, value: unknown) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
      assertTrustedIpcSender(event.sender.id, senderUrl);
      if (!providerCertification) throw new Error('Provider certification is unavailable.');
      const id = providerCertificationIdSchema.parse(value);
      return providerCertificationResultSchema.parse(
        await providerCertification.confirm(id),
      );
    },
  );

  ipcMain.handle(
    PROVIDER_CERTIFICATION_CANCEL_CHANNEL,
    async (event, value: unknown) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
      assertTrustedIpcSender(event.sender.id, senderUrl);
      if (!providerCertification) throw new Error('Provider certification is unavailable.');
      await providerCertification.cancel(providerCertificationIdSchema.parse(value));
    },
  );

  const trainingHandler = (
    channel: string,
    work: (service: TrainingSessionService, value: unknown) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (event, value: unknown) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
      assertTrustedIpcSender(event.sender.id, senderUrl);
      return work(await getTrainingService(), value);
    });
  };

  trainingHandler(TRAINING_START_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.start(trainingStartInputSchema.parse(value).topic),
  ));
  trainingHandler(TRAINING_CLOSE_FIRST_CHANNEL, async (service, value) => (
    trainingTurnStateSchema.parse(
      await service.closeFirst(trainingCloseFirstInputSchema.parse(value)),
    )
  ));
  trainingHandler(TRAINING_DIAGNOSE_CHANNEL, async (service) => trainingTurnStateSchema.parse(
    await service.diagnose(),
  ));
  trainingHandler(TRAINING_HINT_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.hint(trainingHintLevelSchema.parse(value)),
  ));
  trainingHandler(TRAINING_SECOND_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.second(trainingSecondInputSchema.parse(value).responseText),
  ));
  trainingHandler(TRAINING_EXTRACT_CHANNEL, async (service) => trainingTurnStateSchema.parse(
    await service.extract(),
  ));
  trainingHandler(TRAINING_CONFIRM_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.confirm(trainingConfirmInputSchema.parse(value).candidateIds),
  ));
  trainingHandler(TRAINING_DUE_CHANNEL, async (service) => trainingDueListSchema.parse(
    service.dueQueue(),
  ));
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
  const runtimePaths = getAgentRuntimePaths();
  credentialVault = new CredentialVault(runtimePaths.credentialVaultPath);
  providerConfiguration = new ProviderConfigurationService(
    credentialVault,
    new ProviderSettingsStore(path.join(app.getPath('userData'), 'settings')),
  );
  await providerConfiguration.initialize();
  bashRuntimeManager = new BashRuntimeManager({
    runtimesRoot: path.join(app.getPath('userData'), 'runtimes'),
  });
  registerIpcHandlers();
  await createMainWindow();

  agentWorkerHost = new AgentWorkerHost(
    path.join(__dirname, 'worker.mjs'),
    isPackagedSmokeTest,
    isAgentE2eSmokeTest,
  );
  providerCertification = new ProviderCertificationService({
    agent: agentWorkerHost,
    provider: providerConfiguration,
    bashManager: bashRuntimeManager,
    paths: runtimePaths,
    manifestPath: getBashRuntimeManifestPath(),
    temporaryRoot: app.getPath('temp'),
  });
  void agentWorkerHost.diagnose(runtimePaths).then(async () => {
    agentRuntimeDiagnostic = 'ready';
    agentRuntimeDiagnosticDetail = null;
    if (isAgentE2eSmokeTest) await runPackagedAgentE2eSmoke();
    agentSmokeReady = true;
    completePackagedSmokeTest();
  }).catch((reason: unknown) => {
    agentRuntimeDiagnostic = 'error';
    agentRuntimeDiagnosticDetail = reason instanceof Error
      ? reason.message.slice(0, 240)
      : 'Agent runtime diagnostic failed.';
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
  credentialVault?.clearSessionSecrets();
  agentWorkerHost?.close();
  asrWorkerHost?.close();
  try {
    productDatabase?.close();
  } catch {
    // already closed
  }
  productDatabase = null;
  trainingService = null;
  trainingServicePromise = null;
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitCleanupStarted) return;
  event.preventDefault();
  quitCleanupStarted = true;
  void Promise.resolve(providerCertification?.cancelAll()).finally(() => app.quit());
});
