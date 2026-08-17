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

export const SPEECH_READINESS_CHANNEL = 'speech:readiness' as const;
export const SPEECH_INSTALL_CHANNEL = 'speech:install-model' as const;
export const SPEECH_TRANSCRIBE_CHANNEL = 'speech:transcribe' as const;

export const speechReadinessSchema = z.object({
  model: z.enum(['missing', 'invalid', 'ready']),
  displayName: z.string().min(1),
  downloadBytes: z.number().int().positive(),
  detail: z.string().nullable(),
});
export type SpeechReadinessState = z.infer<typeof speechReadinessSchema>;

export const speechTranscriptionResultSchema = z.object({
  recordingId: z.string().uuid(),
  text: z.string(),
  audioDurationSeconds: z.number().nonnegative(),
  realTimeFactor: z.number().nonnegative(),
});
export type SpeechTranscriptionResult = z.infer<typeof speechTranscriptionResultSchema>;

export const PROFILE_GET_CHANNEL = 'profile:get' as const;
export const PROFILE_SAVE_CHANNEL = 'profile:save' as const;
export const TRAINING_STATE_CHANNEL = 'training:state' as const;
export const TRAINING_START_CHANNEL = 'training:start' as const;
export const TRAINING_CLOSE_FIRST_CHANNEL = 'training:close-first' as const;
export const TRAINING_GAP_CHANNEL = 'training:resolve-gap' as const;
export const TRAINING_DIAGNOSE_CHANNEL = 'training:diagnose' as const;
export const TRAINING_HINT_CHANNEL = 'training:hint' as const;
export const TRAINING_SECOND_CHANNEL = 'training:second' as const;
export const TRAINING_EXTRACT_CHANNEL = 'training:extract' as const;
export const TRAINING_CONFIRM_CHANNEL = 'training:confirm' as const;
export const TRAINING_VARIATION_ANSWER_CHANNEL = 'training:variation-answer' as const;
export const TRAINING_VARIATION_SKIP_CHANNEL = 'training:variation-skip' as const;
export const TRAINING_FOLLOW_UP_CHANNEL = 'training:follow-up' as const;
export const TRAINING_DUE_CHANNEL = 'training:due' as const;
export const SCENARIO_LIST_CHANNEL = 'scenario:list' as const;
export const SCENARIO_CREATE_CHANNEL = 'scenario:create' as const;
export const SCENARIO_ADD_MATERIAL_CHANNEL = 'scenario:add-material' as const;
export const MATERIAL_PARSE_FILE_CHANNEL = 'material:parse-file' as const;
export const SCENARIO_DELETE_MATERIAL_CHANNEL = 'scenario:delete-material' as const;

export const scenarioDeleteMaterialInputSchema = z.object({
  scenarioId: z.string().uuid(),
  sourceId: z.string().uuid(),
});
export type ScenarioDeleteMaterialInput = z.infer<typeof scenarioDeleteMaterialInputSchema>;
export const SCENARIO_PREPARE_CHANNEL = 'scenario:prepare' as const;
export const SCENARIO_START_QUESTION_CHANNEL = 'scenario:start-question' as const;
export const SCENARIO_REVIEW_CHANNEL = 'scenario:review' as const;
export const SCENARIO_DELETE_PREVIEW_CHANNEL = 'scenario:delete-preview' as const;
export const SCENARIO_DELETE_CHANNEL = 'scenario:delete' as const;
export const LIBRARY_LIST_CHANNEL = 'library:list-modules' as const;
export const LIBRARY_MODULE_DETAIL_CHANNEL = 'library:module-detail' as const;
export const LIBRARY_ARCHIVE_CHANNEL = 'library:archive-module' as const;
export const LIBRARY_PROMOTE_CHANNEL = 'library:promote-module' as const;
export const LIBRARY_REAL_WORLD_CHANNEL = 'library:real-world-report' as const;
export const LIBRARY_DELETE_VERSION_CHANNEL = 'library:delete-version' as const;
export const RECORDING_LIST_CHANNEL = 'recording:list' as const;
export const RECORDING_DELETE_CHANNEL = 'recording:delete' as const;
export const PRIVACY_OVERVIEW_CHANNEL = 'privacy:overview' as const;
export const PRIVACY_EXPORT_CHANNEL = 'privacy:export' as const;
export const USAGE_OVERVIEW_CHANNEL = 'usage:overview' as const;

const usageBucketSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
});
export const usageOverviewSchema = z.object({
  today: usageBucketSchema,
  total: usageBucketSchema,
});
export type UsageOverview = z.infer<typeof usageOverviewSchema>;

export const profileSeedInputSchema = z.object({
  direction: z.string().trim().min(1).max(2000),
  currentWork: z.string().trim().max(4000).default(''),
  targetScenarios: z.string().trim().max(4000).default(''),
  material: z.string().max(200_000).default(''),
});
export type ProfileSeedInput = z.infer<typeof profileSeedInputSchema>;

export const profileStateSchema = z.object({
  seed: profileSeedInputSchema.nullable(),
  confirmedAssertions: z.array(z.string()),
  moduleCount: z.number().int().nonnegative(),
  knowledgeGapCount: z.number().int().nonnegative(),
});
export type ProfileState = z.infer<typeof profileStateSchema>;

export const trainingStartInputSchema = z.object({
  topic: z.string().trim().max(400).default(''),
  scenarioId: z.string().uuid().nullable().default(null),
  questionId: z.string().uuid().nullable().default(null),
});
export type TrainingStartInput = z.infer<typeof trainingStartInputSchema>;

export const spokenInputSchema = z.object({
  responseText: z.string().max(30_000).default(''),
  recordingId: z.string().uuid().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
});

export const trainingCloseFirstInputSchema = spokenInputSchema.extend({
  outcome: z.enum(['answered', 'cannot-answer', 'skipped']),
  openingDelayMs: z.number().int().nonnegative().nullable().default(null),
});
export type TrainingCloseFirstInput = z.infer<typeof trainingCloseFirstInputSchema>;

export const trainingGapInputSchema = z.object({
  gap: z.enum(['knowledge', 'expression']),
});
export type TrainingGapInput = z.infer<typeof trainingGapInputSchema>;

export const trainingSecondInputSchema = spokenInputSchema.extend({
  responseText: z.string().min(1).max(30_000),
});
export type TrainingSecondInput = z.infer<typeof trainingSecondInputSchema>;

export const trainingConfirmInputSchema = z.object({
  candidateIds: z.array(z.string().min(1).max(100)).min(1).max(10),
});
export type TrainingConfirmInput = z.infer<typeof trainingConfirmInputSchema>;

export const trainingVariationAnswerInputSchema = spokenInputSchema.extend({
  responseText: z.string().min(1).max(30_000),
});
export type TrainingVariationAnswerInput = z.infer<typeof trainingVariationAnswerInputSchema>;

export const trainingTranscriptEntrySchema = z.object({
  role: z.enum(['coach', 'user', 'system']),
  kind: z.enum([
    'question', 'response', 'diagnosis', 'hint', 'status', 'candidates', 'committed',
    'gap-note', 'variation-result', 'analysis',
  ]),
  text: z.string(),
});

export const trainingHintLevelSchema = z.enum(['L1', 'L2', 'L3', 'L4']);
export type TrainingHintLevel = z.infer<typeof trainingHintLevelSchema>;

export const trainingCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  domain: z.string().nullable(),
  semanticKernel: z.string().min(1),
  logicSkeleton: z.array(z.string()),
  languageShells: z.array(z.string()),
});
export type TrainingCandidate = z.infer<typeof trainingCandidateSchema>;

export const trainingPhaseSchema = z.enum([
  'idle', 'first-attempt', 'gap-query', 'first-closed', 'assistance', 'second-done',
  'candidates-ready', 'variation', 'round-complete',
]);
export type TrainingPhase = z.infer<typeof trainingPhaseSchema>;

