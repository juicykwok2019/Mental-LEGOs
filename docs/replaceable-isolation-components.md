# Replaceable Isolation Components

Recorded 2026-08-17.

The custom Windows isolation layer exists because Anthropic's lightweight sandbox runtime
currently documents Linux (`bubblewrap`) and macOS (`sandbox-exec`) primitives, with no
equivalent Windows offering. The components below fill that gap. They are **deliberate
temporary implementations**: each one should be replaced when an official or
better-maintained equivalent passes the same verification, and the codebase must keep
them detachable (single integration point, clear interface, no product logic inside).

| Component | Current implementation | Replace when |
| --- | --- | --- |
| `MentalLegos.SandboxLauncher` | C# AppContainer launcher | An official Anthropic Windows sandbox runtime (or equivalent Electron capability) passes the same escape-test suite |
| `MentalLegos.BashProxy` | Native Zig proxy | The official sandbox provides its own brokered Bash channel |
| Offline Bash/Python runtime | wasmer WASIX (`bash.webc`, `coreutils.webc`, `python.webc`) | An official managed code-execution path, or a lighter runtime with equal isolation |
| `MentalLegos.CredentialVault` | C# credential component | The SDK or Electron ships an equally safe official credential-injection path |

## Replacement bar

A replacement is only acceptable if, in the packaged app under a normal user account:

1. the complete escape-test suite passes unchanged (file, network, process, credential,
   and workspace boundaries all enforced by OS/host controls, not by agent cooperation);
2. no native capability regresses: Read/Write/Edit, Bash, code execution, Skills, MCP,
   hooks, and session resume keep working inside the isolated workspace;
3. binary provenance stays verifiable (versioned, hash-checked at startup).

Maintenance burden is a valid reason to *seek* a replacement, never a valid reason to
*lower* this bar.
