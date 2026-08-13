import {
  agentDiagnosticRequestSchema,
  type AgentDiagnosticResult,
} from './contracts';
import { diagnoseAgentRuntime } from './runtime';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('Agent worker must run as an Electron utility process.');
}

parentPort.on('message', (event) => {
  const parsed = agentDiagnosticRequestSchema.safeParse(event.data);
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

  void diagnoseAgentRuntime({
    binaryPath: parsed.data.binaryPath,
    runtimeManifestPath: parsed.data.runtimeManifestPath,
    capabilityBundlePath: parsed.data.capabilityBundlePath,
    sandboxLauncherPath: parsed.data.sandboxLauncherPath,
    credentialVaultPath: parsed.data.credentialVaultPath,
    bashProxyPath: parsed.data.bashProxyPath,
    providerProxyPath: parsed.data.providerProxyPath,
  }).then((report) => {
    const response: AgentDiagnosticResult = {
      type: 'runtime:diagnostic-result',
      requestId: parsed.data.requestId,
      ok: true,
      report,
    };
    parentPort.postMessage(response);
  }).catch((reason: unknown) => {
    const response: AgentDiagnosticResult = {
      type: 'runtime:diagnostic-result',
      requestId: parsed.data.requestId,
      ok: false,
      error: reason instanceof Error ? reason.message : 'Unknown runtime error.',
    };
    parentPort.postMessage(response);
  });
});