export const trainingTurnStateSchema = z.object({
  sessionId: z.string().min(1).nullable(),
  mode: z.enum(['open', 'scenario', 'speech']).nullable(),
  scenarioId: z.string().uuid().nullable(),
  phase: trainingPhaseSchema,
  question: z.object({
    id: z.string().uuid(),
    prompt: z.string().min(1),
    questionType: z.string().nullable(),
    exploratory: z.boolean(),
  }).nullable(),
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
  busyHint: z.string().nullable(),
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

export const scenarioCreateInputSchema = z.object({
  type: z.enum(['interview', 'meeting', 'negotiation', 'client', 'speech', 'other']),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().max(4000).default(''),
  counterpart: z.string().trim().max(400).default(''),
  worries: z.string().trim().max(4000).default(''),
});
export type ScenarioCreateInput = z.infer<typeof scenarioCreateInputSchema>;

export const scenarioMaterialInputSchema = z.object({
  scenarioId: z.string().uuid(),
  label: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(500_000),
});
export type ScenarioMaterialInput = z.infer<typeof scenarioMaterialInputSchema>;

export const parsedMaterialFileSchema = z.object({
  fileName: z.string().min(1),
  kind: z.enum(['pdf', 'docx', 'text']),
  text: z.string(),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
});
export type ParsedMaterialFile = z.infer<typeof parsedMaterialFileSchema>;

export const scenarioQuestionSummarySchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(1),
  questionType: z.string().nullable(),
  answered: z.boolean(),
});

export const scenarioSummarySchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  title: z.string().min(1),
  objective: z.string(),
  counterpart: z.string(),
  status: z.string().min(1),
  materialCount: z.number().int().nonnegative(),
  materialCharacters: z.number().int().nonnegative(),
  materials: z.array(z.object({
    id: z.string().uuid(),
    label: z.string().min(1),
    characters: z.number().int().nonnegative(),
    addedAt: z.string(),
  })),
  moduleCount: z.number().int().nonnegative(),
  preparedQuestions: z.array(scenarioQuestionSummarySchema),
  analysis: z.string().nullable(),
});
export type ScenarioSummary = z.infer<typeof scenarioSummarySchema>;

// Agent calls excerpt long material/transcripts down to this window before
// sending anything to the provider (see training-session.ts).
export const AGENT_EXCERPT_CHARACTERS = 18_000;
// Above this size the renderer asks for explicit confirmation before starting
// a high-cost agent analysis (PRD §24.5).
export const HIGH_COST_CONFIRM_CHARACTERS = 50_000;

export const scenarioReviewInputSchema = z.object({
  scenarioId: z.string().uuid(),
  transcript: z.string().trim().min(1).max(500_000),
  outcomeNote: z.string().trim().max(4000).default(''),
});
export type ScenarioReviewInput = z.infer<typeof scenarioReviewInputSchema>;

export const scenarioDeletePreviewSchema = z.object({
  scenarioId: z.string().uuid(),
  sources: z.number().int().nonnegative(),
  segments: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  diagnostics: z.number().int().nonnegative(),
  knowledgeItems: z.number().int().nonnegative(),
  scopedModules: z.number().int().nonnegative(),
  globalModuleReferences: z.number().int().nonnegative(),
});
export type ScenarioDeletePreview = z.infer<typeof scenarioDeletePreviewSchema>;

export const libraryModuleSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  category: z.string().min(1),
  scope: z.string().min(1),
  domain: z.string().nullable(),
  status: z.string().min(1),
  stage: z.string().nullable(),
  dueAt: z.string().nullable(),
  triggers: z.array(z.string()),
});
export type LibraryModuleSummary = z.infer<typeof libraryModuleSummarySchema>;

export const libraryModuleDetailSchema = libraryModuleSummarySchema.extend({
  semanticKernel: z.string(),
  logicSkeleton: z.array(z.string()),
  languageShells: z.array(z.string()),
  anchorPhrase: z.string(),
  version: z.number().int().positive().nullable(),
  versions: z.array(z.object({
    version: z.number().int().positive(),
    authorship: z.string(),
    createdAt: z.string(),
    isCurrent: z.boolean(),
  })),
});
export type LibraryModuleDetail = z.infer<typeof libraryModuleDetailSchema>;

export const libraryDeleteVersionInputSchema = z.object({
  moduleId: z.string().uuid(),
  version: z.number().int().positive(),
});
export type LibraryDeleteVersionInput = z.infer<typeof libraryDeleteVersionInputSchema>;

export const recordingItemSchema = z.object({
  recordingId: z.string().uuid(),
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  recordedAt: z.string(),
});
export type RecordingItem = z.infer<typeof recordingItemSchema>;

