import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { GovernanceRepository } from '../agent/governance/repository';
import type { AgentRuntimePaths } from '../agent/runtime';
import type { BashRuntimeManager } from '../bash/runtime-manager';
import { loadBashRuntimeManifest } from '../bash/runtime-manifest';
import {
  providerCertificationDraftSchema,
  providerCertificationResultSchema,
  type ProviderCertificationCheck,
  type ProviderCertificationDraft,
  type ProviderCertificationResult,
} from '../shared/contracts';
import type { ProviderProtocol } from '../shared/providers';
import type { AgentWorkerHost } from './agent-worker-host';
import type { ProviderConfigurationService } from './provider-configuration';

type AgentRunner = Pick<AgentWorkerHost, 'run' | 'issueCommitToken'>;
type ProviderResolver = Pick<ProviderConfigurationService, 'resolveActive'>;

const candidateSchema = z.object({
  semantic_core: z.literal('Synthetic provider compatibility probe.'),
  logical_skeleton: z.literal('provider -> agent -> tools -> governed write'),
  language_shells: z.array(z.literal('This is a synthetic compatibility probe.')).length(1),
  retrieval_cues: z.array(z.literal('phase zero provider certification')).length(1),
});

const expectedCandidate = {
  semanticCore: 'Synthetic provider compatibility probe.',
  logicalSkeleton: 'provider -> agent -> tools -> governed write',
  languageShell: 'This is a synthetic compatibility probe.',
  scope: 'session',
} as const;

function initialChecks(protocol: ProviderProtocol): ProviderCertificationCheck[] {
  return [
    {
      id: 'streaming',
      label: protocol === 'anthropic-messages'
        ? 'Anthropic Messages 直连流式响应'
        : 'OpenAI Chat Completions 本地转换流式响应',
      status: 'passed',
    },
    { id: 'skill', label: 'Skill 发现与调用', status: 'passed' },
    { id: 'native-files', label: '原生 Read / Write / Edit', status: 'passed' },
    { id: 'bash-python', label: '隔离 Bash 与 Python 执行', status: 'passed' },
    { id: 'mcp-candidate', label: 'MCP 事件与候选写入', status: 'passed' },
    { id: 'confirmation-boundary', label: '确认前仅生成预览', status: 'passed' },
  ];
}

interface PendingCertification {
  id: string;
  root: string;
  sessionsRoot: string;
  workspaceSessionId: string;
  agentSessionId: string;
  governanceDatabasePath: string;
  previewId: string;
  providerProfileId: string;
  providerName: string;
  providerProtocol: ProviderProtocol;
  model: string;
  runtimeDirectory: string;
}

function recursivelyCollectToolNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) recursivelyCollectToolNames(item, names);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.type === 'tool_use' && typeof record.name === 'string') {
    names.add(record.name);
  }
  for (const item of Object.values(record)) recursivelyCollectToolNames(item, names);
}

export function collectToolNames(messages: unknown[]): Set<string> {
  const names = new Set<string>();
  recursivelyCollectToolNames(messages, names);
  return names;
}

