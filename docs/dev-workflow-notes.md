# Dev Workflow Notes (Windows)

Hard-won rules from live development sessions. Read before touching the repo
in a dev loop.

## Main-process changes require a manual Electron restart

`npm start` (Forge + Vite) rebuilds main-target bundles on save but does NOT
restart Electron. Renderer/preload changes hot-reload; anything under
`src/main/`, `src/data/`, `src/training/`, `src/agent/`, `src/asr/`, or
`src/shared/` that the main bundle imports only takes effect after killing the
Electron processes and running `npm start` again. A restart drops the
in-memory training session — warn the user first.

## Never round-trip source files through PowerShell

`Get-Content | ... | Set-Content` reads UTF-8 files as the system ANSI code
page (GBK) and destroys every non-ASCII character (this corrupted
training-session.ts once; recovered via git checkout). For batch edits use the
Edit tool or `bash` + `sed`; when PowerShell must write a file other tools
read, pass `-Encoding utf8` explicitly and never round-trip existing content.

## Renderer CSP

`index.html` allows `'unsafe-inline'` styles because Vite dev injects CSS via
`<style>` tags. The packaged build enforces the strict header CSP from
`renderer-protocol.ts` on top (header ∩ meta), so packaged security is
unchanged. Do not "fix" the meta back to `style-src 'self'` — that renders the
entire dev app unstyled.

## pdfjs in the bundled CJS main process

See `material-parsing.md`. Summary: geometry stubs must install before the
dynamic import, the worker entry import assigns `globalThis.pdfjsWorker`, and
CMaps/standard fonts resolve from node_modules in dev and extraResource in the
packaged app. Factory URLs need a trailing forward slash even on Windows.

## Provider output is hostile input

kimi (and any provider) drifts from requested JSON shapes: improvised enum
values, camelCase keys, scalars where arrays were asked. Every agent-reply
parser must normalize before strict zod validation and degrade per-item, never
fail the whole run on one malformed element. See `normalizeQuestionType` and
`normalizeLegoMaterial` for the pattern.

## UX laws from acceptance (user-mandated)

- Every action shows an explicit result notice; silent success reads as a hang.
- Every category/term gets a plain-language definition where it first appears.
- Disabled buttons use `cursor: not-allowed` and never rely on hover titles.
- Busy states show the animated indicator with elapsed + expected duration.