export const libraryPromoteInputSchema = z.object({
  moduleId: z.string().uuid(),
  domain: z.enum(['generic', 'professional']),
});
export type LibraryPromoteInput = z.infer<typeof libraryPromoteInputSchema>;

export const libraryRealWorldInputSchema = z.object({
  moduleId: z.string().uuid(),
  result: z.enum(['success', 'partial', 'failure']),
  note: z.string().trim().max(4000).default(''),
});
export type LibraryRealWorldInput = z.infer<typeof libraryRealWorldInputSchema>;

export const privacyOverviewSchema = z.object({
  dataDirectory: z.string().min(1),
  diskUsageBytes: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type PrivacyOverview = z.infer<typeof privacyOverviewSchema>;

export const privacyExportInputSchema = z.object({
  password: z.string().min(8).max(200),
});
export const privacyExportResultSchema = z.object({
  saved: z.boolean(),
  fileName: z.string().nullable(),
});
export type PrivacyExportResult = z.infer<typeof privacyExportResultSchema>;

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
  getProfile(): Promise<ProfileState>;
  saveProfile(input: ProfileSeedInput): Promise<ProfileState>;
  getSpeechReadiness(): Promise<SpeechReadinessState>;
  installSpeechModel(): Promise<SpeechReadinessState>;
  transcribeRecording(wav: ArrayBuffer): Promise<SpeechTranscriptionResult>;
  getTrainingState(): Promise<TrainingTurnState>;
  parseMaterialFile(): Promise<ParsedMaterialFile | null>;
  getUsageOverview(): Promise<UsageOverview>;
  deleteModuleVersion(input: LibraryDeleteVersionInput): Promise<LibraryModuleDetail>;
  deleteScenarioMaterial(input: ScenarioDeleteMaterialInput): Promise<ScenarioSummary>;
  listRecordings(): Promise<RecordingItem[]>;
  deleteRecording(recordingId: string): Promise<RecordingItem[]>;
  startTraining(input: TrainingStartInput): Promise<TrainingTurnState>;
  closeFirstAttempt(input: TrainingCloseFirstInput): Promise<TrainingTurnState>;
  resolveGap(input: TrainingGapInput): Promise<TrainingTurnState>;
  requestDiagnosis(): Promise<TrainingTurnState>;
  requestHint(level: TrainingHintLevel): Promise<TrainingTurnState>;
  submitSecondAttempt(input: TrainingSecondInput): Promise<TrainingTurnState>;
  extractCandidates(): Promise<TrainingTurnState>;
  confirmCandidates(input: TrainingConfirmInput): Promise<TrainingTurnState>;
  answerVariation(input: TrainingVariationAnswerInput): Promise<TrainingTurnState>;
  skipVariation(): Promise<TrainingTurnState>;
  askFollowUp(): Promise<TrainingTurnState>;
  getDueModules(): Promise<TrainingDueItem[]>;
  listScenarios(): Promise<ScenarioSummary[]>;
  createScenario(input: ScenarioCreateInput): Promise<ScenarioSummary>;
  addScenarioMaterial(input: ScenarioMaterialInput): Promise<ScenarioSummary>;
  prepareScenario(scenarioId: string): Promise<ScenarioSummary>;
  startScenarioQuestion(scenarioId: string, questionId: string): Promise<TrainingTurnState>;
  reviewScenario(input: ScenarioReviewInput): Promise<TrainingTurnState>;
  previewScenarioDeletion(scenarioId: string): Promise<ScenarioDeletePreview>;
  deleteScenario(scenarioId: string): Promise<ScenarioDeletePreview>;
  listLibraryModules(): Promise<LibraryModuleSummary[]>;
  getLibraryModule(moduleId: string): Promise<LibraryModuleDetail>;
  archiveLibraryModule(moduleId: string): Promise<void>;
  promoteLibraryModule(input: LibraryPromoteInput): Promise<LibraryModuleSummary>;
  reportRealWorldUse(input: LibraryRealWorldInput): Promise<void>;
  getPrivacyOverview(): Promise<PrivacyOverview>;
  exportEncryptedData(password: string): Promise<PrivacyExportResult>;
}
