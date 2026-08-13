import type {
  ProviderBrokerRequest,
  ProviderBrokerResponse,
  ProviderExecutor,
} from '../provider/broker';

async function* body(content: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(content, 'utf8');
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completion(id: number, text: string): ProviderBrokerResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: body([
      event('message_start', {
        type: 'message_start',
        message: {
          id: `msg_packaged_e2e_${id}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 8 },
      }),
      event('message_stop', { type: 'message_stop' }),
    ].join('')),
  };
}

function toolUse(
  id: number,
  name: string,
  input: Record<string, unknown>,
): ProviderBrokerResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: body([
      event('message_start', {
        type: 'message_start',
        message: {
          id: `msg_packaged_e2e_${id}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: `toolu_packaged_e2e_${id}`,
          name,
          input: {},
        },
      }),
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(input),
        },
      }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 8 },
      }),
      event('message_stop', { type: 'message_stop' }),
    ].join('')),
  };
}

type MessagesRequest = {
  tools?: Array<{ name?: unknown }>;
  [key: string]: unknown;
};

function parseMessagesRequest(request: ProviderBrokerRequest): MessagesRequest {
  const parsed = JSON.parse(request.body.toString('utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Synthetic provider received an invalid Messages request.');
  }
  return parsed as MessagesRequest;
}

function hasTool(request: MessagesRequest, name: string): boolean {
  return request.tools?.some((candidate) => candidate.name === name) ?? false;
}

function requireTool(request: MessagesRequest, name: string): void {
  if (!hasTool(request, name)) {
    throw new Error(`Packaged E2E expected the Agent tool ${name}.`);
  }
}

