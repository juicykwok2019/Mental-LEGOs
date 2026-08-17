import { z } from 'zod';

// Formal product data contracts (PRD §7, §8, §9, §23.2). Sensitive free text is
// encrypted at rest by the data layer; these schemas describe decrypted shapes.

export const dataScopeSchema = z.enum(['global', 'scenario', 'session']);
export type DataScope = z.infer<typeof dataScopeSchema>;

export const scenarioTypeSchema = z.enum([
  'interview',
  'meeting',
  'negotiation',
  'client',
  'speech',
  'other',
]);

export const scenarioSchema = z.object({
  id: z.string().uuid(),
  type: scenarioTypeSchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(4000).default(''),
  counterpart: z.string().max(400).default(''),
  scheduledFor: z.string().datetime({ offset: true }).nullable().default(null),
  status: z.enum(['active', 'completed', 'archived']).default('active'),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export const sourceKindSchema = z.enum([
  'document',
  'pasted-text',
  'recording',
  'transcript',
  'attempt',
  'user-statement',
  'external-research',
]);

export const sourceSchema = z.object({
  id: z.string().uuid(),
  scenarioId: z.string().uuid().nullable().default(null),
  scope: dataScopeSchema,
  kind: sourceKindSchema,
  label: z.string().trim().min(1).max(300),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  mediaPath: z.string().max(1024).nullable().default(null),
  retention: z.enum(['keep', 'delete-original-keep-derived']).default('keep'),
  authorizedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
});
export type SourceRecord = z.infer<typeof sourceSchema>;

export const sourceSegmentSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  content: z.string().min(1),
  startMs: z.number().int().nonnegative().nullable().default(null),
  endMs: z.number().int().nonnegative().nullable().default(null),
  page: z.number().int().positive().nullable().default(null),
  speaker: z.string().max(120).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
});
export type SourceSegment = z.infer<typeof sourceSegmentSchema>;

export const knowledgeKindSchema = z.enum([
  'fact',
  'case',
  'viewpoint',
  'method',
  'preference',
  'assumption',
]);

export const knowledgeStatusSchema = z.enum(['candidate', 'confirmed', 'rejected', 'archived']);

