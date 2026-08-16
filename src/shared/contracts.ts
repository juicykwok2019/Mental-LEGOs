import { z } from 'zod';

import {
  providerCertificationSchema,
  providerDefinitionSchema,
  providerIdSchema,
  providerProtocolSchema,
} from './providers';

export const APP_INFO_CHANNEL = 'app:get-info' as const;
export const RENDERER_READY_CHANNEL = 'app:renderer-ready' as const;
export const PROVIDER_SETUP_GET_CHANNEL = 'provider-setup:get' as const;
export const PROVIDER_SETUP_SAVE_CHANNEL = 'provider-setup:save' as const;
export const PROVIDER_SETUP_CLEAR_CHANNEL = 'provider-setup:clear' as const;
export const AGENT_READINESS_GET_CHANNEL = 'agent-readiness:get' as const;
export const BASH_RUNTIME_INSTALL_CHANNEL = 'bash-runtime:install' as const;
export const PROVIDER_CERTIFICATION_START_CHANNEL = 'provider-certification:start' as const;
export const PROVIDER_CERTIFICATION_CONFIRM_CHANNEL = 'provider-certification:confirm' as const;
export const PROVIDER_CERTIFICATION_CANCEL_CHANNEL = 'provider-certification:cancel' as const;

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
  protocol: providerProtocolSchema,
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

export const providerCertificationCheckSchema = z.object({
  id: z.enum([
    'streaming',
    'skill',
    'native-files',
    'bash-python',
    'mcp-candidate',
    'confirmation-boundary',
    'session-resume',
    'confirmed-write',
  ]),
  label: z.string().min(1).max(120),
  status: z.literal('passed'),
});

export type ProviderCertificationCheck = z.infer<
  typeof providerCertificationCheckSchema
>;

export const providerCertificationDraftSchema = z.object({
  status: z.literal('awaiting-confirmation'),
  certificationId: z.string().uuid(),
  providerName: z.string().min(1),
  model: z.string().min(1),
  candidate: z.object({
    semanticCore: z.string().min(1),
    logicalSkeleton: z.string().min(1),
    languageShell: z.string().min(1),
    scope: z.literal('session'),
  }),
  checks: z.array(providerCertificationCheckSchema).min(1),
});

export type ProviderCertificationDraft = z.infer<
  typeof providerCertificationDraftSchema
>;

export const providerCertificationResultSchema = z.object({
  status: z.literal('passed'),
  providerName: z.string().min(1),
  model: z.string().min(1),
  completedAt: z.string().datetime(),
  checks: z.array(providerCertificationCheckSchema).min(1),
});

export type ProviderCertificationResult = z.infer<
  typeof providerCertificationResultSchema
>;

export const providerCertificationIdSchema = z.string().uuid();

export const TRAINING_START_CHANNEL = 'training:start' as const;
export const TRAINING_CLOSE_FIRST_CHANNEL = 'training:close-first' as const;
export const TRAINING_DIAGNOSE_CHANNEL = 'training:diagnose' as const;
export const TRAINING_HINT_CHANNEL = 'training:hint' as const;
export const TRAINING_SECOND_CHANNEL = 'training:second' as const;
export const TRAINING_EXTRACT_CHANNEL = 'training:extract' as const;
export const TRAINING_CONFIRM_CHANNEL = 'training:confirm' as const;
export const TRAINING_DUE_CHANNEL = 'training:due' as const;

export const trainingStartInputSchema = z.object({
  topic: z.string().trim().max(400).default(''),
});
export type TrainingStartInput = z.infer<typeof trainingStartInputSchema>;

export const trainingCloseFirstInputSchema = z.object({
  outcome: z.enum(['answered', 'cannot-answer', 'skipped']),
  responseText: z.string().max(30_000).default(''),
});
export type TrainingCloseFirstInput = z.infer<typeof trainingCloseFirstInputSchema>;

export const trainingSecondInputSchema = z.object({
  responseText: z.string().min(1).max(30_000),
});
export type TrainingSecondInput = z.infer<typeof trainingSecondInputSchema>;

export const trainingConfirmInputSchema = z.object({
  candidateIds: z.array(z.string().min(1).max(100)).min(1).max(10),
});
export type TrainingConfirmInput = z.infer<typeof trainingConfirmInputSchema>;

export const trainingTranscriptEntrySchema = z.object({
  role: z.enum(['coach', 'user', 'system']),
  kind: z.enum([
    'question', 'response', 'diagnosis', 'hint', 'status', 'candidates', 'committed',
  ]),
  text: z.string(),
});

export const trainingHintLevelSchema = z.enum(['L1', 'L2', 'L3', 'L4']);
export type TrainingHintLevel = z.infer<typeof trainingHintLevelSchema>;

export const trainingCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  semanticKernel: z.string().min(1),
  logicSkeleton: z.array(z.string()),
  languageShells: z.array(z.string()),
});
export type TrainingCandidate = z.infer<typeof trainingCandidateSchema>;

export const trainingTurnStateSchema = z.object({
  sessionId: z.string().min(1).nullable(),
  phase: z.enum([
    'idle', 'first-attempt', 'first-closed', 'assistance', 'second-done',
    'candidates-ready', 'committed',
  ]),
  question: z.object({ id: z.string().uuid(), prompt: z.string().min(1) }).nullable(),
  gate: z.object({
    attemptId: z.string().uuid(),
    state: z.enum([
      'QUESTION_CREATED', 'FIRST_ATTEMPT_RECORDING', 'FIRST_ATTEMPT_CLOSED',
      'ASSISTANCE_ALLOWED',
    ]),
    assistanceAllowed: z.boolean(),
    nextHintLevel: trainingHintLevelSchema.nullable(),
  }).nullable(),
  transcript: z.array(trainingTranscriptEntrySchema),
  candidates: z.array(trainingCandidateSchema),
  committedCount: z.number().int().nonnegative(),
});
export type TrainingTurnState = z.infer<typeof trainingTurnStateSchema>;

export const trainingDueItemSchema = z.object({
  moduleId: z.string().uuid(),
  title: z.string().min(1),
  stage: z.string().min(1),
  dueAt: z.string().nullable(),
});
export const trainingDueListSchema = z.array(trainingDueItemSchema);
export type TrainingDueItem = z.infer<typeof trainingDueItemSchema>;

export interface MentalLegosDesktopApi {
  getAppInfo(): Promise<AppInfo>;
  reportReady(): Promise<void>;
  getProviderSetup(): Promise<ProviderSetupState>;
  saveProviderSetup(input: ProviderSetupInput): Promise<ProviderSetupState>;
  clearProviderSetup(): Promise<ProviderSetupState>;
  getAgentReadiness(): Promise<AgentReadinessState>;
  installBashRuntime(): Promise<AgentReadinessState>;
  startProviderCertification(): Promise<ProviderCertificationDraft>;
  confirmProviderCertification(certificationId: string): Promise<ProviderCertificationResult>;
  cancelProviderCertification(certificationId: string): Promise<void>;
  startTraining(input: TrainingStartInput): Promise<TrainingTurnState>;
  closeFirstAttempt(input: TrainingCloseFirstInput): Promise<TrainingTurnState>;
  requestDiagnosis(): Promise<TrainingTurnState>;
  requestHint(level: TrainingHintLevel): Promise<TrainingTurnState>;
  submitSecondAttempt(input: TrainingSecondInput): Promise<TrainingTurnState>;
  extractCandidates(): Promise<TrainingTurnState>;
  confirmCandidates(input: TrainingConfirmInput): Promise<TrainingTurnState>;
  getDueModules(): Promise<TrainingDueItem[]>;
}
