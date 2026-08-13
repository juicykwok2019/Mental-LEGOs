import { z } from 'zod';

import {
  providerCertificationSchema,
  providerDefinitionSchema,
  providerIdSchema,
} from './providers';

export const APP_INFO_CHANNEL = 'app:get-info' as const;
export const RENDERER_READY_CHANNEL = 'app:renderer-ready' as const;
export const PROVIDER_SETUP_GET_CHANNEL = 'provider-setup:get' as const;
export const PROVIDER_SETUP_SAVE_CHANNEL = 'provider-setup:save' as const;
export const PROVIDER_SETUP_CLEAR_CHANNEL = 'provider-setup:clear' as const;
export const AGENT_READINESS_GET_CHANNEL = 'agent-readiness:get' as const;
export const BASH_RUNTIME_INSTALL_CHANNEL = 'bash-runtime:install' as const;

export const appInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.literal('win32'),
  phase: z.literal('phase-0'),
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export const credentialStorageSchema = z.enum(['session', 'windows']);

export const providerSetupInputSchema = z.object({
  providerId: providerIdSchema,
  displayName: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(120),
  storage: credentialStorageSchema,
  apiKey: z.string().min(1).max(2560),
});

export type ProviderSetupInput = z.infer<typeof providerSetupInputSchema>;

export const configuredProviderSummarySchema = z.object({
  providerId: providerIdSchema,
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  certification: providerCertificationSchema,
  storage: credentialStorageSchema,
  credentialHint: z.string().regex(/^••••.{1,4}$/u),
});

export type ConfiguredProviderSummary = z.infer<
  typeof configuredProviderSummarySchema
>;

export const providerSetupStateSchema = z.object({
  providers: z.array(providerDefinitionSchema),
  configured: configuredProviderSummarySchema.nullable(),
});

export type ProviderSetupState = z.infer<typeof providerSetupStateSchema>;

export const agentReadinessStateSchema = z.object({
  agentRuntime: z.enum(['checking', 'ready', 'error']),
  bashRuntime: z.enum(['missing', 'invalid', 'ready']),
  bashRuntimeName: z.string().min(1),
  downloadBytes: z.number().int().positive(),
  detail: z.string().max(240).nullable(),
});

export type AgentReadinessState = z.infer<typeof agentReadinessStateSchema>;

export interface MentalLegosDesktopApi {
  getAppInfo(): Promise<AppInfo>;
  reportReady(): Promise<void>;
  getProviderSetup(): Promise<ProviderSetupState>;
  saveProviderSetup(input: ProviderSetupInput): Promise<ProviderSetupState>;
  clearProviderSetup(): Promise<ProviderSetupState>;
  getAgentReadiness(): Promise<AgentReadinessState>;
  installBashRuntime(): Promise<AgentReadinessState>;
}
