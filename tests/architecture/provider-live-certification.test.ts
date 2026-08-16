import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGovernanceKernel, GovernanceRepository } from '../../src/agent/governance';
import { runAgent, type AgentRunRequest } from '../../src/agent/runtime';
import { createSessionWorkspace, purgeSessionWorkspace } from '../../src/agent/workspace';

// Real-provider certification (WP-08 / Phase 1 §2). Runs the complete Agent
// SDK loop through the sandbox and provider proxy against a user-supplied
// endpoint. Gated on env so ordinary test runs stay offline:
//   MENTAL_LEGOS_LIVE_PROVIDER_E2E=1
//   MENTAL_LEGOS_LIVE_PROVIDER_BASE_URL=https://...
//   MENTAL_LEGOS_LIVE_PROVIDER_KEY=<user key, env only, never committed>
//   MENTAL_LEGOS_LIVE_PROVIDER_MODEL=<model id>
//   MENTAL_LEGOS_AGENT_LIVE_BASH_RUNTIME=<verified offline runtime directory>

const repositoryRoot = path.resolve('.');
const baseUrl = process.env.MENTAL_LEGOS_LIVE_PROVIDER_BASE_URL;
const apiKey = process.env.MENTAL_LEGOS_LIVE_PROVIDER_KEY;
const model = process.env.MENTAL_LEGOS_LIVE_PROVIDER_MODEL;
const bashRuntimeDirectory = process.env.MENTAL_LEGOS_AGENT_LIVE_BASH_RUNTIME;

const liveProbe = process.env.MENTAL_LEGOS_LIVE_PROVIDER_E2E === '1'
  && baseUrl && apiKey && model && bashRuntimeDirectory
  ? it
  : it.skip;

async function collectWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectWorkspaceFiles(full));
    else files.push(full);
  }
  return files;
}

describe('live provider capability certification', () => {
  liveProbe(
    'runs the full agent loop with tools, MCP, and resume against the real endpoint',
    async () => {
      if (!baseUrl || !apiKey || !model || !bashRuntimeDirectory) return;
      const sessionId = `live-cert-${randomUUID()}`;
      const sessionsRoot = path.join(tmpdir(), `mental-legos-live-cert-${randomUUID()}`);
      await mkdir(sessionsRoot, { recursive: false });
      const workspace = await createSessionWorkspace({
        sessionsRoot,
        sessionId,
        capabilityBundlePath: path.join(repositoryRoot, 'resources', 'capability-bundle'),
      });
      const repository = new GovernanceRepository();
      const marker = `CERT-${randomUUID().slice(0, 8)}`;

      const baseRequest: AgentRunRequest = {
        prompt: [
          'This is a synthetic capability certification. Perform exactly these steps:',
          `1. Write a file scratch/cert.txt containing the single line ${marker}.`,
          '2. Read the file back with the Read tool.',
          '3. Run a Bash command that prints the file content.',
          '4. Submit one candidate via the artifact MCP tool: session_id',
          `"${sessionId}", kind "research_result", scope "personal", payload`,
          `{"title":"certification note","content":"synthetic ${marker}","knowledge_kind":"fact"},`,
          'provenance {"source_refs":[],"method":"live-certification","generated_by":"mental-legos-agent"},',
          `idempotency_key "cert-${marker}".`,
          `5. Reply with the exact text: CERTIFIED ${marker}`,
        ].join(' '),
        workspace,
        paths: {
          binaryPath: path.join(
            repositoryRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64',
            'claude.exe',
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
        },
        provider: {
          baseUrl,
          apiKey,
          protocol: 'anthropic-messages',
          model,
        },
        limits: { maxTurns: 24 },
        bashRuntime: {
          manifestPath: path.join(
            repositoryRoot, 'resources', 'bash-runtime', 'windows-x64-wasmer-bash.json',
          ),
          runtimeDirectory: bashRuntimeDirectory,
          cacheDirectory: path.join(sessionsRoot, '.wasmer-cache'),
        },
        mcpServers: createGovernanceKernel(repository),
      };

      try {
        const first = await runAgent(baseRequest);
        const projectSkills = first.init.skills.filter((name) => name !== 'doctor');
        expect(projectSkills).toHaveLength(10);
        const transcript = JSON.stringify(first.messages);
        expect(transcript).toContain(`CERTIFIED ${marker}`);

        const certFile = await readFile(
          path.join(workspace.scratch, 'cert.txt'),
          'utf8',
        );
        expect(certFile).toContain(marker);

        const pending = repository.listPendingCandidates(sessionId);
        expect(pending.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(pending)).toContain(marker);

        const workspaceFiles = await collectWorkspaceFiles(workspace.root);
        for (const file of workspaceFiles) {
          const info = await stat(file);
          if (info.size > 5 * 1024 * 1024) continue;
          const content = await readFile(file, 'latin1');
          expect(content.includes(apiKey), `key leaked into ${file}`).toBe(false);
        }

        const resumed = await runAgent({
          ...baseRequest,
          prompt: `Reply with the exact text: RESUMED ${marker}. Do not use any tools.`,
          resume: first.sessionId,
        });
        expect(resumed.sessionId).toBe(first.sessionId);
        expect(JSON.stringify(resumed.messages)).toContain(`RESUMED ${marker}`);
      } finally {
        repository.close();
        await purgeSessionWorkspace(sessionsRoot, sessionId);
        await rm(sessionsRoot, { recursive: true, force: true });
      }
    },
    900_000,
  );
});
