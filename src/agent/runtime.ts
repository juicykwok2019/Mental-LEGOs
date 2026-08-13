import path from 'node:path';

import type { Options, SDKMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { WasmerBashBroker } from '../bash/broker';
import { resolveVerifiedBashRuntime } from '../bash/runtime-manager';
import { loadBashRuntimeManifest } from '../bash/runtime-manifest';
import { skillNames } from './contracts';
import { governanceToolNames } from './governance';
import { createCanUseTool, createPolicyHooks } from './policy';
import {
  createWindowsSandboxSpawner,
  deleteWindowsSandboxProfile,
} from './sandbox';
import {
  verifyAgentBinary,
  verifyBashProxy,
  verifyCapabilityBundle,
  verifyCredentialVault,
  verifyProviderProxy,
  verifySandboxLauncher,
} from './integrity';
import type { SessionWorkspace } from './workspace';
import {
  stageSessionBashProxy,
  verifySessionCapabilityIntegrity,
} from './workspace';

export const nativeAgentTools = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'Skill',
] as const;

const disabledTools = [
  'Agent',
  'Task',
  'WebSearch',
  'WebFetch',
] as const;

export interface ProviderProcessEnvironment {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export interface AgentRuntimePaths {
  binaryPath: string;
  runtimeManifestPath: string;
  capabilityBundlePath: string;
  sandboxLauncherPath: string;
  credentialVaultPath: string;
  bashProxyPath: string;
  providerProxyPath: string;
}

export interface AgentRuntimeLimits {
  maxTurns: number;
  maxBudgetUsd?: number;
}

export interface AgentBashRuntimeConfiguration {
  manifestPath: string;
  runtimeDirectory: string;
  cacheDirectory: string;
}

export interface AgentRunRequest {
  prompt: string;
  workspace: SessionWorkspace;
  paths: AgentRuntimePaths;
  provider: ProviderProcessEnvironment;
  limits: AgentRuntimeLimits;
  bashRuntime: AgentBashRuntimeConfiguration;
  resume?: string;
  mcpServers: NonNullable<Options['mcpServers']>;
}

export interface AgentRunResult {
  sessionId: string;
  init: SDKSystemMessage;
  messages: SDKMessage[];
}

const inheritedEnvironmentKeys = [
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PATH',
  'TEMP',
  'TMP',
  'LOCALAPPDATA',
] as const;

export function buildMinimalAgentEnvironment(options: {
  provider: ProviderProcessEnvironment;
  configDirectory: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = options.sourceEnvironment ?? process.env;
  const environment: Record<string, string> = {};

  for (const key of inheritedEnvironmentKeys) {
    if (source[key]) environment[key] = source[key];
  }

  environment.ANTHROPIC_BASE_URL = options.provider.baseUrl;
  environment.ANTHROPIC_API_KEY = options.provider.apiKey;
  environment.CLAUDE_CONFIG_DIR = options.configDirectory;
  environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  environment.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = '1';
  environment.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1';
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = 'mental-legos/0.1.0';
  environment.NO_PROXY = '127.0.0.1,localhost';

  return environment;
}

export function buildAgentOptions(
  request: AgentRunRequest,
  bashEnvironment?: Record<string, string>,
): Options {
  if (!request.provider.baseUrl.startsWith('https://')
    && !request.provider.baseUrl.startsWith('http://127.0.0.1:')) {
    throw new Error('Provider Base URL must use HTTPS or the loopback broker.');
  }
  if (!request.provider.apiKey) throw new Error('A provider API key is required.');
  if (!Number.isInteger(request.limits.maxTurns) || request.limits.maxTurns < 1) {
    throw new Error('maxTurns must be a positive integer.');
  }

  return {
    cwd: request.workspace.root,
    pathToClaudeCodeExecutable: request.paths.binaryPath,
    spawnClaudeCodeProcess: createWindowsSandboxSpawner({
      launcherPath: request.paths.sandboxLauncherPath,
      workspace: request.workspace,
    }),
    settingSources: ['project'],
    strictMcpConfig: true,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: [
        'You are the single Mental LEGOs main agent.',
        'Follow the host attempt gate, scoped-data, candidate, confirmation, and workspace policies.',
        'Do not create or invoke subagents. Do not use network tools unless the host starts explicit Deep Research mode.',
        'Use native tools and Skills flexibly; do not simulate a fixed workflow.',
      ].join(' '),
    },
    tools: [...nativeAgentTools, ...governanceToolNames],
    disallowedTools: [...disabledTools],
    allowedTools: [],
    skills: [...skillNames],
    mcpServers: request.mcpServers,
    canUseTool: createCanUseTool(request.workspace),
    hooks: createPolicyHooks(request.workspace),
    env: {
      ...buildMinimalAgentEnvironment({
        provider: request.provider,
        configDirectory: request.workspace.config,
      }),
      TEMP: request.workspace.temporary,
      TMP: request.workspace.temporary,
      ...(bashEnvironment ?? {}),
    },
    permissionMode: 'default',
    maxTurns: request.limits.maxTurns,
    ...(request.limits.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: request.limits.maxBudgetUsd }),
    ...(request.provider.model === undefined
      ? {}
      : { model: request.provider.model }),
    ...(request.resume === undefined ? {} : { resume: request.resume }),
  };
}

