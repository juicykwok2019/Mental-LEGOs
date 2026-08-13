import {
  createSdkMcpServer,
  tool,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { GovernanceRepository } from './repository';
import {
  closeAttemptInputSchema,
  commitConfirmedInputSchema,
  contextExcerptInputSchema,
  contextSearchInputSchema,
  deletePreviewInputSchema,
  executeDeleteInputSchema,
  prepareCommitInputSchema,
  recordAttemptInputSchema,
  recordPracticeEventInputSchema,
  submitCandidateInputSchema,
  transcriptInputSchema,
} from './schemas';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

export const governanceToolNames = [
  'mcp__context__search',
  'mcp__context__read_excerpt',
  'mcp__artifact__submit_candidate',
  'mcp__artifact__list_pending_candidates',
  'mcp__commit__prepare_commit',
  'mcp__commit__commit_confirmed',
  'mcp__practice__record_attempt',
  'mcp__practice__close_first_attempt',
  'mcp__practice__record_event',
  'mcp__media__get_transcript',
  'mcp__media__get_timing_features',
  'mcp__lifecycle__preview_delete',
  'mcp__lifecycle__execute_delete',
] as const;

export function createGovernanceKernel(
  repository: GovernanceRepository,
): Record<string, McpServerConfig> {
  const contextServer = createSdkMcpServer({
    name: 'context',
    version: '1.0.0',
    instructions: 'Return only scoped minimum excerpts. The host first-attempt gate is authoritative.',
    tools: [
      tool(
        'search',
        'Search scoped formal context without exposing database queries or local paths.',
        contextSearchInputSchema.shape,
        async (raw) => {
          const input = contextSearchInputSchema.parse(raw);
          return result(repository.searchContext({
            query: input.query,
            scopes: input.scopes,
            kinds: input.kinds,
            limit: input.limit,
            ...(input.attempt_id === undefined ? {} : { attemptId: input.attempt_id }),
          }));
        },
      ),
      tool(
        'read_excerpt',
        'Read a bounded context excerpt by opaque reference and declared purpose.',
        contextExcerptInputSchema.shape,
        async (raw) => {
          const input = contextExcerptInputSchema.parse(raw);
          return result(repository.readContextExcerpt({
            ref: input.ref,
            purpose: input.purpose,
            maxChars: input.max_chars,
            ...(input.attempt_id === undefined ? {} : { attemptId: input.attempt_id }),
          }));
        },
      ),
    ],
  });

  const artifactServer = createSdkMcpServer({
    name: 'artifact',
    version: '1.0.0',
    instructions: 'All outputs are reviewable candidates, never formal facts or modules.',
    tools: [
      tool(
        'submit_candidate',
        'Submit one provenance-bearing candidate artifact with idempotency.',
        submitCandidateInputSchema.shape,
        async (raw) => {
          const input = submitCandidateInputSchema.parse(raw);
          return result(repository.submitCandidate({
            sessionId: input.session_id,
            ...(input.attempt_id === undefined ? {} : { attemptId: input.attempt_id }),
            kind: input.kind,
            payload: input.payload,
            provenance: input.provenance,
            scope: input.scope,
            idempotencyKey: input.idempotency_key,
          }));
        },
      ),
      tool(
        'list_pending_candidates',
        'List pending candidate artifacts for one session.',
        { session_id: z.string().min(1).max(100) },
        async ({ session_id }) => result(repository.listPendingCandidates(session_id)),
      ),
    ],
  });

  const commitServer = createSdkMcpServer({
    name: 'commit',
    version: '1.0.0',
    instructions: 'Formal writes require a host-issued, preview-bound, single-use confirmation token.',
    tools: [
      tool(
        'prepare_commit',
        'Create a review preview for pending candidates; this never confirms or writes assets.',
        prepareCommitInputSchema.shape,
        async (raw) => {
          const input = prepareCommitInputSchema.parse(raw);
          return result(repository.prepareCommit(input.candidate_ids));
        },
      ),
      tool(
        'commit_confirmed',
        'Commit exactly the preview the user confirmed with a host-issued token.',
        commitConfirmedInputSchema.shape,
        async (raw) => {
          const input = commitConfirmedInputSchema.parse(raw);
          return result(repository.commitConfirmed({
            token: input.confirmation_token,
            previewId: input.preview_id,
            userEdits: input.user_edits,
          }));
        },
      ),
    ],
  });

  const practiceServer = createSdkMcpServer({
    name: 'practice',
    version: '1.0.0',
    instructions: 'Append immutable, idempotent learning events; do not overwrite mastery claims.',
    tools: [
      tool(
        'record_attempt',
        'Record the learner-owned first response, including an explicit blank response.',
        recordAttemptInputSchema.shape,
        async (raw) => {
          const input = recordAttemptInputSchema.parse(raw);
          return result(repository.recordAttempt({
            sessionId: input.session_id,
            attemptId: input.attempt_id,
            questionRef: input.question_ref,
            response: input.response,
            idempotencyKey: input.idempotency_key,
          }));
        },
      ),
      tool(
        'close_first_attempt',
        'Close a recorded first attempt without enabling answer assistance.',
        closeAttemptInputSchema.shape,
        async (raw) => {
          const input = closeAttemptInputSchema.parse(raw);
          return result(repository.closeFirstAttempt({
            attemptId: input.attempt_id,
            outcome: input.outcome,
            idempotencyKey: input.idempotency_key,
          }));
        },
      ),
      tool(
        'record_event',
        'Append a hint, transfer result, or confirmed real-world-use event.',
        recordPracticeEventInputSchema.shape,
        async (raw) => {
          const input = recordPracticeEventInputSchema.parse(raw);
          return result(repository.recordPracticeEvent({
            sessionId: input.session_id,
            ...(input.attempt_id === undefined ? {} : { attemptId: input.attempt_id }),
            eventType: input.event_type,
            payload: input.payload,
            idempotencyKey: input.idempotency_key,
          }));
        },
      ),
    ],
  });

  const mediaServer = createSdkMcpServer({
    name: 'media',
    version: '1.0.0',
    instructions: 'Return transcript data by opaque identifier; never expose media paths or provider keys.',
    tools: [
      tool(
        'get_transcript',
        'Read bounded transcript segments from a host-authorized media record.',
        transcriptInputSchema.shape,
        async (raw) => {
          const input = transcriptInputSchema.parse(raw);
          return result(repository.getTranscript({
            transcriptId: input.transcript_id,
            ...(input.start_ms === undefined ? {} : { startMs: input.start_ms }),
            ...(input.end_ms === undefined ? {} : { endMs: input.end_ms }),
          }));
        },
      ),
      tool(
        'get_timing_features',
        'Read deterministic timing features without returning a local media path.',
        { transcript_id: z.string().min(1).max(100) },
        async ({ transcript_id }) => result(repository.getTimingFeatures(transcript_id)),
      ),
    ],
  });

  const lifecycleServer = createSdkMcpServer({
    name: 'lifecycle',
    version: '1.0.0',
    instructions: 'Destructive actions require preview and a host-issued, single-use delete token.',
    tools: [
      tool(
        'preview_delete',
        'Preview exact formal targets and impact without deleting anything.',
        deletePreviewInputSchema.shape,
        async (raw) => {
          const input = deletePreviewInputSchema.parse(raw);
          return result(repository.previewDelete({
            targetType: input.target_type,
            targetIds: input.target_ids,
          }));
        },
      ),
      tool(
        'execute_delete',
        'Delete only the preview authorized by a host-issued token.',
        executeDeleteInputSchema.shape,
        async (raw) => {
          const input = executeDeleteInputSchema.parse(raw);
          return result(repository.executeDelete({
            previewId: input.preview_id,
            token: input.delete_token,
          }));
        },
      ),
    ],
  });

  return {
    context: contextServer,
    artifact: artifactServer,
    commit: commitServer,
    practice: practiceServer,
    media: mediaServer,
    lifecycle: lifecycleServer,
  };
}
