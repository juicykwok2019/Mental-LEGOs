import { describe, expect, it } from 'vitest';

import {
  executeOpenAiChatAdapter,
  translateAnthropicRequest,
} from '../../src/provider/openai-chat-adapter';
import type { ProviderBrokerRequest } from '../../src/provider/broker';

async function* body(...chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
}

async function text(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function request(path: string, payload: unknown): ProviderBrokerRequest {
  return {
    method: 'POST',
    path,
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'user-agent': 'synthetic-agent-sdk',
    },
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
    providerBaseUrl: 'https://api.moonshot.cn/v1',
    providerApiKey: 'synthetic-host-only-key',
    authScheme: 'anthropic-api-key',
  };
}

describe('OpenAI Chat Completions host adapter', () => {
  it('translates system, tool history, tools and tool choice without exposing the key', () => {
    const translated = translateAnthropicRequest('/v1/messages?beta=true', request('', {
      model: 'kimi-k2.6',
      system: [{ type: 'text', text: 'Use the tools.' }],
      messages: [
        { role: 'user', content: 'Inspect the workspace.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'I should inspect it.',
              signature: 'opaque-adapter-signature',
            },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: 'scratch/note.txt' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ready' }],
        },
      ],
      tools: [{
        name: 'Read',
        description: 'Read a file.',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      }],
      tool_choice: { type: 'tool', name: 'Read' },
      max_tokens: 32_000,
      stream: true,
    }).body);

    expect(translated.path).toBe('/chat/completions');
    const source = JSON.parse(translated.body.toString('utf8')) as Record<string, unknown>;
    expect(source).toMatchObject({
      model: 'kimi-k2.6',
      max_completion_tokens: 32_000,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled', keep: 'all' },
      tool_choice: { type: 'function', function: { name: 'Read' } },
    });
    expect(source.messages).toEqual([
      { role: 'system', content: 'Use the tools.' },
      { role: 'user', content: 'Inspect the workspace.' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should inspect it.',
        tool_calls: [{
          id: 'toolu_1',
          type: 'function',
          function: {
            name: 'Read',
            arguments: '{"file_path":"scratch/note.txt"}',
          },
        }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'ready' },
    ]);
    expect(translated.body.includes(Buffer.from('synthetic-host-only-key', 'utf8'))).toBe(false);
  });

  it('maps the official Kimi token estimator response to Anthropic count_tokens', async () => {
    const invocation = request('/v1/messages/count_tokens', {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'Count me.' }],
    });
    const response = await executeOpenAiChatAdapter(invocation, async (upstream) => {
      expect(upstream.path).toBe('/tokenizers/estimate-token-count');
      expect(upstream.authScheme).toBe('bearer');
      expect(upstream.headers).not.toHaveProperty('anthropic-version');
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: body('{"data":{"total_tokens":80}}'),
      };
    }, AbortSignal.timeout(2_000));

    expect(await text(response.body)).toBe('{"input_tokens":80}');
  });

  it('converts preserved thinking, text, tool calls and usage back to Anthropic SSE', async () => {
    const invocation = request('/v1/messages', {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'Use the tool.' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      stream: true,
    });
    const response = await executeOpenAiChatAdapter(invocation, async (upstream) => {
      expect(upstream.path).toBe('/chat/completions');
      expect(upstream.authScheme).toBe('bearer');
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: body(
          'data: {"id":"cmpl_test","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"plan"},"finish_reason":null}]}\n\n',
          'data: {"id":"cmpl_test","model":"kimi-k3","choices":[{"index":0,"delta":{"content":"checking"},"finish_reason":null}]}\n\n',
          'data: {"id":"cmpl_test","model":"kimi-k3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"note.txt\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"cmpl_test","model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":9,"total_tokens":29}}\n\n',
          'data: [DONE]\n\n',
        ),
      };
    }, AbortSignal.timeout(2_000));

    const source = await text(response.body);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(source).toContain('"type":"thinking_delta","thinking":"plan"');
    expect(source).toContain('"type":"signature_delta"');
    expect(source).toContain('"type":"text_delta","text":"checking"');
    expect(source).toContain('"type":"tool_use","id":"call_1","name":"Read"');
    expect(source).toContain('"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"note.txt\\"}"');
    expect(source).toContain('"stop_reason":"tool_use"');
    expect(source).toContain('"output_tokens":9');
  });

  it('returns a safe product-mismatch authentication error without forwarding provider text', async () => {
    const invocation = request('/v1/messages', {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'Hello.' }],
      stream: true,
    });
    const response = await executeOpenAiChatAdapter(invocation, async () => ({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: body('{"error":{"message":"private upstream account detail"}}'),
    }), AbortSignal.timeout(2_000));
    const source = await text(response.body);
    expect(source).toContain('selected Kimi product');
    expect(source).not.toContain('private upstream account detail');
  });
});
