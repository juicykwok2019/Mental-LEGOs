import type {
  ProviderBrokerRequest,
  ProviderBrokerResponse,
  ProviderExecutor,
} from './broker';

type JsonRecord = Record<string, unknown>;

interface TranslatedRequest {
  path: '/chat/completions' | '/tokenizers/estimate-token-count';
  body: Buffer;
  model: string;
  stream: boolean;
  countTokens: boolean;
}

interface OpenAiToolState {
  id?: string;
  name?: string;
  blockIndex?: number;
  pendingArguments: string;
  stopped: boolean;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function flattenTextContent(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new Error(`${label} must contain text.`);
  return value.map((item, index) => {
    const block = record(item, `${label}[${index}]`);
    if (block.type !== 'text') throw new Error(`${label} contains an unsupported block.`);
    return stringValue(block.text, `${label}[${index}].text`);
  }).join('');
}

function convertVisibleContent(value: unknown, label: string): string | JsonRecord[] {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new Error(`${label} must be a string or content array.`);
  const output: JsonRecord[] = [];
  for (const [index, item] of value.entries()) {
    const block = record(item, `${label}[${index}]`);
    if (block.type === 'text') {
      output.push({ type: 'text', text: stringValue(block.text, `${label}[${index}].text`) });
      continue;
    }
    if (block.type === 'image') {
      const source = record(block.source, `${label}[${index}].source`);
      if (source.type !== 'base64') throw new Error(`${label} contains an unsupported image source.`);
      const mediaType = stringValue(source.media_type, `${label}[${index}].source.media_type`);
      const data = stringValue(source.data, `${label}[${index}].source.data`);
      output.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } });
      continue;
    }
    throw new Error(`${label} contains an unsupported content block.`);
  }
  return output;
}

function hasVisibleContent(content: string | JsonRecord[]): boolean {
  return typeof content === 'string' ? content.length > 0 : content.length > 0;
}

function convertUserMessage(message: JsonRecord, messageIndex: number): JsonRecord[] {
  const label = `messages[${messageIndex}].content`;
  if (typeof message.content === 'string') {
    return [{ role: 'user', content: message.content }];
  }
  if (!Array.isArray(message.content)) throw new Error(`${label} must be a string or array.`);
  const output: JsonRecord[] = [];
  let visibleBlocks: unknown[] = [];
  const flushVisible = (): void => {
    if (visibleBlocks.length === 0) return;
    const content = convertVisibleContent(visibleBlocks, label);
    if (hasVisibleContent(content)) output.push({ role: 'user', content });
    visibleBlocks = [];
  };
  for (const [blockIndex, item] of message.content.entries()) {
    const block = record(item, `${label}[${blockIndex}]`);
    if (block.type !== 'tool_result') {
      visibleBlocks.push(block);
      continue;
    }
    flushVisible();
    const toolCallId = stringValue(block.tool_use_id, `${label}[${blockIndex}].tool_use_id`);
    const content = flattenTextContent(block.content, `${label}[${blockIndex}].content`);
    output.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: block.is_error === true ? `Tool error: ${content}` : content,
    });
  }
  flushVisible();
  if (output.length === 0) throw new Error(`${label} is empty.`);
  return output;
}