function findKey(value: unknown, key: string): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return findKey(JSON.parse(trimmed) as unknown, key);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKey(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  for (const item of Object.values(record)) {
    const found = findKey(item, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function requireUuidField(request: MessagesRequest, key: string): string {
  const value = findKey(request, key);
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/u.test(value)) {
    throw new Error(`Packaged E2E did not receive ${key} from the previous tool result.`);
  }
  return value;
}

function commitAuthorization(request: ProviderBrokerRequest): {
  previewId: string;
  confirmationToken: string;
} | undefined {
  const source = request.body.toString('utf8');
  const previewId = /PACKAGED_E2E_COMMIT preview_id=([a-f0-9-]{36})/u.exec(source)?.[1];
  const confirmationToken = /confirmation_token=([A-Za-z0-9_-]{40,100})/u.exec(source)?.[1];
  return previewId && confirmationToken ? { previewId, confirmationToken } : undefined;
}

export function createSyntheticProviderExecutor(): ProviderExecutor {
  let messageCount = 0;
  let firstRunStep = 0;
  let phase: 'first-run' | 'awaiting-confirmation' | 'commit-issued' | 'complete' = 'first-run';
  return async (request: ProviderBrokerRequest): Promise<ProviderBrokerResponse> => {
    if (request.path.includes('count_tokens')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: body('{"input_tokens":10}'),
      };
    }
    messageCount += 1;
    const parsed = parseMessagesRequest(request);
    if (!parsed.tools?.length) {
      process.stdout.write('[synthetic-provider] preflight\n');
      return completion(messageCount, 'packaged-agent-preflight-ok');
    }

    if (phase === 'awaiting-confirmation') {
      const authorization = commitAuthorization(request);
      if (!authorization) {
        throw new Error('Packaged E2E resume omitted its host confirmation token.');
      }
      requireTool(parsed, 'mcp__commit__commit_confirmed');
      phase = 'commit-issued';
      process.stdout.write('[synthetic-provider] commit-confirmed\n');
      return toolUse(messageCount, 'mcp__commit__commit_confirmed', {
        confirmation_token: authorization.confirmationToken,
        preview_id: authorization.previewId,
        user_edits: {},
      });
    }

    if (phase === 'commit-issued') {
      const assetIds = findKey(parsed, 'assetIds');
      if (!Array.isArray(assetIds) || assetIds.length !== 1) {
        throw new Error('Packaged E2E commit did not return exactly one formal asset.');
      }
      phase = 'complete';
      process.stdout.write('[synthetic-provider] complete\n');
      return completion(messageCount, 'packaged-agent-resume-ok formal-asset-count=1');
    }

    if (phase === 'complete') {
      throw new Error('Packaged E2E synthetic provider received an unexpected extra turn.');
    }

    if (firstRunStep === 0) {
      requireTool(parsed, 'Skill');
      firstRunStep += 1;
      process.stdout.write('[synthetic-provider] skill\n');
      return toolUse(messageCount, 'Skill', { skill: 'lego-extraction' });
    }
    if (firstRunStep === 1) {
      if (!request.body.includes(Buffer.from('semantic core', 'utf8'))) {
        throw new Error('Packaged E2E Skill content was not returned to the Agent.');
      }
      requireTool(parsed, 'Bash');
      firstRunStep += 1;
      process.stdout.write('[synthetic-provider] bash\n');
      return toolUse(messageCount, 'Bash', {
        command: [
          'cp .claude/skills/lego-extraction/scripts/validate-candidate.py scratch/packaged-adapted.py',
          "printf '\\n# packaged E2E adaptation\\n' >> scratch/packaged-adapted.py",
          "python scratch/packaged-adapted.py '{\"semantic_core\":\"Business value depends on a closed operating loop\",\"logical_skeleton\":\"goal to mechanism to evidence\",\"language_shells\":[\"If we narrow this to the operating goal\"],\"retrieval_cues\":[\"open professional question\"],\"scope\":\"synthetic packaged test\",\"provenance\":\"synthetic packaged test\"}' > output/packaged-skill-result.json",
        ].join(' && '),
        description: 'Adapt and execute the Skill reference',
      });
    }
    if (firstRunStep === 2) {
      const source = request.body.toString('utf8');
      if (source.includes('"is_error":true') || source.includes('"isError":true')) {
        throw new Error('Packaged E2E Bash adaptation returned a tool error.');
      }
      requireTool(parsed, 'mcp__practice__record_event');
      firstRunStep += 1;
      process.stdout.write('[synthetic-provider] practice-event\n');
      return toolUse(messageCount, 'mcp__practice__record_event', {
        session_id: 'packaged-e2e-session',
        event_type: 'transfer_result',
        payload: { result: 'synthetic-pass', source: 'packaged-e2e' },
        idempotency_key: 'packaged-e2e-practice-event-v1',
      });
    }
    if (firstRunStep === 3) {
      requireUuidField(parsed, 'eventId');
      requireTool(parsed, 'mcp__artifact__submit_candidate');
      firstRunStep += 1;
      process.stdout.write('[synthetic-provider] candidate\n');
      return toolUse(messageCount, 'mcp__artifact__submit_candidate', {
        session_id: 'packaged-e2e-session',
        kind: 'language_module',
        payload: {
          semantic_core: 'Business value depends on a closed operating loop.',
          logical_skeleton: 'goal -> mechanism -> evidence',
          language_shells: ['If we narrow this to the operating goal...'],
          retrieval_cues: ['open professional question'],
        },
        provenance: {
          source_refs: ['synthetic-packaged-first-attempt'],
          method: 'packaged-e2e-synthetic-validation',
          generated_by: 'mental-legos-agent',
        },
        scope: 'session',
        idempotency_key: 'packaged-e2e-language-module-v1',
      });
    }
    if (firstRunStep === 4) {
      requireTool(parsed, 'mcp__commit__prepare_commit');
      const candidateId = requireUuidField(parsed, 'candidateId');
      firstRunStep += 1;
      process.stdout.write('[synthetic-provider] commit-preview\n');
      return toolUse(messageCount, 'mcp__commit__prepare_commit', {
        candidate_ids: [candidateId],
      });
    }

    const previewId = requireUuidField(parsed, 'previewId');
    phase = 'awaiting-confirmation';
    process.stdout.write('[synthetic-provider] awaiting-confirmation\n');
    return completion(
      messageCount,
      `packaged-agent-first-run-ok preview_id=${previewId}`,
    );
  };
}