export async function diagnoseAgentRuntime(paths: AgentRuntimePaths) {
  const [runtime, bundle, sandbox, credentialVault, bashProxy, providerProxy] = await Promise.all([
    verifyAgentBinary(paths.binaryPath, paths.runtimeManifestPath),
    verifyCapabilityBundle(paths.capabilityBundlePath),
    verifySandboxLauncher(paths.sandboxLauncherPath, paths.runtimeManifestPath),
    verifyCredentialVault(paths.credentialVaultPath, paths.runtimeManifestPath),
    verifyBashProxy(paths.bashProxyPath, paths.runtimeManifestPath),
    verifyProviderProxy(paths.providerProxyPath, paths.runtimeManifestPath),
  ]);

  return {
    agentSdkVersion: runtime.agentSdkVersion,
    claudeCodeVersion: runtime.claudeCodeVersion,
    binarySha256: runtime.sha256,
    bundleSha256: bundle.bundleSha256,
    sandboxLauncherSha256: sandbox.sha256,
    credentialVaultSha256: credentialVault.sha256,
    bashProxySha256: bashProxy.sha256,
    providerProxySha256: providerProxy.sha256,
    skills: bundle.skills,
    tools: [...nativeAgentTools, ...governanceToolNames],
    subagentsEnabled: false as const,
  };
}

function validateInitMessage(message: SDKSystemMessage): void {
  for (const skillName of skillNames) {
    if (message.skills.filter((value) => value === skillName).length !== 1) {
      throw new Error(`SDK did not discover exactly one project Skill named ${skillName}.`);
    }
  }
  const unexpectedSkills = message.skills.filter((value) => (
    !skillNames.includes(value as typeof skillNames[number]) && value !== 'doctor'
  ));
  if (unexpectedSkills.length > 0) {
    throw new Error(`SDK exposed unexpected Skills: ${unexpectedSkills.join(', ')}`);
  }
  if (message.tools.includes('Agent') || message.tools.includes('Task')) {
    throw new Error('Subagent tools appeared in the ordinary runtime tool list.');
  }
}

export async function runAgent(request: AgentRunRequest): Promise<AgentRunResult> {
  await Promise.all([
    verifyAgentBinary(request.paths.binaryPath, request.paths.runtimeManifestPath),
    verifySessionCapabilityIntegrity(request.workspace),
    verifySandboxLauncher(
      request.paths.sandboxLauncherPath,
      request.paths.runtimeManifestPath,
    ),
    verifyCredentialVault(
      request.paths.credentialVaultPath,
      request.paths.runtimeManifestPath,
    ),
    verifyBashProxy(
      request.paths.bashProxyPath,
      request.paths.runtimeManifestPath,
    ),
    verifyProviderProxy(
      request.paths.providerProxyPath,
      request.paths.runtimeManifestPath,
    ),
  ]);

  const bashManifest = await loadBashRuntimeManifest(request.bashRuntime.manifestPath);
  await stageSessionBashProxy({
    workspace: request.workspace,
    verifiedProxyPath: request.paths.bashProxyPath,
  });
  await verifyBashProxy(
    request.workspace.bashProxy,
    request.paths.runtimeManifestPath,
  );
  const bashRuntime = await resolveVerifiedBashRuntime({
    manifest: bashManifest,
    runtimeDirectory: request.bashRuntime.runtimeDirectory,
    cacheDirectory: request.bashRuntime.cacheDirectory,
    proxyPath: request.workspace.bashProxy,
  });
  const bashBroker = new WasmerBashBroker({
    ipcDirectory: request.workspace.bashIpc,
    workspaceRoot: request.workspace.root,
    temporaryDirectory: request.workspace.temporary,
    scratchDirectory: request.workspace.scratch,
    outputDirectory: request.workspace.output,
    guestRootDirectory: request.workspace.bashGuestRoot,
    runtime: bashRuntime,
  });
  await bashBroker.start();

  const messages: SDKMessage[] = [];
  let init: SDKSystemMessage | undefined;
  let sessionId: string | undefined;

  let executionError: unknown;
  try {
    const stream = query({
      prompt: request.prompt,
      options: buildAgentOptions(request, bashBroker.agentEnvironment()),
    });
    try {
      for await (const message of stream) {
        messages.push(message);
        if (message.type === 'system' && message.subtype === 'init') {
          validateInitMessage(message);
          init = message;
          sessionId = message.session_id;
        }
      }
    } finally {
      stream.close();
    }
  } catch (reason) {
    executionError = reason;
  }

  const cleanup = await Promise.allSettled([
    bashBroker.close(),
    deleteWindowsSandboxProfile({
      launcherPath: request.paths.sandboxLauncherPath,
      profileName: request.workspace.sandboxProfile,
      aclPaths: [
        request.workspace.root,
        request.workspace.scratch,
        request.workspace.output,
        request.workspace.temporary,
        request.workspace.config,
        request.workspace.bashIpc,
        path.dirname(request.paths.binaryPath),
        request.paths.binaryPath,
      ],
    }),
  ]);
  await verifySessionCapabilityIntegrity(request.workspace);
  const cleanupFailure = cleanup.find((result) => result.status === 'rejected');
  if (cleanupFailure?.status === 'rejected') throw cleanupFailure.reason;
  if (executionError) throw executionError;

  if (!init || !sessionId) {
    throw new Error('Claude Agent SDK did not emit a valid init message.');
  }
  return { sessionId, init, messages };
}