function convertAssistantMessage(message: JsonRecord, messageIndex: number): JsonRecord {
  const label = `messages[${messageIndex}].content`;
  if (typeof message.content === 'string') return { role: 'assistant', content: message.content };
  if (!Array.isArray(message.content)) throw new Error(`${label} must be a string or array.`);
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: JsonRecord[] = [];
  for (const [blockIndex, item] of message.content.entries()) {
    const block = record(item, `${label}[${blockIndex}]`);
    if (block.type === 'text') {
      text.push(stringValue(block.text, `${label}[${blockIndex}].text`));
      continue;
    }
    if (block.type === 'thinking') {
      reasoning.push(stringValue(block.thinking, `${label}[${blockIndex}].thinking`));
      continue;
    }
    if (block.type === 'redacted_thinking') continue;
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: stringValue(block.id, `${label}[${blockIndex}].id`),
        type: 'function',
        function: {
          name: stringValue(block.name, `${label}[${blockIndex}].name`),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
      continue;
    }
    throw new Error(`${label} contains an unsupported assistant block.`);
  }
  return {
    role: 'assistant',
    content: text.join('') || null,
    ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning.join('') }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function convertMessages(source: JsonRecord): JsonRecord[] {
  const messages: JsonRecord[] = [];
  if (source.system !== undefined) {
    const system = flattenTextContent(source.system, 'system');
    if (system) messages.push({ role: 'system', content: system });
  }
  if (!Array.isArray(source.messages)) throw new Error('messages must be an array.');
  for (const [index, item] of source.messages.entries()) {
    const message = record(item, `messages[${index}]`);
    if (message.role === 'user') messages.push(...convertUserMessage(message, index));
    else if (message.role === 'assistant') messages.push(convertAssistantMessage(message, index));
    else throw new Error(`messages[${index}].role is unsupported.`);
  }
  if (messages.length === 0) throw new Error('messages cannot be empty.');
  return messages;
}

function convertTools(value: unknown): JsonRecord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('tools must be an array.');
  return value.map((item, index) => {
    const tool = record(item, `tools[${index}]`);
    return {
      type: 'function',
      function: {
        name: stringValue(tool.name, `tools[${index}].name`),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: record(tool.input_schema, `tools[${index}].input_schema`),
      },
    };
  });
}

function convertToolChoice(value: unknown): unknown {
  if (value === undefined) return undefined;
  const choice = record(value, 'tool_choice');
  if (choice.type === 'auto' || choice.type === 'none') return choice.type;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') {
    return {
      type: 'function',
      function: { name: stringValue(choice.name, 'tool_choice.name') },
    };
  }
  throw new Error('tool_choice.type is unsupported.');
}

function parseAnthropicBody(body: Buffer): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error('Anthropic Messages request body is invalid JSON.');
  }
  return record(value, 'request body');
}

