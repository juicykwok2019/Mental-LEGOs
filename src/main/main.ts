import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
} from 'electron';
import { z } from 'zod';

import { AgentWorkerHost } from './agent-worker-host';
import { AsrWorkerHost } from './asr-worker-host';
import { BashRuntimeManager } from '../bash/runtime-manager';
import { loadBashRuntimeManifest } from '../bash/runtime-manifest';
import { CredentialVault } from './credential-vault';
import { configurePdfAssets, parseMaterialFile } from './material-file';
import { ProviderCertificationService } from './provider-certification';
import { ProviderConfigurationService } from './provider-configuration';
import { ProviderSettingsStore } from './provider-settings-store';
import { SpeechService } from './speech-service';
import { TrainingSessionService } from './training-session';
import { UsageLedger } from './usage-ledger';
import { loadVaultDataKeyProvider } from '../data/data-key';
import { exportDatabase, restoreDatabase, type ExportEnvelope } from '../data/export';
import { ProductDatabase } from '../data/product-database';

import {
  APP_INFO_CHANNEL,
  AGENT_READINESS_GET_CHANNEL,
  BASH_RUNTIME_INSTALL_CHANNEL,
  FOUNDATION_DELETE_KNOWLEDGE_CHANNEL,
  FOUNDATION_OVERVIEW_CHANNEL,
  FOUNDATION_RESOLVE_ASSERTION_CHANNEL,
  PROVIDER_SETUP_CLEAR_CHANNEL,
  PROVIDER_CERTIFICATION_CANCEL_CHANNEL,
  PROVIDER_CERTIFICATION_CONFIRM_CHANNEL,
  PROVIDER_CERTIFICATION_START_CHANNEL,
  PROVIDER_SETUP_GET_CHANNEL,
  PROVIDER_SETUP_SAVE_CHANNEL,
  RENDERER_READY_CHANNEL,
  LIBRARY_ARCHIVE_CHANNEL,
  LIBRARY_DELETE_MODULE_CHANNEL,
  LIBRARY_DELETE_VERSION_CHANNEL,
  LIBRARY_LINK_CHANNEL,
  LIBRARY_LIST_CHANNEL,
  LIBRARY_UNLINK_CHANNEL,
  LIBRARY_RESTORE_CHANNEL,
  LIBRARY_MODULE_DETAIL_CHANNEL,
  LIBRARY_PROMOTE_CHANNEL,
  LIBRARY_REAL_WORLD_CHANNEL,
  MATERIAL_PARSE_FILE_CHANNEL,
  RECORDING_DELETE_CHANNEL,
  RECORDING_LIST_CHANNEL,
  PRIVACY_EXPORT_CHANNEL,
  PRIVACY_IMPORT_CHANNEL,
  PRIVACY_OVERVIEW_CHANNEL,
  PROFILE_GET_CHANNEL,
  PROFILE_SAVE_CHANNEL,
  SCENARIO_ADD_MATERIAL_CHANNEL,
  SCENARIO_CREATE_CHANNEL,
  SCENARIO_DELETE_CHANNEL,
  SCENARIO_DELETE_MATERIAL_CHANNEL,
  SCENARIO_DELETE_PREVIEW_CHANNEL,
  SCENARIO_COMPOSE_OUTLINE_CHANNEL,
  SCENARIO_MATERIAL_INTENT_CHANNEL,
  SCENARIO_TRANSFORM_OUTLINE_CHANNEL,
  SCENARIO_LIST_CHANNEL,
  SCENARIO_PREPARE_CHANNEL,
  SCENARIO_REVIEW_CHANNEL,
  SCENARIO_START_QUESTION_CHANNEL,
  SPEECH_INSTALL_CHANNEL,
  SPEECH_READINESS_CHANNEL,
  SPEECH_TRANSCRIBE_CHANNEL,
  TRAINING_CLOSE_FIRST_CHANNEL,
  TRAINING_CONFIRM_CHANNEL,
  TRAINING_DIAGNOSE_CHANNEL,
  TRAINING_DUE_CHANNEL,
  TRAINING_EXTRACT_CHANNEL,
  TRAINING_FOLLOW_UP_CHANNEL,
  TRAINING_GAP_CHANNEL,
  TRAINING_HINT_CHANNEL,
  TRAINING_SECOND_CHANNEL,
  TRAINING_START_CHANNEL,
  TRAINING_STATE_CHANNEL,
  TRAINING_VARIATION_ANSWER_CHANNEL,
  TRAINING_VARIATION_SKIP_CHANNEL,
  USAGE_OVERVIEW_CHANNEL,
  appInfoSchema,
  agentReadinessStateSchema,
  foundationOverviewSchema,
  foundationResolveAssertionInputSchema,
  libraryDeleteVersionInputSchema,
  libraryLinkInputSchema,
  libraryModuleDetailSchema,
  libraryUnlinkInputSchema,
  libraryModuleSummarySchema,
  libraryPromoteInputSchema,
  libraryRealWorldInputSchema,
  parsedMaterialFileSchema,
  recordingItemSchema,
  privacyExportResultSchema,
  privacyImportResultSchema,
  privacyOverviewSchema,
  profileSeedInputSchema,
  profileStateSchema,
  providerSetupInputSchema,
  providerSetupStateSchema,
  providerCertificationDraftSchema,
  providerCertificationIdSchema,
  providerCertificationResultSchema,
  scenarioCreateInputSchema,
  scenarioDeleteMaterialInputSchema,
  scenarioDeletePreviewSchema,
  scenarioComposeOutlineInputSchema,
  scenarioMaterialIntentInputSchema,
  scenarioTransformOutlineInputSchema,
  scenarioMaterialInputSchema,
  scenarioReviewInputSchema,
  scenarioSummarySchema,
  speechReadinessSchema,
  speechTranscriptionResultSchema,
  trainingCloseFirstInputSchema,
  trainingConfirmInputSchema,
  trainingDueListSchema,
  trainingGapInputSchema,
  trainingHintLevelSchema,
  trainingSecondInputSchema,
  trainingStartInputSchema,
  trainingTurnStateSchema,
  trainingVariationAnswerInputSchema,
  usageOverviewSchema,
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
let speechService: SpeechService | null = null;
let verifiedBashRuntimeDirectory: string | null = null;
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

let usageLedgerPromise: Promise<UsageLedger> | null = null;

function getUsageLedger(): Promise<UsageLedger> {
  usageLedgerPromise ??= UsageLedger.open(app.getPath('userData'));
  return usageLedgerPromise;
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
      const ledger = await getUsageLedger();
      trainingService = new TrainingSessionService({
        onAgentUsage: (usage) => ledger.record(usage),
        agent,
        provider,
        runtime: {
          paths: () => runtimePaths,
          manifestPath: getBashRuntimeManifestPath,
          resolveBashRuntimeDirectory: async () => {
            // Deep hash verification of the ~310MB runtime once per app run;
            // later steps trust the cached result to keep chat latency low.
            if (verifiedBashRuntimeDirectory) return verifiedBashRuntimeDirectory;
            const manifest = await loadBashRuntimeManifest(getBashRuntimeManifestPath());
            const status = await bashManager.inspect(manifest, true);
            if (status.state !== 'installed') {
              throw new Error('先在设置中下载并校验离线 Bash 运行时，再开始训练。');
            }
            verifiedBashRuntimeDirectory = status.runtimeDirectory;
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

async function getProductDatabase(): Promise<ProductDatabase> {
  await getTrainingService();
  if (!productDatabase) throw new Error('The formal database is unavailable.');
  return productDatabase;
}

async function getSpeechService(): Promise<SpeechService> {
  if (speechService) return speechService;
  if (!asrWorkerHost) throw new Error('The local speech runtime is not initialized yet.');
  const resourcesRoot = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');
  speechService = new SpeechService({
    transcriber: asrWorkerHost,
    modelsRoot: path.join(app.getPath('userData'), 'models'),
    manifestPath: path.join(
      resourcesRoot,
      'asr-models',
      'sensevoice-small-int8-2024-07-17.json',
    ),
    mediaRoot: path.join(app.getPath('userData'), 'media'),
  });
  return speechService;
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

  const guarded = (
    channel: string,
    work: (value: unknown) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (event, value: unknown) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl) throw new Error('IPC request rejected: missing sender frame.');
      assertTrustedIpcSender(event.sender.id, senderUrl);
      return work(value);
    });
  };
  const withService = (
    channel: string,
    work: (service: TrainingSessionService, value: unknown) => Promise<unknown>,
  ): void => {
    guarded(channel, async (value) => work(await getTrainingService(), value));
  };

  withService(PROFILE_GET_CHANNEL, async (service) => profileStateSchema.parse(
    service.profileState(),
  ));
  withService(PROFILE_SAVE_CHANNEL, async (service, value) => profileStateSchema.parse(
    service.saveProfile(profileSeedInputSchema.parse(value)),
  ));

  guarded(SPEECH_READINESS_CHANNEL, async () => speechReadinessSchema.parse(
    await (await getSpeechService()).readiness(),
  ));
  guarded(SPEECH_INSTALL_CHANNEL, async () => speechReadinessSchema.parse(
    await (await getSpeechService()).install(),
  ));
  guarded(SPEECH_TRANSCRIBE_CHANNEL, async (value) => {
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
      throw new Error('Recording payload must be binary.');
    }
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const result = await (await getSpeechService()).transcribe(bytes);
    return speechTranscriptionResultSchema.parse({
      recordingId: result.recordingId,
      text: result.text,
      audioDurationSeconds: result.audioDurationSeconds,
      realTimeFactor: result.realTimeFactor,
    });
  });

  withService(TRAINING_STATE_CHANNEL, async (service) => trainingTurnStateSchema.parse(
    service.state(),
  ));
  withService(TRAINING_START_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.start(trainingStartInputSchema.parse(value)),
  ));
  withService(TRAINING_CLOSE_FIRST_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.closeFirst(trainingCloseFirstInputSchema.parse(value)),
  ));
  withService(TRAINING_GAP_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.resolveGap(trainingGapInputSchema.parse(value).gap),
  ));
  withService(TRAINING_DIAGNOSE_CHANNEL, async (service) => trainingTurnStateSchema.parse(
    await service.diagnose(),
  ));
  withService(TRAINING_HINT_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.hint(trainingHintLevelSchema.parse(value)),
  ));
  withService(TRAINING_SECOND_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.second(trainingSecondInputSchema.parse(value).responseText),
  ));
  withService(TRAINING_EXTRACT_CHANNEL, async (service) => trainingTurnStateSchema.parse(
    await service.extract(),
  ));
  withService(TRAINING_CONFIRM_CHANNEL, async (service, value) => {
    const input = trainingConfirmInputSchema.parse(value);
    return trainingTurnStateSchema.parse(await service.confirm(input.candidateIds, input.edits));
  });
  withService(TRAINING_VARIATION_ANSWER_CHANNEL, async (service, value) => (
    trainingTurnStateSchema.parse(await service.answerVariation(
      trainingVariationAnswerInputSchema.parse(value).responseText,
    ))
  ));
  withService(TRAINING_VARIATION_SKIP_CHANNEL, async (service) => trainingTurnStateSchema.parse(
    await service.skipVariation(),
  ));
  withService(TRAINING_FOLLOW_UP_CHANNEL, async (service) => trainingTurnStateSchema.parse(
    await service.followUp(),
  ));
  withService(TRAINING_DUE_CHANNEL, async (service) => trainingDueListSchema.parse(
    service.dueQueue(),
  ));

  withService(SCENARIO_LIST_CHANNEL, async (service) => (
    z.array(scenarioSummarySchema).parse(service.listScenarios())
  ));
  withService(SCENARIO_CREATE_CHANNEL, async (service, value) => scenarioSummarySchema.parse(
    service.createScenario(scenarioCreateInputSchema.parse(value)),
  ));
  withService(SCENARIO_ADD_MATERIAL_CHANNEL, async (service, value) => scenarioSummarySchema.parse(
    service.addScenarioMaterial(scenarioMaterialInputSchema.parse(value)),
  ));
  withService(SCENARIO_DELETE_MATERIAL_CHANNEL, async (service, value) => scenarioSummarySchema.parse(
    service.deleteScenarioMaterial(scenarioDeleteMaterialInputSchema.parse(value)),
  ));
  withService(SCENARIO_MATERIAL_INTENT_CHANNEL, async (service, value) => scenarioSummarySchema.parse(
    service.updateScenarioMaterialIntent(scenarioMaterialIntentInputSchema.parse(value)),
  ));
  withService(SCENARIO_COMPOSE_OUTLINE_CHANNEL, async (service, value) => scenarioSummarySchema.parse(
    await service.composeSpeechOutline(scenarioComposeOutlineInputSchema.parse(value)),
  ));
  withService(SCENARIO_TRANSFORM_OUTLINE_CHANNEL, async (service, value) => scenarioSummarySchema.parse(
    await service.transformSpeechOutline(scenarioTransformOutlineInputSchema.parse(value)),
  ));
  withService(SCENARIO_PREPARE_CHANNEL, async (service, value) => scenarioSummarySchema.parse(
    await service.prepareScenario(z.string().uuid().parse(value)),
  ));
  withService(SCENARIO_START_QUESTION_CHANNEL, async (service, value) => {
    const input = z.object({
      scenarioId: z.string().uuid(),
      questionId: z.string().uuid(),
    }).parse(value);
    return trainingTurnStateSchema.parse(await service.start({
      topic: '',
      scenarioId: input.scenarioId,
      questionId: input.questionId,
    }));
  });
  withService(SCENARIO_REVIEW_CHANNEL, async (service, value) => trainingTurnStateSchema.parse(
    await service.reviewScenario(scenarioReviewInputSchema.parse(value)),
  ));
  withService(SCENARIO_DELETE_PREVIEW_CHANNEL, async (_service, value) => {
    const database = await getProductDatabase();
    return scenarioDeletePreviewSchema.parse(
      database.previewScenarioDeletion(z.string().uuid().parse(value)),
    );
  });
  withService(SCENARIO_DELETE_CHANNEL, async (_service, value) => {
    const database = await getProductDatabase();
    return scenarioDeletePreviewSchema.parse(
      database.deleteScenario(z.string().uuid().parse(value)),
    );
  });

  withService(LIBRARY_LIST_CHANNEL, async () => {
    const database = await getProductDatabase();
    // Archived modules stay listed so the renderer can show them in a
    // dedicated group with a restore action.
    const modules = database.listLegoModules();
    return z.array(libraryModuleSummarySchema).parse(modules.map((module) => {
      const mastery = database.getMasteryState(module.id);
      return {
        id: module.id,
        title: module.title,
        category: module.category,
        scope: module.scope,
        domain: module.domain,
        status: module.status,
        stage: mastery?.stage ?? null,
        dueAt: mastery?.dueAt ?? null,
        triggers: module.triggers,
      };
    }));
  });
  const buildModuleDetail = (database: ProductDatabase, moduleId: string): unknown => {
    const module = database.getLegoModule(moduleId);
    if (!module) throw new Error('Module does not exist.');
    const version = module.currentVersion
      ? database.getLegoVersion(moduleId, module.currentVersion)
      : database.getLegoVersion(moduleId, 1);
    const mastery = database.getMasteryState(moduleId);
    return libraryModuleDetailSchema.parse({
      id: module.id,
      title: module.title,
      category: module.category,
      scope: module.scope,
      domain: module.domain,
      status: module.status,
      stage: mastery?.stage ?? null,
      dueAt: mastery?.dueAt ?? null,
      triggers: module.triggers,
      semanticKernel: version?.payload.semanticKernel ?? '',
      logicSkeleton: version?.payload.logicSkeleton ?? [],
      languageShells: version?.payload.languageShells ?? [],
      anchorPhrase: version?.payload.anchorPhrase ?? '',
      version: module.currentVersion,
      versions: database.listLegoVersions(moduleId).map((entry) => ({
        version: entry.version,
        authorship: entry.authorship,
        createdAt: entry.createdAt,
        isCurrent: entry.version === module.currentVersion,
      })),
      links: database.listModuleLinks(moduleId),
    });
  };
  withService(LIBRARY_MODULE_DETAIL_CHANNEL, async (_service, value) => (
    buildModuleDetail(await getProductDatabase(), z.string().uuid().parse(value))
  ));
  withService(LIBRARY_DELETE_VERSION_CHANNEL, async (_service, value) => {
    const input = libraryDeleteVersionInputSchema.parse(value);
    const database = await getProductDatabase();
    database.deleteLegoVersion(input.moduleId, input.version);
    return buildModuleDetail(database, input.moduleId);
  });
  withService(LIBRARY_LINK_CHANNEL, async (_service, value) => {
    const input = libraryLinkInputSchema.parse(value);
    const database = await getProductDatabase();
    database.linkModules({
      id: randomUUID(),
      fromModuleId: input.moduleId,
      toModuleId: input.targetModuleId,
      relation: input.relation,
    });
    return buildModuleDetail(database, input.moduleId);
  });
  withService(LIBRARY_UNLINK_CHANNEL, async (_service, value) => {
    const input = libraryUnlinkInputSchema.parse(value);
    const database = await getProductDatabase();
    database.unlinkModules(input.linkId);
    return buildModuleDetail(database, input.moduleId);
  });
  withService(LIBRARY_DELETE_MODULE_CHANNEL, async (_service, value) => {
    const moduleId = z.string().uuid().parse(value);
    const database = await getProductDatabase();
    database.deleteLegoModule(moduleId);
  });
  withService(LIBRARY_RESTORE_CHANNEL, async (_service, value) => {
    const moduleId = z.string().uuid().parse(value);
    const database = await getProductDatabase();
    database.restoreLegoModule(moduleId);
    return buildModuleDetail(database, moduleId);
  });
  withService(LIBRARY_ARCHIVE_CHANNEL, async (_service, value) => {
    const database = await getProductDatabase();
    database.archiveLegoModule(z.string().uuid().parse(value));
  });
  withService(LIBRARY_PROMOTE_CHANNEL, async (_service, value) => {
    const database = await getProductDatabase();
    const input = libraryPromoteInputSchema.parse(value);
    const module = database.promoteModuleToGlobal(input.moduleId, input.domain);
    const mastery = database.getMasteryState(module.id);
    return libraryModuleSummarySchema.parse({
      id: module.id,
      title: module.title,
      category: module.category,
      scope: module.scope,
      domain: module.domain,
      status: module.status,
      stage: mastery?.stage ?? null,
      dueAt: mastery?.dueAt ?? null,
      triggers: module.triggers,
    });
  });
  withService(LIBRARY_REAL_WORLD_CHANNEL, async (service, value) => {
    const input = libraryRealWorldInputSchema.parse(value);
    service.recordRealWorldUse({
      moduleId: input.moduleId,
      result: input.result,
      note: input.note,
    });
  });

  guarded(USAGE_OVERVIEW_CHANNEL, async () => usageOverviewSchema.parse(
    (await getUsageLedger()).overview(),
  ));

  const RECORDING_FILE_PATTERN
    = /^recording-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.wav$/u;
  const mediaRootPath = (): string => path.join(app.getPath('userData'), 'media');
  const listRecordingItems = async (): Promise<unknown> => {
    const items: { recordingId: string; fileName: string; sizeBytes: number; recordedAt: string }[] = [];
    try {
      for (const entry of await readdir(mediaRootPath())) {
        const recordingId = RECORDING_FILE_PATTERN.exec(entry)?.[1];
        if (!recordingId) continue;
        const fileStat = await stat(path.join(mediaRootPath(), entry));
        items.push({
          recordingId,
          fileName: entry,
          sizeBytes: fileStat.size,
          recordedAt: fileStat.mtime.toISOString(),
        });
      }
    } catch {
      // A missing media directory simply means no recordings yet.
    }
    items.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return z.array(recordingItemSchema).parse(items);
  };
  guarded(RECORDING_LIST_CHANNEL, async () => listRecordingItems());
  guarded(RECORDING_DELETE_CHANNEL, async (value) => {
    const recordingId = z.string().uuid().parse(value);
    await rm(path.join(mediaRootPath(), `recording-${recordingId}.wav`), { force: true });
    return listRecordingItems();
  });

  guarded(MATERIAL_PARSE_FILE_CHANNEL, async () => {
    const window = mainWindow;
    if (!window) throw new Error('Main window is unavailable.');
    // CMaps and standard fonts ship in node_modules during dev and as
    // extraResource directories in the packaged app (see forge.config.ts).
    const pdfAssetsRoot = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'node_modules', 'pdfjs-dist');
    configurePdfAssets({
      cMapDirectory: path.join(pdfAssetsRoot, 'cmaps'),
      standardFontDirectory: path.join(pdfAssetsRoot, 'standard_fonts'),
    });
    const dialogResult = await dialog.showOpenDialog(window, {
      title: '选择材料文件',
      properties: ['openFile'],
      filters: [
        { name: '材料文件', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    const [selectedPath] = dialogResult.filePaths;
    if (dialogResult.canceled || !selectedPath) return null;
    return parsedMaterialFileSchema.parse(await parseMaterialFile(selectedPath));
  });

  const buildFoundationOverview = async (
    service: TrainingSessionService,
  ): Promise<unknown> => {
    const database = await getProductDatabase();
    const assertions = [
      ...database.listProfileAssertions('candidate'),
      ...database.listProfileAssertions('confirmed'),
    ].map((assertion) => ({
      id: assertion.id,
      tier: assertion.tier,
      statement: assertion.statement,
      status: assertion.status as 'candidate' | 'confirmed',
      createdAt: assertion.createdAt,
    }));
    const knowledge = [
      ...database.listKnowledge({ status: 'confirmed' }),
      ...database.listKnowledge({ status: 'candidate' }),
    ].map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      content: item.content,
      scenarioId: item.scenarioId,
      createdAt: item.createdAt,
    }));
    return foundationOverviewSchema.parse({
      seed: service.profileState().seed,
      assertions,
      knowledge,
      knowledgeGapCount: database.countKnowledgeGaps(),
      recentGaps: database.listRecentKnowledgeGaps(5),
    });
  };
  withService(FOUNDATION_OVERVIEW_CHANNEL, async (service) => buildFoundationOverview(service));
  withService(FOUNDATION_RESOLVE_ASSERTION_CHANNEL, async (service, value) => {
    const input = foundationResolveAssertionInputSchema.parse(value);
    const database = await getProductDatabase();
    database.resolveProfileAssertion(input.assertionId, input.resolution);
    return buildFoundationOverview(service);
  });
  withService(FOUNDATION_DELETE_KNOWLEDGE_CHANNEL, async (service, value) => {
    const knowledgeId = z.string().uuid().parse(value);
    const database = await getProductDatabase();
    database.deleteKnowledgeItem(knowledgeId);
    return buildFoundationOverview(service);
  });

  withService(PRIVACY_OVERVIEW_CHANNEL, async () => {
    const database = await getProductDatabase();
    const dataDirectory = app.getPath('userData');
    const counts: Record<string, number> = {};
    for (const table of ['scenarios', 'sources', 'questions', 'attempts', 'lego_modules',
      'knowledge_items', 'profile_assertions', 'practice_events', 'consent_events']) {
      counts[table] = database.tableCount(table);
    }
    return privacyOverviewSchema.parse({
      dataDirectory,
      diskUsageBytes: await directorySize(path.join(dataDirectory, 'database'))
        + await directorySize(path.join(dataDirectory, 'media'))
        + await directorySize(path.join(dataDirectory, 'training-sessions')),
      counts,
    });
  });
  withService(PRIVACY_IMPORT_CHANNEL, async (_service, value) => {
    const password = z.string().min(8).max(200).parse(value);
    const database = await getProductDatabase();
    const window = mainWindow;
    if (!window) throw new Error('Main window is unavailable.');
    const dialogResult = await dialog.showOpenDialog(window, {
      title: '选择加密备份文件',
      properties: ['openFile'],
      filters: [{ name: 'Mental LEGOs 加密导出', extensions: ['mlexport'] }],
    });
    const [selectedPath] = dialogResult.filePaths;
    if (dialogResult.canceled || !selectedPath) {
      return privacyImportResultSchema.parse({ restored: false, fileName: null, moduleCount: 0 });
    }
    let envelope: ExportEnvelope;
    try {
      envelope = JSON.parse(await readFile(selectedPath, 'utf8')) as ExportEnvelope;
    } catch (reason) {
      throw new Error('这不是有效的 .mlexport 备份文件。', { cause: reason });
    }
    try {
      const manifest = restoreDatabase(database, envelope, password);
      return privacyImportResultSchema.parse({
        restored: true,
        fileName: path.basename(selectedPath),
        moduleCount: manifest.tableCounts['lego_modules'] ?? 0,
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '';
      if (message.includes('empty database')) {
        throw new Error('恢复只能在全新安装（还没有任何数据）时进行，避免覆盖现有数据。', { cause: reason });
      }
      if (message.includes('newer schema')) {
        throw new Error('这个备份来自更新版本的应用，请先升级应用再恢复。', { cause: reason });
      }
      if (message.toLowerCase().includes('auth') || message.includes('decrypt')
        || message.includes('bad')) {
        throw new Error('口令不正确，或备份文件已损坏。', { cause: reason });
      }
      throw reason;
    }
  });
  withService(PRIVACY_EXPORT_CHANNEL, async (_service, value) => {
    const password = z.string().min(8).max(200).parse(value);
    const database = await getProductDatabase();
    const window = mainWindow;
    if (!window) throw new Error('Main window is unavailable.');
    const dialogResult = await dialog.showSaveDialog(window, {
      title: '导出加密数据包',
      defaultPath: `mental-legos-export-${new Date().toISOString().slice(0, 10)}.mlexport`,
      filters: [{ name: 'Mental LEGOs 加密导出', extensions: ['mlexport'] }],
    });
    if (dialogResult.canceled || !dialogResult.filePath) {
      return privacyExportResultSchema.parse({ saved: false, fileName: null });
    }
    const envelope = exportDatabase(database, password);
    await writeFile(dialogResult.filePath, JSON.stringify(envelope), 'utf8');
    return privacyExportResultSchema.parse({
      saved: true,
      fileName: path.basename(dialogResult.filePath),
    });
  });
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) total += await directorySize(full);
      else if (entry.isFile()) total += (await stat(full)).size;
    }
  } catch {
    // missing directories count as zero
  }
  return total;
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
    // The forge vite plugin launches Electron and the renderer dev server
    // concurrently; on a warm start Electron wins the race and the first load
    // hits ERR_CONNECTION_REFUSED, so retry until the dev server listens.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  await mainWindow.loadURL(PACKAGED_RENDERER_URL);
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
    // Surface worker logs in dev so a stalled step is visible in the console.
    isPackagedSmokeTest || !app.isPackaged,
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
