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

export function createSyntheticProviderExecutor(): ProviderExecutor {
  let messageCount = 0;
  return async (request: ProviderBrokerRequest): Promise<ProviderBrokerResponse> => {
    if (request.path.includes('count_tokens')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: body('{"input_tokens":10}'),
      };
    }
    messageCount += 1;
    const resumed = request.body.includes(
      Buffer.from('packaged synthetic resume response', 'utf8'),
    );
    return completion(
      messageCount,
      resumed ? 'packaged-agent-resume-ok' : 'packaged-agent-first-run-ok',
    );
  };
}