export function translateAnthropicRequest(path: string, body: Buffer): TranslatedRequest {
  const source = parseAnthropicBody(body);
  const model = stringValue(source.model, 'model');
  const messages = convertMessages(source);
  const countTokens = path.startsWith('/v1/messages/count_tokens');
  const tools = convertTools(source.tools);
  const common = {
    model,
    messages,
    ...(tools === undefined ? {} : { tools }),
  };
  if (countTokens) {
    return {
      path: '/tokenizers/estimate-token-count',
      body: Buffer.from(JSON.stringify(common), 'utf8'),
      model,
      stream: false,
      countTokens: true,
    };
  }
  const stream = source.stream === true;
  const toolChoice = convertToolChoice(source.tool_choice);
  const requestBody = {
    ...common,
    ...(typeof source.max_tokens === 'number'
      ? { max_completion_tokens: source.max_tokens }
      : {}),
    ...(Array.isArray(source.stop_sequences) ? { stop: source.stop_sequences } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(model === 'kimi-k2.6'
      ? { thinking: { type: 'enabled', keep: 'all' } }
      : {}),
  };
  return {
    path: '/chat/completions',
    body: Buffer.from(JSON.stringify(requestBody), 'utf8'),
    model,
    stream,
    countTokens: false,
  };
}

async function readBody(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function* oneBody(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value, 'utf8');
}

function anthropicError(status: number): ProviderBrokerResponse {
  const type = status === 401 || status === 403
    ? 'authentication_error'
    : status === 429 ? 'rate_limit_error' : 'api_error';
  const message = status === 401 || status === 403
    ? 'The selected provider rejected this key. Confirm that the key belongs to the selected Kimi product.'
    : status === 429
      ? 'The selected provider rate limit or quota was reached.'
      : 'The selected provider returned an error.';
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: oneBody(JSON.stringify({ type: 'error', error: { type, message } })),
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function stopReason(value: unknown, usedTools: boolean): string {
  if (value === 'length') return 'max_tokens';
  if (value === 'content_filter') return 'refusal';
  return usedTools || value === 'tool_calls' ? 'tool_use' : 'end_turn';
}

async function* openAiSseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  let pending = '';
  for await (const chunk of body) {
    pending += Buffer.from(chunk).toString('utf8');
    while (true) {
      const boundary = /\r?\n\r?\n/u.exec(pending);
      if (!boundary || boundary.index === undefined) break;
      const event = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = event.split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  }
  if (pending.trim()) throw new Error('OpenAI stream ended with an incomplete event.');
}

function usageFrom(value: unknown): { input: number; output: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { input: 0, output: 0 };
  }
  const usage = value as JsonRecord;
  return {
    input: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    output: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
  };
}

async function* translateStreamingResponse(
  body: AsyncIterable<Uint8Array>,
  fallbackModel: string,
): AsyncGenerator<Uint8Array> {
  let messageStarted = false;
  let messageId = 'msg_openai_adapter';
  let model = fallbackModel;
  let nextBlockIndex = 0;
  let textIndex: number | undefined;
  let thinkingIndex: number | undefined;
  let completed = false;
  let usage = { input: 0, output: 0 };
  const tools = new Map<number, OpenAiToolState>();

  const startMessage = (): string[] => {
    if (messageStarted) return [];
    messageStarted = true;
    return [sse('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: 0 },
      },
    })];
  };
  const stopThinking = (): string[] => {
    if (thinkingIndex === undefined) return [];
    const index = thinkingIndex;
    thinkingIndex = undefined;
    return [
      sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: 'mental-legos-openai-adapter' },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index }),
    ];
  };
  const stopText = (): string[] => {
    if (textIndex === undefined) return [];
    const index = textIndex;
    textIndex = undefined;
    return [sse('content_block_stop', { type: 'content_block_stop', index })];
  };
  const finish = (reason: unknown): string[] => {
    if (completed) return [];
    completed = true;
    const events = [...startMessage(), ...stopThinking(), ...stopText()];
    for (const state of tools.values()) {
      if (state.blockIndex !== undefined && !state.stopped) {
        state.stopped = true;
        events.push(sse('content_block_stop', {
          type: 'content_block_stop',
          index: state.blockIndex,
        }));
      }
    }
    if (nextBlockIndex === 0) {
      events.push(
        sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      );
    }
    events.push(
      sse('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason(reason, tools.size > 0),
          stop_sequence: null,
        },
        usage: { output_tokens: usage.output },
      }),
      sse('message_stop', { type: 'message_stop' }),
    );
    return events;
  };

  for await (const data of openAiSseData(body)) {
    if (data === '[DONE]') {
      for (const event of finish('stop')) yield Buffer.from(event, 'utf8');
      continue;
    }
    const chunk = record(JSON.parse(data) as unknown, 'OpenAI stream chunk');
    messageId = optionalString(chunk.id) ?? messageId;
    model = optionalString(chunk.model) ?? model;
    usage = usageFrom(chunk.usage ?? usage);
    const events = startMessage();
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] === undefined ? undefined : record(choices[0], 'OpenAI stream choice');
    const delta = choice?.delta === undefined ? undefined : record(choice.delta, 'OpenAI stream delta');
    const reasoning = optionalString(delta?.reasoning_content);
    if (reasoning) {
      if (thinkingIndex === undefined) {
        thinkingIndex = nextBlockIndex;
        nextBlockIndex += 1;
        events.push(sse('content_block_start', {
          type: 'content_block_start',
          index: thinkingIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }));
      }
      events.push(sse('content_block_delta', {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      }));
    }
    const content = optionalString(delta?.content);
    if (content) {
      events.push(...stopThinking());
      if (textIndex === undefined) {
        textIndex = nextBlockIndex;
        nextBlockIndex += 1;
        events.push(sse('content_block_start', {
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' },
        }));
      }
      events.push(sse('content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: content },
      }));
    }
    if (Array.isArray(delta?.tool_calls)) {
      events.push(...stopThinking(), ...stopText());
      for (const item of delta.tool_calls) {
        const call = record(item, 'OpenAI tool call delta');
        const callIndex = typeof call.index === 'number' ? call.index : 0;
        const state = tools.get(callIndex) ?? { pendingArguments: '', stopped: false };
        const id = optionalString(call.id);
        if (id !== undefined) state.id = id;
        if (call.function !== undefined) {
          const fn = record(call.function, 'OpenAI tool call function delta');
          const name = optionalString(fn.name);
          if (name !== undefined) state.name = name;
          state.pendingArguments += optionalString(fn.arguments) ?? '';
        }
        if (state.blockIndex === undefined && state.id && state.name) {
          state.blockIndex = nextBlockIndex;
          nextBlockIndex += 1;
          events.push(sse('content_block_start', {
            type: 'content_block_start',
            index: state.blockIndex,
            content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
          }));
          if (state.pendingArguments) {
            events.push(sse('content_block_delta', {
              type: 'content_block_delta',
              index: state.blockIndex,
              delta: { type: 'input_json_delta', partial_json: state.pendingArguments },
            }));
            state.pendingArguments = '';
          }
        } else if (state.blockIndex !== undefined && state.pendingArguments) {
          events.push(sse('content_block_delta', {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: { type: 'input_json_delta', partial_json: state.pendingArguments },
          }));
          state.pendingArguments = '';
        }
        tools.set(callIndex, state);
      }
    }
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      for (const state of tools.values()) {
        if (state.blockIndex === undefined) {
          throw new Error('OpenAI tool call ended without an id and function name.');
        }
      }
      events.push(...finish(choice.finish_reason));
    }
    for (const event of events) yield Buffer.from(event, 'utf8');
  }
  for (const event of finish('stop')) yield Buffer.from(event, 'utf8');
}