export function extractCommitPreviewId(messages: unknown[]): string {
  const source = JSON.stringify(messages);
  const match = /["\\]previewId["\\]\s*:\s*["\\]([a-f0-9-]{36})/u.exec(source)
    ?? /preview_id=([a-f0-9-]{36})/u.exec(source);
  if (!match?.[1]) throw new Error('Agent did not return a governed commit preview.');
  return match[1];
}

function certificationPrompt(sessionId: string): string {
  return [
    'Run the Mental LEGOs Phase 0 synthetic provider compatibility certification.',
    'This is infrastructure validation, not a learner training attempt. Follow every step exactly.',
    '1. Invoke the lego-extraction Skill and use its instructions.',
    '2. Use Bash to copy .claude/skills/lego-extraction/scripts/validate-candidate.py to scratch/provider-certification.py.',
    '3. Use Edit to append the exact line "# provider certification adaptation" to the copied script.',
    '4. Use Write to create scratch/provider-note.txt containing exactly "synthetic provider certification".',
    '5. Use Bash to execute the copied Python validator with this JSON and write stdout to output/provider-certification.json:',
    '{"semantic_core":"Synthetic provider compatibility probe.","logical_skeleton":"provider -> agent -> tools -> governed write","language_shells":["This is a synthetic compatibility probe."],"retrieval_cues":["phase zero provider certification"],"scope":"session","provenance":"synthetic provider certification"}',
    '6. Use Read to read output/provider-certification.json.',
    `7. Call mcp__practice__record_event with session_id "${sessionId}", event_type "transfer_result", payload {"result":"synthetic-pass","source":"provider-certification"}, and idempotency_key "provider-certification-practice-v1".`,
    `8. Call mcp__artifact__submit_candidate for session_id "${sessionId}", kind "language_module", scope "session", idempotency_key "provider-certification-candidate-v1", provenance source_refs ["synthetic-provider-certification"], method "phase-zero-provider-certification", generated_by "mental-legos-agent", and the exact four-field candidate payload from step 5.`,
    '9. Call mcp__commit__prepare_commit for that candidate. Do not call commit_confirmed in this turn.',
    '10. End with exactly: MENTAL_LEGOS_CERT_READY preview_id=<the previewId returned by prepare_commit>',
  ].join('\n');
}

function confirmationPrompt(previewId: string, confirmationToken: string): string {
  return [
    'The user reviewed and confirmed the exact synthetic certification preview.',
    `MENTAL_LEGOS_CERT_COMMIT preview_id=${previewId}`,
    `confirmation_token=${confirmationToken}`,
    'Call mcp__commit__commit_confirmed exactly once with this preview, token, and empty user_edits.',
    'Then end with exactly: MENTAL_LEGOS_CERT_PASSED',
  ].join('\n');
}

export class ProviderCertificationService {
  readonly #agent: AgentRunner;
  readonly #provider: ProviderResolver;
  readonly #bashManager: BashRuntimeManager;
  readonly #paths: AgentRuntimePaths;
  readonly #manifestPath: string;
  readonly #temporaryRoot: string;
  readonly #pending = new Map<string, PendingCertification>();

  constructor(options: {
    agent: AgentRunner;
    provider: ProviderResolver;
    bashManager: BashRuntimeManager;
    paths: AgentRuntimePaths;
    manifestPath: string;
    temporaryRoot: string;
  }) {
    this.#agent = options.agent;
    this.#provider = options.provider;
    this.#bashManager = options.bashManager;
    this.#paths = options.paths;
    this.#manifestPath = path.resolve(options.manifestPath);
    this.#temporaryRoot = path.resolve(options.temporaryRoot);
  }

  async start(): Promise<ProviderCertificationDraft> {
    if (this.#pending.size > 0) {
      throw new Error('Finish or cancel the current provider certification first.');
    }
    const { profile, apiKey } = await this.#provider.resolveActive();
    const manifest = await loadBashRuntimeManifest(this.#manifestPath);
    const runtime = await this.#bashManager.inspect(manifest, true);
    if (runtime.state !== 'installed') {
      throw new Error('Install and verify the local Bash / Python runtime first.');
    }

    const id = randomUUID();
    const root = path.join(this.#temporaryRoot, `mental-legos-provider-cert-${id}`);
    const relative = path.relative(this.#temporaryRoot, root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Provider certification workspace is unsafe.');
    }
    const sessionsRoot = path.join(root, 'sessions');
    const workspaceSessionId = `cert-${id}`;
    const governanceDatabasePath = path.join(root, 'governance.sqlite');
    await mkdir(sessionsRoot, { recursive: true });

    try {
      const result = await this.#agent.run({
        prompt: certificationPrompt(workspaceSessionId),
        workspace: { sessionsRoot, sessionId: workspaceSessionId, create: true },
        paths: this.#paths,
        provider: {
          baseUrl: profile.baseUrl,
          apiKey,
          protocol: profile.protocol,
          model: profile.model,
        },
        limits: { maxTurns: 16, maxBudgetUsd: 1 },
        bashRuntime: {
          manifestPath: this.#manifestPath,
          runtimeDirectory: runtime.runtimeDirectory,
          cacheDirectory: path.join(root, 'wasmer-cache'),
        },
        governanceDatabasePath,
      });
      await this.#validateFirstStage({
        messages: result.messages,
        sessionsRoot,
        workspaceSessionId,
        governanceDatabasePath,
      });
      const previewId = extractCommitPreviewId(result.messages);
      const pending: PendingCertification = {
        id,
        root,
        sessionsRoot,
        workspaceSessionId,
        agentSessionId: result.agentSessionId,
        governanceDatabasePath,
        previewId,
        providerProfileId: profile.id,
        providerName: profile.displayName,
        providerProtocol: profile.protocol,
        model: profile.model,
        runtimeDirectory: runtime.runtimeDirectory,
      };
      this.#pending.set(id, pending);
      return providerCertificationDraftSchema.parse({
        status: 'awaiting-confirmation',
        certificationId: id,
        providerName: profile.displayName,
        model: profile.model,
        candidate: expectedCandidate,
        checks: initialChecks(profile.protocol),
      });
    } catch (reason) {
      await rm(root, { recursive: true, force: true });
      throw reason;
    }
  }

  async confirm(id: string): Promise<ProviderCertificationResult> {
    const pending = this.#pending.get(id);
    if (!pending) throw new Error('Provider certification is unavailable or expired.');
    try {
      const { profile, apiKey } = await this.#provider.resolveActive();
      if (profile.id !== pending.providerProfileId) {
        throw new Error('Provider configuration changed after the preview was created.');
      }
      const token = await this.#agent.issueCommitToken(
        pending.governanceDatabasePath,
        pending.previewId,
      );
      const result = await this.#agent.run({
        prompt: confirmationPrompt(pending.previewId, token),
        workspace: {
          sessionsRoot: pending.sessionsRoot,
          sessionId: pending.workspaceSessionId,
          create: false,
        },
        paths: this.#paths,
        provider: {
          baseUrl: profile.baseUrl,
          apiKey,
          protocol: profile.protocol,
          model: profile.model,
        },
        limits: { maxTurns: 4, maxBudgetUsd: 1 },
        bashRuntime: {
          manifestPath: this.#manifestPath,
          runtimeDirectory: pending.runtimeDirectory,
          cacheDirectory: path.join(pending.root, 'wasmer-cache'),
        },
        governanceDatabasePath: pending.governanceDatabasePath,
        resume: pending.agentSessionId,
      });
      if (result.agentSessionId !== pending.agentSessionId) {
        throw new Error('Agent did not resume the same certification session.');
      }
      if (!JSON.stringify(result.messages).includes('MENTAL_LEGOS_CERT_PASSED')) {
        throw new Error('Agent did not report certification completion.');
      }
      const repository = new GovernanceRepository(pending.governanceDatabasePath);
      try {
        if (repository.getFormalAssetCount() !== 1) {
          throw new Error('Confirmed certification did not create exactly one synthetic asset.');
        }
      } finally {
        repository.close();
      }
      return providerCertificationResultSchema.parse({
        status: 'passed',
        providerName: pending.providerName,
        model: pending.model,
        completedAt: new Date().toISOString(),
        checks: [
          ...initialChecks(pending.providerProtocol),
          { id: 'session-resume', label: '同一 Agent 会话恢复', status: 'passed' },
          { id: 'confirmed-write', label: '一次性 token 确认写入', status: 'passed' },
        ],
      });
    } finally {
      this.#pending.delete(id);
      await rm(pending.root, { recursive: true, force: true });
    }
  }

  async cancel(id: string): Promise<void> {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    await rm(pending.root, { recursive: true, force: true });
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.#pending.keys()].map((id) => this.cancel(id)));
  }

  async #validateFirstStage(options: {
    messages: unknown[];
    sessionsRoot: string;
    workspaceSessionId: string;
    governanceDatabasePath: string;
  }): Promise<void> {
    const tools = collectToolNames(options.messages);
    for (const tool of [
      'Skill',
      'Bash',
      'Edit',
      'Write',
      'Read',
      'mcp__practice__record_event',
      'mcp__artifact__submit_candidate',
      'mcp__commit__prepare_commit',
    ]) {
      if (!tools.has(tool)) throw new Error(`Provider did not complete the required ${tool} step.`);
    }
    if (tools.has('mcp__commit__commit_confirmed')) {
      throw new Error('Provider crossed the confirmation boundary before user approval.');
    }

    const workspace = path.join(options.sessionsRoot, options.workspaceSessionId);
    const [adaptedScript, note, validationSource] = await Promise.all([
      readFile(path.join(workspace, 'scratch', 'provider-certification.py'), 'utf8'),
      readFile(path.join(workspace, 'scratch', 'provider-note.txt'), 'utf8'),
      readFile(path.join(workspace, 'output', 'provider-certification.json'), 'utf8'),
    ]);
    if (!adaptedScript.includes('# provider certification adaptation')) {
      throw new Error('Provider did not complete the native Edit step.');
    }
    if (note.trim() !== 'synthetic provider certification') {
      throw new Error('Provider did not complete the native Write step exactly.');
    }
    const validation = z.object({ valid: z.literal(true) }).passthrough().parse(
      JSON.parse(validationSource) as unknown,
    );
    if (!validation.valid) throw new Error('Python candidate validation did not pass.');

    const repository = new GovernanceRepository(options.governanceDatabasePath);
    try {
      const candidates = repository.listPendingCandidates(options.workspaceSessionId);
      if (candidates.length !== 1) {
        throw new Error('Provider did not create exactly one pending synthetic candidate.');
      }
      candidateSchema.parse(candidates[0]?.payload);
      if (repository.getFormalAssetCount() !== 0) {
        throw new Error('A formal asset appeared before user confirmation.');
      }
    } finally {
      repository.close();
    }
  }
}
