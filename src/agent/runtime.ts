import type { Options, SDKMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { skillNames } from './contracts';
import { governanceToolNames } from './governance';
import { createCanUseTool, createPolicyHooks } from './policy';
import { verifyAgentBinary, verifyCapabilityBundle } from './integrity';
import type { SessionWorkspace } from './workspace';
import { verifySessionCapabilityIntegrity } from './workspace';

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
}

export interface AgentRuntimeLimits {
  maxTurns: number;
  maxBudgetUsd?: number;
}

export interface AgentRunRequest {
  prompt: string;
  workspace: SessionWorkspace;
  paths: AgentRuntimePaths;
  provider: ProviderProcessEnvironment;
  limits: AgentRuntimeLimits;
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

export function buildAgentOptions(request: AgentRunRequest): Options {
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
    env: buildMinimalAgentEnvironment({
      provider: request.provider,
      configDirectory: request.workspace.config,
    }),
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
  const [runtime, bundle] = await Promise.all([
    verifyAgentBinary(paths.binaryPath, paths.runtimeManifestPath),
    verifyCapabilityBundle(paths.capabilityBundlePath),
  ]);

  return {
    agentSdkVersion: runtime.agentSdkVersion,
    claudeCodeVersion: runtime.claudeCodeVersion,
    binarySha256: runtime.sha256,
    bundleSha256: bundle.bundleSha256,
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
  ]);

  const messages: SDKMessage[] = [];
  let init: SDKSystemMessage | undefined;
  let sessionId: string | undefined;

  const stream = query({
    prompt: request.prompt,
    options: buildAgentOptions(request),
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
    await verifySessionCapabilityIntegrity(request.workspace);
  }

  if (!init || !sessionId) {
    throw new Error('Claude Agent SDK did not emit a valid init message.');
  }
  return { sessionId, init, messages };
}
