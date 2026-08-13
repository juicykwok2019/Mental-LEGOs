import { z } from 'zod';

import { providerProtocolSchema } from '../shared/providers';

export const skillNames = [
  'deep-research',
  'first-attempt-coach',
  'lego-extraction',
  'post-event-review',
  'privacy-provenance',
  'professional-speaking',
  'profile-evidence',
  'response-diagnosis',
  'scenario-preparation',
  'transfer-question-design',
] as const;

export const agentDiagnosticRequestSchema = z.object({
  type: z.literal('runtime:diagnose'),
  requestId: z.string().min(1),
  binaryPath: z.string().min(1),
  runtimeManifestPath: z.string().min(1),
  capabilityBundlePath: z.string().min(1),
  sandboxLauncherPath: z.string().min(1),
  credentialVaultPath: z.string().min(1),
  bashProxyPath: z.string().min(1),
  providerProxyPath: z.string().min(1),
});

export type AgentDiagnosticRequest = z.infer<typeof agentDiagnosticRequestSchema>;

export const agentIssueCommitTokenRequestSchema = z.object({
  type: z.literal('governance:issue-commit-token'),
  requestId: z.string().uuid(),
  governanceDatabasePath: z.string().min(1),
  previewId: z.string().uuid(),
});

export type AgentIssueCommitTokenRequest = z.infer<typeof agentIssueCommitTokenRequestSchema>;

export const agentIssueCommitTokenResultSchema = z.object({
  type: z.literal('governance:issue-commit-token-result'),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  confirmationToken: z.string().min(32).optional(),
  error: z.string().optional(),
});

export type AgentIssueCommitTokenResult = z.infer<typeof agentIssueCommitTokenResultSchema>;

export const agentDiagnosticResultSchema = z.object({
  type: z.literal('runtime:diagnostic-result'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  report: z.object({
    agentSdkVersion: z.string(),
    claudeCodeVersion: z.string(),
    binarySha256: z.string(),
    bundleSha256: z.string(),
    sandboxLauncherSha256: z.string(),
    credentialVaultSha256: z.string(),
    bashProxySha256: z.string(),
    providerProxySha256: z.string(),
    skills: z.array(z.enum(skillNames)),
    tools: z.array(z.string()),
    subagentsEnabled: z.literal(false),
  }).optional(),
  error: z.string().optional(),
});

export type AgentDiagnosticResult = z.infer<typeof agentDiagnosticResultSchema>;

const agentRuntimePathsSchema = z.object({
  binaryPath: z.string().min(1),
  runtimeManifestPath: z.string().min(1),
  capabilityBundlePath: z.string().min(1),
  sandboxLauncherPath: z.string().min(1),
  credentialVaultPath: z.string().min(1),
  bashProxyPath: z.string().min(1),
  providerProxyPath: z.string().min(1),
});

export const agentRunRequestSchema = z.object({
  type: z.literal('runtime:run'),
  requestId: z.string().uuid(),
  prompt: z.string().min(1).max(2 * 1024 * 1024),
  workspace: z.object({
    sessionsRoot: z.string().min(1),
    sessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
    create: z.boolean(),
  }),
  paths: agentRuntimePathsSchema,
  provider: z.object({
    baseUrl: z.string().url().startsWith('https://'),
    apiKey: z.string().min(1).max(16 * 1024),
    protocol: providerProtocolSchema.default('anthropic-messages'),
    model: z.string().min(1).max(256).optional(),
  }),
  limits: z.object({
    maxTurns: z.number().int().min(1).max(64),
    maxBudgetUsd: z.number().positive().max(1000).optional(),
  }),
  bashRuntime: z.object({
    manifestPath: z.string().min(1),
    runtimeDirectory: z.string().min(1),
    cacheDirectory: z.string().min(1),
  }),
  governanceDatabasePath: z.string().min(1),
  resume: z.string().uuid().optional(),
});

export type AgentWorkerRunRequest = z.infer<typeof agentRunRequestSchema>;

export const agentRunResultSchema = z.object({
  type: z.literal('runtime:run-result'),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  result: z.object({
    workspaceSessionId: z.string(),
    agentSessionId: z.string().uuid(),
    messages: z.array(z.unknown()),
  }).optional(),
  error: z.string().optional(),
});

export type AgentWorkerRunResult = z.infer<typeof agentRunResultSchema>;
