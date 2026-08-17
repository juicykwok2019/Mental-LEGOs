# Material File Parsing: Library Selection and Local Security Review

Reviewed 2026-08-17. Scenario materials and profile seed material can be imported
from files (PDF / DOCX / TXT / MD) in addition to pasted text. This document records
the parser selection and the local-security review required by the Phase 1 plan.

## Selection

| Format | Parser | Rationale |
| --- | --- | --- |
| PDF | `pdfjs-dist` 6.2.108 (exact-pinned, bundled) | Mozilla-maintained, Apache-2.0, zero runtime dependencies, pure JS text extraction with no native code. |
| DOCX | In-house (`src/main/material-file.ts`) | A DOCX is a ZIP holding `word/document.xml`; a minimal reader over `node:zlib` avoids adding a dependency tree (mammoth and peers pull in several transitive packages). |
| TXT / MD | In-house | UTF-8 with BOM handling, UTF-16 BOM support, GB18030 fallback via the built-in `TextDecoder`. |

Legacy `.doc` (binary Word) is rejected with guidance to re-save as `.docx`.

## Local security review

- **No network access.** Parsing runs entirely in the main process on local bytes.
  `pdfjs-dist` receives a `Uint8Array`, never a URL; font loading is disabled
  (`disableFontFace: true`, `useSystemFonts: false`), so no fetches can occur.
- **No dynamic code execution.** pdfjs-dist 6.x contains no `eval` code paths
  (the former `isEvalSupported` option was removed upstream along with the paths).
- **Decompression bombs.** The DOCX reader rejects entries whose declared
  uncompressed size exceeds 64MB before inflating, and additionally caps
  `inflateRawSync` output via `maxOutputLength`.
- **Input caps.** Files over 25MB are refused; extracted text is truncated to the
  500k-character material limit with an explicit user-facing warning.
- **Encrypted PDFs** surface a friendly error instead of a password prompt; scanned
  PDFs with no text layer produce a warning suggesting paste instead.
- **Authorization flow preserved.** Parsed text is placed into the editable material
  textarea for user review; nothing is stored until the user explicitly clicks
  授权并导入. This keeps the per-item consent semantics of the paste flow.

## Attribution

`resources/licenses/MATERIAL_PARSING_NOTICES.md` ships the pdfjs attribution and
points at the shared `Apache-2.0.txt`.

## Upgrade notes

`pdfjs-dist` is a devDependency because Vite bundles it into the main-process build
(the packaged app ships no node_modules besides sherpa-onnx). Upgrades follow the
toolchain checklist in `toolchain-policy.md` at reduced scope: unit tests in
`tests/architecture/material-file.test.ts` plus a packaged smoke run.
