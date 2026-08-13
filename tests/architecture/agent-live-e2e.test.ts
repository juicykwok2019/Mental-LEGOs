import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGovernanceKernel, GovernanceRepository } from '../../src/agent/governance';
import { runAgent, type AgentRunRequest } from '../../src/agent/runtime';
import { createSessionWorkspace, purgeSessionWorkspace } from '../../src/agent/workspace';
import type {
  ProviderBrokerRequest,
  ProviderBrokerResponse,
} from '../../src/provider/broker';

const repositoryRoot = path.resolve('.');
const liveRuntimeDirectory = process.env.MENTAL_LEGOS_AGENT_LIVE_BASH_RUNTIME;
const liveProbe = process.env.MENTAL_LEGOS_AGENT_LIVE_E2E === '1'
  && liveRuntimeDirectory
  ? it
  : it.skip;

async function* body(content: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(content, 'utf8');
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completionResponse(id: number, text: string): ProviderBrokerResponse {
  const stream = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_synthetic_${id}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 8 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: body(stream),
  };
}

describe('live Claude Agent SDK sandbox lifecycle', () => {
  liveProbe(
    'runs and resumes through the same-profile no-key provider proxy',
    async () => {
      if (!liveRuntimeDirectory) return;
      const sessionId = `live-${randomUUID()}`;
      const sessionsRoot = path.join(tmpdir(), `mental-legos-live-${randomUUID()}`);
      await mkdir(sessionsRoot, { recursive: false });
      const workspace = await createSessionWorkspace({
        sessionsRoot,
        sessionId,
        capabilityBundlePath: path.join(repositoryRoot, 'resources', 'capability-bundle'),
      });
      const repository = new GovernanceRepository();
      const requests: ProviderBrokerRequest[] = [];
      let messageRequestCount = 0;
      const executor = async (
        request: ProviderBrokerRequest,
      ): Promise<ProviderBrokerResponse> => {
        requests.push(request);
        if (request.path.startsWith('/v1/messages/count_tokens')) {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: body('{"input_tokens":10}'),
          };
        }
        messageRequestCount += 1;
        const isResume = request.body.includes(
          Buffer.from('Resume and return the second synthetic validation response.', 'utf8'),
        );
        return completionResponse(
          messageRequestCount,
          isResume ? 'phase-zero-live-resume' : 'phase-zero-live-one',
        );
      };
      const baseRequest: AgentRunRequest = {
        prompt: 'Return the synthetic validation response without using tools.',
        workspace,
        paths: {
          binaryPath: path.join(
            repositoryRoot,
            'node_modules',
            '@anthropic-ai',
            'claude-agent-sdk-win32-x64',
            'claude.exe',
          ),
          runtimeManifestPath: path.join(
            repositoryRoot,
            'resources',
            'agent-runtime-manifest.json',
          ),
          capabilityBundlePath: path.join(repositoryRoot, 'resources', 'capability-bundle'),
          sandboxLauncherPath: path.join(
            repositoryRoot,
            'resources',
            'windows-sandbox',
            'MentalLegos.SandboxLauncher.exe',
          ),
          credentialVaultPath: path.join(
            repositoryRoot,
            'resources',
            'windows-sandbox',
            'MentalLegos.CredentialVault.exe',
          ),
          bashProxyPath: path.join(
            repositoryRoot,
            'resources',
            'windows-sandbox',
            'MentalLegos.BashProxy.exe',
          ),
          providerProxyPath: path.join(
            repositoryRoot,
            'resources',
            'windows-sandbox',
            'MentalLegos.ProviderProxy.exe',
          ),
        },
        provider: {
          baseUrl: 'https://provider.invalid',
          apiKey: 'synthetic-host-only-key',
          model: 'claude-sonnet-4-6',
        },
        limits: { maxTurns: 2 },
        bashRuntime: {
          manifestPath: path.join(
            repositoryRoot,
            'resources',
            'bash-runtime',
            'windows-x64-wasmer-bash.json',
          ),
          runtimeDirectory: liveRuntimeDirectory,
          cacheDirectory: path.join(sessionsRoot, '.wasmer-cache'),
        },
        mcpServers: createGovernanceKernel(repository),
      };

      try {
        const first = await runAgent(baseRequest, { providerExecutor: executor });
        expect(JSON.stringify(first.messages)).toContain('phase-zero-live-one');
        const resumed = await runAgent({
          ...baseRequest,
          prompt: 'Resume and return the second synthetic validation response.',
          resume: first.sessionId,
        }, { providerExecutor: executor });
        expect(resumed.sessionId).toBe(first.sessionId);
        expect(JSON.stringify(resumed.messages)).toContain('phase-zero-live-resume');
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests.every((request) => (
          request.providerApiKey === 'synthetic-host-only-key'
          && !request.body.includes(Buffer.from(request.providerApiKey, 'utf8'))
        ))).toBe(true);
      } finally {
        repository.close();
        await purgeSessionWorkspace(sessionsRoot, sessionId);
        await rm(sessionsRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
