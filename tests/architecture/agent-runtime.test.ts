import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { diagnoseAgentRuntime, buildAgentOptions, buildMinimalAgentEnvironment } from '../../src/agent/runtime';
import { evaluateToolUse } from '../../src/agent/policy';
import { createGovernanceKernel, GovernanceRepository } from '../../src/agent/governance';
import {
  copyAuthorizedInput,
  createSessionWorkspace,
  purgeSessionWorkspace,
  verifySessionCapabilityIntegrity,
} from '../../src/agent/workspace';

const repositoryRoot = path.resolve('.');
const capabilityBundlePath = path.join(repositoryRoot, 'resources', 'capability-bundle');
const runtimeManifestPath = path.join(repositoryRoot, 'resources', 'agent-runtime-manifest.json');
const sandboxLauncherPath = path.join(
  repositoryRoot,
  'resources',
  'windows-sandbox',
  'MentalLegos.SandboxLauncher.exe',
);
const binaryPath = path.join(
  repositoryRoot,
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk-win32-x64',
  'claude.exe',
);

describe('Claude Agent SDK runtime boundary', () => {
  it('verifies the pinned SDK binary and all ten Skills', async () => {
    const report = await diagnoseAgentRuntime({
      binaryPath,
      runtimeManifestPath,
      capabilityBundlePath,
      sandboxLauncherPath,
    });

    expect(report).toMatchObject({
      agentSdkVersion: '0.3.229',
      claudeCodeVersion: '2.1.229',
      subagentsEnabled: false,
    });
    expect(report.skills).toHaveLength(10);
    expect(report.tools).toEqual(expect.arrayContaining([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill',
    ]));
  });

  it('constructs an isolated workspace and enforces native tool paths', async () => {
    const sessionId = `test-${randomUUID()}`;
    const sessionsRoot = path.join(repositoryRoot, '.private', 'runtime-tests');
    await mkdir(sessionsRoot, { recursive: true });
    const workspace = await createSessionWorkspace({
      sessionsRoot,
      sessionId,
      capabilityBundlePath,
    });
    try {
      await copyAuthorizedInput({
        workspace,
        logicalName: 'synthetic-question.txt',
        content: 'Synthetic, public-safe question.',
      });
      await verifySessionCapabilityIntegrity(workspace);

      expect(evaluateToolUse('Read', { file_path: 'input/synthetic-question.txt' }, workspace))
        .toEqual({ behavior: 'allow' });
      expect(evaluateToolUse('Write', { file_path: 'scratch/adapted.mjs' }, workspace))
        .toEqual({ behavior: 'allow' });
      expect(evaluateToolUse('Write', { file_path: 'CLAUDE.md' }, workspace))
        .toMatchObject({ behavior: 'deny' });
      expect(evaluateToolUse('Read', { file_path: 'C:\\Outside\\secret.txt' }, workspace))
        .toMatchObject({ behavior: 'deny' });
      expect(evaluateToolUse('Bash', { command: 'node scratch/adapted.mjs' }, workspace))
        .toEqual({ behavior: 'allow' });
      expect(evaluateToolUse('Bash', { command: 'node -e "console.log(process.env)"' }, workspace))
        .toMatchObject({ behavior: 'deny' });
      expect(evaluateToolUse('mcp__commit__commit_confirmed', {}, workspace))
        .toMatchObject({ behavior: 'ask' });
    } finally {
      await purgeSessionWorkspace(sessionsRoot, sessionId);
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('uses project-only SDK settings and excludes ordinary subagent/network tools', async () => {
    const sessionId = `test-${randomUUID()}`;
    const sessionsRoot = path.join(repositoryRoot, '.private', 'runtime-options-tests');
    await mkdir(sessionsRoot, { recursive: true });
    const workspace = await createSessionWorkspace({
      sessionsRoot,
      sessionId,
      capabilityBundlePath,
    });
    const governanceRepository = new GovernanceRepository();

    try {
      const options = buildAgentOptions({
        prompt: 'Synthetic runtime option test.',
        workspace,
        paths: {
          binaryPath,
          runtimeManifestPath,
          capabilityBundlePath,
          sandboxLauncherPath,
        },
        provider: {
          baseUrl: 'https://provider.invalid/anthropic',
          apiKey: 'synthetic-test-value',
          model: 'synthetic-model',
        },
        limits: { maxTurns: 4, maxBudgetUsd: 0.1 },
        mcpServers: createGovernanceKernel(governanceRepository),
      });

      expect(options.settingSources).toEqual(['project']);
      expect(options.strictMcpConfig).toBe(true);
      expect(options.permissionMode).toBe('default');
      expect(options.skills).toHaveLength(10);
      expect(options.tools).not.toContain('Agent');
      expect(options.disallowedTools).toEqual(expect.arrayContaining([
        'Agent', 'Task', 'WebSearch', 'WebFetch',
      ]));
      expect(options.allowedTools).toEqual([]);
      expect(options.spawnClaudeCodeProcess).toBeTypeOf('function');
    } finally {
      governanceRepository.close();
      await purgeSessionWorkspace(sessionsRoot, sessionId);
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('does not inherit arbitrary host environment variables', () => {
    const environment = buildMinimalAgentEnvironment({
      provider: {
        baseUrl: 'https://provider.invalid/anthropic',
        apiKey: 'synthetic-test-value',
      },
      configDirectory: 'C:\\runtime\\config',
      sourceEnvironment: {
        SYSTEMROOT: 'C:\\Windows',
        PATH: 'C:\\Windows\\System32',
        MENTAL_LEGOS_UNRELATED_SECRET: 'must-not-cross-boundary',
      },
    });

    expect(environment.SYSTEMROOT).toBe('C:\\Windows');
    expect(environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(environment.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe('1');
    expect(environment.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe('1');
    expect(environment).not.toHaveProperty('MENTAL_LEGOS_UNRELATED_SECRET');
  });
});
