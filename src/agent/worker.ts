import {
  agentDiagnosticRequestSchema,
  agentIssueCommitTokenRequestSchema,
  agentRunRequestSchema,
  type AgentDiagnosticResult,
  type AgentIssueCommitTokenResult,
  type AgentWorkerRunResult,
} from './contracts';
import { createGovernanceKernel, GovernanceRepository } from './governance';
import { diagnoseAgentRuntime, runAgent, SafeAgentExecutionError } from './runtime';
import { createSessionWorkspace, openSessionWorkspace } from './workspace';
import { createSyntheticProviderExecutor } from './synthetic-provider';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('Agent worker must run as an Electron utility process.');
}
const syntheticProviderE2e = process.argv.includes('--synthetic-provider-e2e');
const syntheticProviderExecutor = syntheticProviderE2e
  ? createSyntheticProviderExecutor()
  : undefined;

async function handleMessage(value: unknown): Promise<void> {
  const runRequest = agentRunRequestSchema.safeParse(value);
  if (runRequest.success) {
    let repository: GovernanceRepository | undefined;
    try {
      const workspace = runRequest.data.workspace.create
        ? await createSessionWorkspace({
          sessionsRoot: runRequest.data.workspace.sessionsRoot,
          sessionId: runRequest.data.workspace.sessionId,
          capabilityBundlePath: runRequest.data.paths.capabilityBundlePath,
        })
        : await openSessionWorkspace({
          sessionsRoot: runRequest.data.workspace.sessionsRoot,
          sessionId: runRequest.data.workspace.sessionId,
          capabilityBundlePath: runRequest.data.paths.capabilityBundlePath,
        });
      repository = new GovernanceRepository(runRequest.data.governanceDatabasePath);
      const result = await runAgent({
        prompt: runRequest.data.prompt,
        workspace,
        paths: runRequest.data.paths,
        provider: {
          baseUrl: runRequest.data.provider.baseUrl,
          apiKey: runRequest.data.provider.apiKey,
          protocol: runRequest.data.provider.protocol,
          ...(runRequest.data.provider.model === undefined
            ? {}
            : { model: runRequest.data.provider.model }),
        },
        limits: {
          maxTurns: runRequest.data.limits.maxTurns,
          ...(runRequest.data.limits.maxBudgetUsd === undefined
            ? {}
            : { maxBudgetUsd: runRequest.data.limits.maxBudgetUsd }),
        },
        bashRuntime: runRequest.data.bashRuntime,
        ...(runRequest.data.resume === undefined ? {} : { resume: runRequest.data.resume }),
        mcpServers: createGovernanceKernel(repository),
      }, syntheticProviderExecutor === undefined
        ? {}
        : { providerExecutor: syntheticProviderExecutor });
      const response: AgentWorkerRunResult = {
        type: 'runtime:run-result',
        requestId: runRequest.data.requestId,
        ok: true,
        result: {
          workspaceSessionId: runRequest.data.workspace.sessionId,
          agentSessionId: result.sessionId,
          messages: result.messages,
        },
      };
      repository.close();
      repository = undefined;
      parentPort.postMessage(response);
    } catch (reason) {
      repository?.close();
      repository = undefined;
      const response: AgentWorkerRunResult = {
        type: 'runtime:run-result',
        requestId: runRequest.data.requestId,
        ok: false,
        error: reason instanceof SafeAgentExecutionError
          ? reason.message
          : syntheticProviderE2e && reason instanceof Error
            ? `Synthetic Agent E2E failed: ${reason.message}`
            : 'Agent execution failed.',
      };
      parentPort.postMessage(response);
    } finally {
      repository?.close();
    }
    return;
  }

  const tokenRequest = agentIssueCommitTokenRequestSchema.safeParse(value);
  if (tokenRequest.success) {
    let repository: GovernanceRepository | undefined;
    try {
      repository = new GovernanceRepository(tokenRequest.data.governanceDatabasePath);
      const confirmationToken = repository.issueConfirmationToken({
        action: 'commit',
        previewId: tokenRequest.data.previewId,
      });
      const response: AgentIssueCommitTokenResult = {
        type: 'governance:issue-commit-token-result',
        requestId: tokenRequest.data.requestId,
        ok: true,
        confirmationToken,
      };
      repository.close();
      repository = undefined;
      parentPort.postMessage(response);
    } catch {
      repository?.close();
      repository = undefined;
      const response: AgentIssueCommitTokenResult = {
        type: 'governance:issue-commit-token-result',
        requestId: tokenRequest.data.requestId,
        ok: false,
        error: 'Commit authorization failed.',
      };
      parentPort.postMessage(response);
    } finally {
      repository?.close();
    }
    return;
  }

  const parsed = agentDiagnosticRequestSchema.safeParse(value);
  if (!parsed.success) {
    const response: AgentDiagnosticResult = {
      type: 'runtime:diagnostic-result',
      requestId: 'invalid-request',
      ok: false,
      error: 'Agent worker received an invalid request.',
    };
    parentPort.postMessage(response);
    return;
  }

  try {
    const report = await diagnoseAgentRuntime({
      binaryPath: parsed.data.binaryPath,
      runtimeManifestPath: parsed.data.runtimeManifestPath,
      capabilityBundlePath: parsed.data.capabilityBundlePath,
      sandboxLauncherPath: parsed.data.sandboxLauncherPath,
      credentialVaultPath: parsed.data.credentialVaultPath,
      bashProxyPath: parsed.data.bashProxyPath,
      providerProxyPath: parsed.data.providerProxyPath,
    });
    const response: AgentDiagnosticResult = {
      type: 'runtime:diagnostic-result',
      requestId: parsed.data.requestId,
      ok: true,
      report,
    };
    parentPort.postMessage(response);
  } catch (reason) {
    const response: AgentDiagnosticResult = {
      type: 'runtime:diagnostic-result',
      requestId: parsed.data.requestId,
      ok: false,
      error: reason instanceof Error ? reason.message : 'Unknown runtime error.',
    };
    parentPort.postMessage(response);
  }
}

let requestQueue = Promise.resolve();
parentPort.on('message', (event) => {
  requestQueue = requestQueue.then(() => handleMessage(event.data));
});
