import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GovernanceRepository } from '../../src/agent/governance';
import { createGovernanceKernel } from '../../src/agent/governance';
import { runAgent, type AgentRuntimePaths } from '../../src/agent/runtime';
import { createSessionWorkspace, openSessionWorkspace } from '../../src/agent/workspace';
import { StaticDataKeyProvider } from '../../src/data/crypto';
import { ProductDatabase } from '../../src/data/product-database';
import {
  TrainingSessionService,
  type TrainingAgentRunner,
} from '../../src/main/training-session';

// Live end-to-end of the chat training loop against a real provider (Phase 1
// WP-P1-04 verification). Same gating env vars as the provider certification.

const repositoryRoot = path.resolve('.');
const baseUrl = process.env.MENTAL_LEGOS_LIVE_PROVIDER_BASE_URL;
const apiKey = process.env.MENTAL_LEGOS_LIVE_PROVIDER_KEY;
const model = process.env.MENTAL_LEGOS_LIVE_PROVIDER_MODEL;
const bashRuntimeDirectory = process.env.MENTAL_LEGOS_AGENT_LIVE_BASH_RUNTIME;

const liveProbe = process.env.MENTAL_LEGOS_LIVE_PROVIDER_E2E === '1'
  && baseUrl && apiKey && model && bashRuntimeDirectory
  ? it
  : it.skip;

function runtimePaths(): AgentRuntimePaths {
  return {
    binaryPath: path.join(
      repositoryRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe',
    ),
    runtimeManifestPath: path.join(repositoryRoot, 'resources', 'agent-runtime-manifest.json'),
    capabilityBundlePath: path.join(repositoryRoot, 'resources', 'capability-bundle'),
    sandboxLauncherPath: path.join(
      repositoryRoot, 'resources', 'windows-sandbox', 'MentalLegos.SandboxLauncher.exe',
    ),
    credentialVaultPath: path.join(
      repositoryRoot, 'resources', 'windows-sandbox', 'MentalLegos.CredentialVault.exe',
    ),
    bashProxyPath: path.join(
      repositoryRoot, 'resources', 'windows-sandbox', 'MentalLegos.BashProxy.exe',
    ),
    providerProxyPath: path.join(
      repositoryRoot, 'resources', 'windows-sandbox', 'MentalLegos.ProviderProxy.exe',
    ),
  };
}

// Mirrors the utility-process worker: one workspace and one governance staging
// database per training session, direct runAgent execution.
const inProcessRunner: TrainingAgentRunner = {
  async run(request) {
    const workspace = request.workspace.create
      ? await createSessionWorkspace({
        sessionsRoot: request.workspace.sessionsRoot,
        sessionId: request.workspace.sessionId,
        capabilityBundlePath: request.paths.capabilityBundlePath,
      })
      : await openSessionWorkspace({
        sessionsRoot: request.workspace.sessionsRoot,
        sessionId: request.workspace.sessionId,
        capabilityBundlePath: request.paths.capabilityBundlePath,
      });
    const repository = new GovernanceRepository(request.governanceDatabasePath);
    try {
      const result = await runAgent({
        prompt: request.prompt,
        workspace,
        paths: request.paths,
        provider: request.provider,
        limits: request.limits,
        bashRuntime: request.bashRuntime,
        mcpServers: createGovernanceKernel(repository),
        ...(request.resume === undefined ? {} : { resume: request.resume }),
      });
      return { agentSessionId: result.sessionId, messages: result.messages };
    } finally {
      repository.close();
    }
  },
};

describe('live chat training loop', () => {
  liveProbe(
    'completes question → gate → diagnosis → hint → second → extraction → commit',
    async () => {
      if (!baseUrl || !apiKey || !model || !bashRuntimeDirectory) return;
      const directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-live-training-'));
      const product = new ProductDatabase(
        path.join(directory, 'product.db'),
        StaticDataKeyProvider.random(),
      );
      const service = new TrainingSessionService({
        agent: inProcessRunner,
        provider: {
          resolveActive: async () => ({
            profile: { baseUrl, protocol: 'anthropic-messages', model },
            apiKey,
          }),
        },
        runtime: {
          paths: runtimePaths,
          manifestPath: () => path.join(
            repositoryRoot, 'resources', 'bash-runtime', 'windows-x64-wasmer-bash.json',
          ),
          resolveBashRuntimeDirectory: async () => bashRuntimeDirectory,
        },
        product,
        sessionsRoot: path.join(directory, 'sessions'),
      });

      try {
        const started = await service.start('跨团队沟通');
        expect(started.phase).toBe('first-attempt');
        expect(started.question?.prompt.length).toBeGreaterThan(10);
        expect(started.gate?.assistanceAllowed).toBe(false);

        const closed = await service.closeFirst({
          outcome: 'answered',
          responseText: '呃，我觉得跨团队沟通主要就是多开会对齐吧，有分歧的话就往上升级，让老板拍板。',
        });
        expect(closed.phase).toBe('first-closed');

        const diagnosed = await service.diagnose();
        expect(diagnosed.phase).toBe('assistance');
        const diagnosis = diagnosed.transcript.find((entry) => entry.kind === 'diagnosis');
        expect(diagnosis?.text.length).toBeGreaterThan(20);

        const hinted = await service.hint('L1');
        expect(hinted.transcript.some((entry) => entry.kind === 'hint')).toBe(true);

        const seconded = await service.second(
          '我认为跨团队沟通的关键不是开更多会，而是先对齐目标和约束：'
          + '第一步确认双方各自的目标和红线，第二步把分歧转化为可验证的问题，'
          + '第三步约定一个双方都接受的验证方式，实在不行才升级决策。',
        );
        expect(seconded.phase).toBe('second-done');

        const extracted = await service.extract();
        expect(extracted.phase).toBe('candidates-ready');

        if (extracted.candidates.length > 0) {
          const confirmed = await service.confirm([extracted.candidates[0]!.id]);
          expect(confirmed.phase).toBe('committed');
          expect(confirmed.committedCount).toBeGreaterThanOrEqual(1);
          const modules = product.listLegoModules({ status: 'confirmed' });
          expect(modules.length).toBeGreaterThanOrEqual(1);
          expect(product.getMasteryState(modules[0]!.id)?.dueAt).not.toBeNull();
        }
      } finally {
        product.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    1_500_000,
  );
});
