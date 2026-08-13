import { z } from 'zod';

export const attemptStateSchema = z.enum([
  'QUESTION_CREATED',
  'FIRST_ATTEMPT_RECORDING',
  'FIRST_ATTEMPT_CLOSED',
  'ASSISTANCE_ALLOWED',
]);
export type AttemptState = z.infer<typeof attemptStateSchema>;

export const scopeSchema = z.enum(['session', 'scenario', 'personal']);
export type DataScope = z.infer<typeof scopeSchema>;

export const candidateKindSchema = z.enum([
  'diagnosis',
  'language_module',
  'question_variant',
  'profile_observation',
  'event_review',
  'research_result',
  'reference_answer',
]);
export type CandidateKind = z.infer<typeof candidateKindSchema>;

export const provenanceSchema = z.object({
  source_refs: z.array(z.string().min(1)).max(50),
  method: z.string().min(1).max(200),
  generated_by: z.literal('mental-legos-agent'),
});

export const contextSearchInputSchema = z.object({
  query: z.string().min(1).max(200),
  scopes: z.array(scopeSchema).min(1).max(3),
  kinds: z.array(z.string().min(1).max(50)).min(1).max(10),
  limit: z.number().int().min(1).max(20).default(8),
  attempt_id: z.string().min(1).max(100).optional(),
});

export const contextExcerptInputSchema = z.object({
  ref: z.string().min(1).max(100),
  purpose: z.string().min(1).max(200),
  max_chars: z.number().int().min(1).max(4_000),
  attempt_id: z.string().min(1).max(100).optional(),
});

export const submitCandidateInputSchema = z.object({
  session_id: z.string().min(1).max(100),
  attempt_id: z.string().min(1).max(100).optional(),
  kind: candidateKindSchema,
  payload: z.record(z.string(), z.unknown()),
  provenance: provenanceSchema,
  scope: scopeSchema,
  idempotency_key: z.string().min(8).max(200),
});

export const prepareCommitInputSchema = z.object({
  candidate_ids: z.array(z.string().min(1).max(100)).min(1).max(50),
});

export const commitConfirmedInputSchema = z.object({
  confirmation_token: z.string().min(32).max(300),
  preview_id: z.string().min(1).max(100),
  user_edits: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export const recordAttemptInputSchema = z.object({
  session_id: z.string().min(1).max(100),
  attempt_id: z.string().min(1).max(100),
  question_ref: z.string().min(1).max(100),
  response: z.string().max(30_000),
  idempotency_key: z.string().min(8).max(200),
});

export const closeAttemptInputSchema = z.object({
  attempt_id: z.string().min(1).max(100),
  outcome: z.enum(['blank', 'partial', 'completed']),
  idempotency_key: z.string().min(8).max(200),
});

export const recordPracticeEventInputSchema = z.object({
  session_id: z.string().min(1).max(100),
  attempt_id: z.string().min(1).max(100).optional(),
  event_type: z.enum(['hint', 'transfer_result', 'real_world_use']),
  payload: z.record(z.string(), z.unknown()),
  idempotency_key: z.string().min(8).max(200),
});

export const transcriptInputSchema = z.object({
  transcript_id: z.string().min(1).max(100),
  start_ms: z.number().int().nonnegative().optional(),
  end_ms: z.number().int().positive().optional(),
}).refine((value) => (
  value.start_ms === undefined
  || value.end_ms === undefined
  || value.end_ms > value.start_ms
), { message: 'end_ms must be greater than start_ms' });

export const deletePreviewInputSchema = z.object({
  target_type: z.enum(['candidate', 'formal_asset', 'practice_event']),
  target_ids: z.array(z.string().min(1).max(100)).min(1).max(100),
});

export const executeDeleteInputSchema = z.object({
  preview_id: z.string().min(1).max(100),
  delete_token: z.string().min(32).max(300),
});
