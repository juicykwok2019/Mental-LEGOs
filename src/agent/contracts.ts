import { z } from 'zod';

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
});

export type AgentDiagnosticRequest = z.infer<typeof agentDiagnosticRequestSchema>;

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
    skills: z.array(z.enum(skillNames)),
    tools: z.array(z.string()),
    subagentsEnabled: z.literal(false),
  }).optional(),
  error: z.string().optional(),
});

export type AgentDiagnosticResult = z.infer<typeof agentDiagnosticResultSchema>;
