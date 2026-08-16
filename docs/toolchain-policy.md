# Toolchain Pinning Policy and Upgrade Checklist

This document records why key toolchain versions are pinned the way they are, and the
regression checklist that every toolchain or Agent SDK upgrade must pass before merging.

## Why Electron Forge is pinned to `8.0.0-alpha.10`

Reviewed 2026-08-17. Staying on the Forge 8 alpha line is a deliberate, documented
decision, not an oversight:

- The app targets Electron 43 and flips the full Electron fuse set, including
  `WasmTrapHandlers`, which requires `@electron/fuses` 2.x.
- The latest stable Forge line (7.11.x) declares a peer dependency of
  `@electron/fuses@^1.0.0` in `@electron-forge/plugin-fuses`. Downgrading Forge would
  force either a fuses downgrade (losing `WasmTrapHandlers` and weakening the packaged
  hardening) or a peer-dependency override (undermining the stability motivation).
- All Forge packages are exact-pinned to the same alpha version, so the risk is drift-free
  and reproducible.

Revisit when Forge 8 reaches a stable release: upgrade to stable 8.x and remove this
exception, running the full checklist below.

## Other accepted toolchain risks

- **`node:sqlite` is experimental** in the current Node runtime (visible as an
  `ExperimentalWarning` in test runs). Accepted for synthetic test databases. Before the
  formal product database ships, either the API has stabilized in the pinned Node/Electron
  version or the data layer moves to a stable SQLite binding; this is a tracked decision,
  not an implicit default.
- **`@anthropic-ai/claude-agent-sdk` is exact-pinned** and the packaged `claude.exe` is
  hash-verified at startup via the runtime manifest. The SDK line moves quickly; upgrades
  are routine but must go through the checklist below.

## Upgrade regression checklist

Run for any change to: Electron, Forge, Vite, the Agent SDK, `@electron/fuses`,
`sherpa-onnx`, or Node target versions.

1. `npm run check` (typecheck, lint, unit tests, architecture guard, skill-bundle hash,
   privacy scan) passes.
2. `npm run package` succeeds and `npm run probe:packaged:windows` passes against the
   fresh package.
3. Agent runtime: the SDK init message still reports the expected tool set (no subagents
   in normal mode) and discovers all bundled Skills; session resume still works
   (`tests/architecture/agent-runtime.test.ts` and the packaged tool e2e).
4. Sandbox: `npm run probe:sandbox:windows` passes; the escape suite still blocks all
   boundary violations.
5. Fuses: verify the packaged binary's fuse state matches `forge.config.ts` (no fuse
   silently reverting to defaults after an Electron/fuses bump).
6. Credential isolation: `npm run probe:credentials:windows` passes; no key material in
   logs or workspaces.
7. Record the new version tuple (Electron, Forge, SDK, claude.exe hash, Node) in the
   runtime manifest and the commit message body.

A version bump that cannot pass an item is reverted, not waived.