export const knowledgeItemSchema = z.object({
  id: z.string().uuid(),
  scope: dataScopeSchema,
  scenarioId: z.string().uuid().nullable().default(null),
  kind: knowledgeKindSchema,
  title: z.string().trim().min(1).max(300),
  content: z.string().min(1),
  status: knowledgeStatusSchema,
  sourceSegmentIds: z.array(z.string().uuid()).default([]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;

export const profileAssertionSchema = z.object({
  id: z.string().uuid(),
  tier: z.enum(['confirmed-fact', 'evidenced-observation', 'pending-hypothesis']),
  statement: z.string().min(1),
  evidenceSegmentIds: z.array(z.string().uuid()).default([]),
  status: z.enum(['candidate', 'confirmed', 'rejected', 'archived']),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProfileAssertion = z.infer<typeof profileAssertionSchema>;

export const questionTypeSchema = z.enum([
  'viewpoint',
  'mechanism',
  'decision',
  'case-recall',
  'challenge',
  'pressure-probe',
]);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const questionSchema = z.object({
  id: z.string().uuid(),
  scope: dataScopeSchema,
  scenarioId: z.string().uuid().nullable().default(null),
  prompt: z.string().min(1),
  origin: z.enum(['scheduler', 'scenario-analysis', 'variation', 'user', 'import']),
  questionType: questionTypeSchema.nullable().default(null),
  exploratory: z.boolean().default(false),
  parentQuestionId: z.string().uuid().nullable().default(null),
  targetModuleIds: z.array(z.string().uuid()).default([]),
  pressure: z.enum(['none', 'timed', 'follow-up', 'interruption']).default('none'),
  createdAt: z.string().datetime({ offset: true }),
});
export type Question = z.infer<typeof questionSchema>;

export const profileSeedSchema = z.object({
  direction: z.string().trim().min(1).max(2000),
  currentWork: z.string().trim().max(4000).default(''),
  targetScenarios: z.string().trim().max(4000).default(''),
  material: z.string().max(200_000).default(''),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProfileSeed = z.infer<typeof profileSeedSchema>;

export const attemptStateSchema = z.enum([
  'QUESTION_CREATED',
  'FIRST_ATTEMPT_RECORDING',
  'FIRST_ATTEMPT_CLOSED',
  'ASSISTANCE_ALLOWED',
]);
export type AttemptState = z.infer<typeof attemptStateSchema>;

export const attemptSchema = z.object({
  id: z.string().uuid(),
  questionId: z.string().uuid(),
  round: z.enum(['first', 'second', 'variation']),
  state: attemptStateSchema,
  outcome: z.enum(['answered', 'cannot-answer', 'skipped']).nullable().default(null),
  responseText: z.string().default(''),
  recordingSourceId: z.string().uuid().nullable().default(null),
  openingDelayMs: z.number().int().nonnegative().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  hintLevel: z.enum(['none', 'L1', 'L2', 'L3', 'L4']).default('none'),
  gap: z.enum(['knowledge', 'expression']).nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Attempt = z.infer<typeof attemptSchema>;

export const diagnosticSchema = z.object({
  id: z.string().uuid(),
  attemptId: z.string().uuid(),
  dimension: z.enum(['scoping', 'viewpoint', 'structure', 'evidence', 'language']),
  finding: z.string().min(1),
  evidenceQuote: z.string().default(''),
  createdAt: z.string().datetime({ offset: true }),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const legoCategorySchema = z.enum([
  'opening',
  'scoping',
  'viewpoint',
  'reasoning',
  'evidence',
  'case',
  'interaction',
  'transition',
  'closing',
  'speech-composite',
]);

export const legoModuleStatusSchema = z.enum(['candidate', 'confirmed', 'archived']);

export const moduleDomainSchema = z.enum(['generic', 'professional']);
export type ModuleDomain = z.infer<typeof moduleDomainSchema>;

export const legoModuleSchema = z.object({
  id: z.string().uuid(),
  scope: dataScopeSchema,
  scenarioId: z.string().uuid().nullable().default(null),
  category: legoCategorySchema,
  title: z.string().trim().min(1).max(200),
  status: legoModuleStatusSchema,
  // generic / professional for global modules; scenario modules stay null
  // until the user explicitly promotes them.
  domain: moduleDomainSchema.nullable().default(null),
  triggers: z.array(z.string().min(1).max(200)).default([]),
  currentVersion: z.number().int().positive().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type LegoModule = z.infer<typeof legoModuleSchema>;

export const legoVersionPayloadSchema = z.object({
  semanticKernel: z.string().min(1),
  logicSkeleton: z.array(z.string().min(1)).min(1).max(8),
  languageShells: z.array(z.string().min(1)).min(1),
  anchorPhrase: z.string().default(''),
  slots: z.array(z.object({ name: z.string().min(1), description: z.string().default('') })).default([]),
  purpose: z.string().default(''),
  boundaries: z.string().default(''),
});
export type LegoVersionPayload = z.infer<typeof legoVersionPayloadSchema>;

export const legoVersionSchema = z.object({
  moduleId: z.string().uuid(),
  version: z.number().int().positive(),
  payload: legoVersionPayloadSchema,
  authorship: z.enum(['user-native', 'co-extracted', 'agent-candidate']),
  evidenceSegmentIds: z.array(z.string().uuid()).default([]),
  attemptIds: z.array(z.string().uuid()).default([]),
  createdAt: z.string().datetime({ offset: true }),
});
export type LegoVersion = z.infer<typeof legoVersionSchema>;

export const moduleLinkSchema = z.object({
  id: z.string().uuid(),
  fromModuleId: z.string().uuid(),
  toModuleId: z.string().uuid(),
  relation: z.enum(['composes-with', 'similar-to', 'conflicts-with', 'precedes']),
  createdAt: z.string().datetime({ offset: true }),
});
export type ModuleLink = z.infer<typeof moduleLinkSchema>;

export const masteryStageSchema = z.enum([
  'candidate',
  'confirmed',
  'visible-recall',
  'prompted-recall',
  'independent-recall',
  'transfer',
  'composition',
  'pressure',
  'real-world',
]);
export type MasteryStage = z.infer<typeof masteryStageSchema>;

export const masteryStateSchema = z.object({
  moduleId: z.string().uuid(),
  stage: masteryStageSchema,
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
  lastPracticedAt: z.string().datetime({ offset: true }).nullable().default(null),
  lastHintLevel: z.enum(['none', 'L1', 'L2', 'L3', 'L4']).default('none'),
  pressureNotes: z.string().default(''),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MasteryState = z.infer<typeof masteryStateSchema>;

export const practiceEventSchema = z.object({
  id: z.string().uuid(),
  moduleId: z.string().uuid().nullable().default(null),
  attemptId: z.string().uuid().nullable().default(null),
  kind: z.enum([
    'first-attempt',
    'second-attempt',
    'hint-issued',
    'variation-call',
    'composition-call',
    'pressure-call',
    'spaced-review',
    'real-world-report',
  ]),
  result: z.enum(['success', 'partial', 'failure', 'not-applicable']).default('not-applicable'),
  detail: z.string().default(''),
  occurredAt: z.string().datetime({ offset: true }),
});
export type PracticeEvent = z.infer<typeof practiceEventSchema>;

export const agentSessionSchema = z.object({
  id: z.string().uuid(),
  sdkSessionId: z.string().min(1),
  providerProfileId: z.string().uuid().nullable().default(null),
  purpose: z.string().max(300).default(''),
  status: z.enum(['active', 'closed', 'resumable', 'purged']),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type AgentSessionRecord = z.infer<typeof agentSessionSchema>;

export const consentEventSchema = z.object({
  id: z.string().uuid(),
  action: z.enum([
    'material-authorized',
    'recording-authorized',
    'cloud-upload',
    'formal-write',
    'scope-promotion',
    'deletion',
    'export',
  ]),
  objectRef: z.string().min(1).max(400),
  scope: dataScopeSchema,
  decision: z.enum(['granted', 'denied']),
  occurredAt: z.string().datetime({ offset: true }),
});
export type ConsentEvent = z.infer<typeof consentEventSchema>;

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(['policy', 'error', 'high-risk-action', 'lifecycle']),
  code: z.string().min(1).max(120),
  detail: z.string().max(2000).default(''),
  occurredAt: z.string().datetime({ offset: true }),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const scenarioDeletionPreviewSchema = z.object({
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
export type ScenarioDeletionPreview = z.infer<typeof scenarioDeletionPreviewSchema>;
