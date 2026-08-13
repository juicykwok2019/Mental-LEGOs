import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GovernanceRepository } from '../../src/agent/governance';
import type { BashRuntimeManager } from '../../src/bash/runtime-manager';
import type { AgentWorkerHost } from '../../src/main/agent-worker-host';
import {
  collectToolNames,
  extractCommitPreviewId,
  ProviderCertificationService,
} from '../../src/main/provider-certification';
import type { ProviderConfigurationService } from '../../src/main/provider-configuration';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mental-legos-cert-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

const requiredToolNames = [
  'Skill',
  'Bash',
  'Edit',
  'Write',
  'Read',
  'mcp__practice__record_event',
  'mcp__artifact__submit_candidate',
  'mcp__commit__prepare_commit',
];

class SyntheticCertificationAgent {
  readonly sessionId = randomUUID();
  previewId = '';
  candidateId = '';

  async run(request: Parameters<AgentWorkerHost['run']>[0]) {
    if (request.workspace.create) {
      const workspace = path.join(
        request.workspace.sessionsRoot,
        request.workspace.sessionId,
      );
      await Promise.all([
        mkdir(path.join(workspace, 'scratch'), { recursive: true }),
        mkdir(path.join(workspace, 'output'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(workspace, 'scratch', 'provider-certification.py'),
          'print("synthetic")\n# provider certification adaptation\n',
          'utf8',
        ),
        writeFile(
          path.join(workspace, 'scratch', 'provider-note.txt'),
          'synthetic provider certification',
          'utf8',
        ),
        writeFile(
          path.join(workspace, 'output', 'provider-certification.json'),
          '{"valid":true}\n',
          'utf8',
        ),
      ]);
      const repository = new GovernanceRepository(request.governanceDatabasePath);
      try {
        repository.recordPracticeEvent({
          sessionId: request.workspace.sessionId,
          eventType: 'transfer_result',
          payload: { result: 'synthetic-pass', source: 'provider-certification' },
          idempotencyKey: 'provider-certification-practice-v1',
        });
        const candidate = repository.submitCandidate({
          sessionId: request.workspace.sessionId,
          kind: 'language_module',
          payload: {
            semantic_core: 'Synthetic provider compatibility probe.',
            logical_skeleton: 'provider -> agent -> tools -> governed write',
            language_shells: ['This is a synthetic compatibility probe.'],
            retrieval_cues: ['phase zero provider certification'],
          },
          provenance: {
            source_refs: ['synthetic-provider-certification'],
            method: 'phase-zero-provider-certification',
            generated_by: 'mental-legos-agent',
          },
          scope: 'session',
          idempotencyKey: 'provider-certification-candidate-v1',
        });
        this.candidateId = candidate.candidateId;
        this.previewId = repository.prepareCommit([candidate.candidateId]).previewId;
      } finally {
        repository.close();
      }
      return {
        workspaceSessionId: request.workspace.sessionId,
        agentSessionId: this.sessionId,
        messages: [
          ...requiredToolNames.map((name) => ({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name }] },
          })),
          { type: 'result', result: { previewId: this.previewId } },
        ],
      };
    }

    const previewId = /preview_id=([a-f0-9-]{36})/u.exec(request.prompt)?.[1];
    const token = /confirmation_token=([A-Za-z0-9_-]{32,300})/u.exec(request.prompt)?.[1];
    if (!previewId || !token) throw new Error('Synthetic confirmation prompt is invalid.');
    const repository = new GovernanceRepository(request.governanceDatabasePath);
    try {
      repository.commitConfirmed({ token, previewId, userEdits: {} });
    } finally {
      repository.close();
    }
    return {
      workspaceSessionId: request.workspace.sessionId,
      agentSessionId: this.sessionId,
      messages: [{
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__commit__commit_confirmed' },
            { type: 'text', text: 'MENTAL_LEGOS_CERT_PASSED' },
          ],
        },
      }],
    };
  }

  async issueCommitToken(databasePath: string, previewId: string): Promise<string> {
    const repository = new GovernanceRepository(databasePath);
    try {
      return repository.issueConfirmationToken({ action: 'commit', previewId });
    } finally {
      repository.close();
    }
  }
}

function createService(temporaryRoot: string, agent: SyntheticCertificationAgent) {
  const provider = {
    async resolveActive() {
      return {
        profile: {
          id: '89a8ab54-1c18-465a-9061-d21359d559ec',
          providerId: 'anthropic' as const,
          displayName: 'Synthetic provider',
          baseUrl: 'https://provider.example.test',
          model: 'synthetic-model',
          credentialReference: 'session:model:5610884e-78c3-47a8-8f55-dd627e39ad2b',
          certification: 'custom-unverified' as const,
        },
        apiKey: 'synthetic-host-only-value',
      };
    },
  } as Pick<ProviderConfigurationService, 'resolveActive'>;
  const bashManager = {
    async inspect() {
      return {
        state: 'installed' as const,
        runtimeDirectory: path.join(temporaryRoot, 'synthetic-runtime'),
        verified: true,
      };
    },
  } as unknown as BashRuntimeManager;
  return new ProviderCertificationService({
    agent,
    provider,
    bashManager,
    paths: {
      binaryPath: 'synthetic-claude.exe',
      runtimeManifestPath: 'synthetic-agent-manifest.json',
      capabilityBundlePath: 'synthetic-capability-bundle',
      sandboxLauncherPath: 'synthetic-launcher.exe',
      credentialVaultPath: 'synthetic-vault.exe',
      bashProxyPath: 'synthetic-bash.exe',
      providerProxyPath: 'synthetic-provider.exe',
    },
    manifestPath: path.resolve('resources/bash-runtime/windows-x64-wasmer-bash.json'),
    temporaryRoot,
  });
}

describe('provider certification orchestration', () => {
  it('collects nested tool calls and extracts a governed preview identifier', () => {
    const previewId = randomUUID();
    const messages = [{
      message: { content: [{ type: 'tool_use', name: 'Skill' }] },
      result: { previewId },
    }];
    expect([...collectToolNames(messages)]).toEqual(['Skill']);
    expect(extractCommitPreviewId(messages)).toBe(previewId);
  });

  it('pauses before formal write, resumes after confirmation, and purges test data', async () => {
    const root = await temporaryDirectory();
    const agent = new SyntheticCertificationAgent();
    const service = createService(root, agent);

    const draft = await service.start();
    expect(draft.status).toBe('awaiting-confirmation');
    expect(draft.candidate.scope).toBe('session');
    expect(JSON.stringify(draft)).not.toContain('synthetic-host-only-value');

    const result = await service.confirm(draft.certificationId);
    expect(result.status).toBe('passed');
    expect(result.checks.map((check) => check.id)).toContain('confirmed-write');
    expect(await readdir(root)).toEqual([]);
  });

  it('purges the pending workspace when the user cancels the preview', async () => {
    const root = await temporaryDirectory();
    const service = createService(root, new SyntheticCertificationAgent());

    const draft = await service.start();
    await service.cancel(draft.certificationId);

    expect(await readdir(root)).toEqual([]);
  });
});