function translateNonStreamingResponse(source: JsonRecord, fallbackModel: string): JsonRecord {
  const choices = Array.isArray(source.choices) ? source.choices : [];
  const choice = record(choices[0], 'OpenAI response choice');
  const message = record(choice.message, 'OpenAI response message');
  const content: JsonRecord[] = [];
  const reasoning = optionalString(message.reasoning_content);
  if (reasoning) {
    content.push({
      type: 'thinking',
      thinking: reasoning,
      signature: 'mental-legos-openai-adapter',
    });
  }
  const text = optionalString(message.content);
  if (text) content.push({ type: 'text', text });
  if (Array.isArray(message.tool_calls)) {
    for (const item of message.tool_calls) {
      const call = record(item, 'OpenAI response tool call');
      const fn = record(call.function, 'OpenAI response tool function');
      const argumentsSource = stringValue(fn.arguments, 'OpenAI response tool arguments');
      content.push({
        type: 'tool_use',
        id: stringValue(call.id, 'OpenAI response tool id'),
        name: stringValue(fn.name, 'OpenAI response tool name'),
        input: JSON.parse(argumentsSource) as unknown,
      });
    }
  }
  const usage = usageFrom(source.usage);
  return {
    id: optionalString(source.id) ?? 'msg_openai_adapter',
    type: 'message',
    role: 'assistant',
    model: optionalString(source.model) ?? fallbackModel,
    content,
    stop_reason: stopReason(choice.finish_reason, content.some((block) => block.type === 'tool_use')),
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

async function adaptResponse(
  translated: TranslatedRequest,
  response: ProviderBrokerResponse,
): Promise<ProviderBrokerResponse> {
  if (response.status < 200 || response.status >= 300) {
    await readBody(response.body);
    return anthropicError(response.status);
  }
  if (translated.countTokens) {
    const source = record(
      JSON.parse((await readBody(response.body)).toString('utf8')) as unknown,
      'OpenAI token response',
    );
    const data = record(source.data, 'OpenAI token response data');
    if (typeof data.total_tokens !== 'number') {
      throw new Error('OpenAI token response does not contain total_tokens.');
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: oneBody(JSON.stringify({ input_tokens: data.total_tokens })),
    };
  }
  if (translated.stream) {
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: translateStreamingResponse(response.body, translated.model),
    };
  }
  const source = record(
    JSON.parse((await readBody(response.body)).toString('utf8')) as unknown,
    'OpenAI response',
  );
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: oneBody(JSON.stringify(translateNonStreamingResponse(source, translated.model))),
  };
}

export async function executeOpenAiChatAdapter(
  request: ProviderBrokerRequest,
  executor: ProviderExecutor,
  signal: AbortSignal,
): Promise<ProviderBrokerResponse> {
  const translated = translateAnthropicRequest(request.path, request.body);
  const response = await executor({
    ...request,
    path: translated.path,
    headers: {
      accept: translated.stream ? 'text/event-stream' : 'application/json',
      'content-type': 'application/json',
      ...(request.headers['user-agent'] === undefined
        ? {}
        : { 'user-agent': request.headers['user-agent'] }),
    },
    body: translated.body,
    authScheme: 'bearer',
  }, signal);
  return adaptResponse(translated, response);
}
