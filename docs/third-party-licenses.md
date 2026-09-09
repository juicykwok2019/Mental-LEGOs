# Third-party components and distribution

What this repository publishes, what the installer redistributes, and what each
user fetches for themselves — with the evidence behind each claim.

Surveyed 2026-09-10 against v0.2.1. This is an engineering record of what the
licences say and how the product is built, not legal advice.

---

## 1. The dependency tree carries no copyleft obligation

318 packages resolved; no GPL, AGPL or LGPL anywhere in the tree.

| Licence | Packages |
|---|---|
| MIT | 251 |
| ISC | 22 |
| Apache-2.0 | 20 |
| BSD-2-Clause | 11 |
| BlueOak-1.0.0 | 6 |
| BSD-3-Clause | 4 |
| MPL-2.0 | 2 |
| Unlicense | 1 |
| "SEE LICENSE IN …" (proprietary, see §3) | 2 |

MPL-2.0 is file-level weak copyleft: modifications to those files stay MPL, and
nothing propagates to the rest of the codebase. Nothing in the tree obliges this
project to adopt any particular licence, and nothing prevents it from doing so.

Runtime dependencies:

| Package | Licence |
|---|---|
| `react`, `react-dom` | MIT |
| `zod` | MIT |
| `sherpa-onnx-node`, `sherpa-onnx-win-x64` | Apache-2.0 |
| `@anthropic-ai/claude-agent-sdk` | © Anthropic PBC, all rights reserved — see §3 |

## 2. Three tiers, deliberately separated

The awkward redistribution questions were designed out rather than argued about.

**Shipped inside the installer**

| Component | Licence | Notice shipped |
|---|---|---|
| Electron / Chromium | MIT / BSD and others | `LICENSE`, `LICENSES.chromium.html` in the packaged app |
| sherpa-onnx native runtime | Apache-2.0 | `resources/licenses/Apache-2.0.txt` |
| Claude Code binary (`claude.exe`) | Anthropic, proprietary | see §3 |
| `MentalLegos.*.exe` (sandbox launcher, credential vault, bash proxy) | this project's own code; built with Zig 0.16.0 (MIT) | `resources/licenses/ZIG_LICENSE.txt` |

**Fetched by the user, never redistributed**

| Component | Licence | Where it comes from |
|---|---|---|
| SenseVoiceSmall model weights | FunASR Model Open Source License Agreement | downloaded from the upstream publisher on explicit user action, size + SHA-256 verified |
| Sandboxed Bash runtime (incl. Wasmer 7.2.1) | see `resources/licenses/BASH_RUNTIME_NOTICES.md` | same — not in this repository, not in the installer |

**Never in this repository**

`node_modules/`, every third-party binary, and all model weights. Cloning this
repository redistributes nothing but this project's own source.

Attribution notices live in [`resources/licenses/`](../resources/licenses/).

## 3. The Claude Code binary

`@anthropic-ai/claude-agent-sdk` is the product's only agent runtime, and its
licence is `© Anthropic PBC. All rights reserved.`, governed by
[Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance).
The installer ships the CLI binary it provides — `claude.exe`, 307,186,848 bytes,
Claude Code 2.1.229 — so the terms for offering Claude Code inside a product apply.

**Shipped unmodified.** The same SHA-256 appears in three independent places:

```
5736c66be98a372d5e5e3b3598ead89ab5a9d1aca60d347fe7b561801c58376c
```

- the binary as published on npm (`@anthropic-ai/claude-agent-sdk-win32-x64`)
- the binary in the packaged application
- `resources/agent-runtime-manifest.json`, which the app verifies at startup

**How the product lines up with the stated conditions**

| Condition | How this product meets it |
|---|---|
| The binary must not be modified; built-in authentication methods must not be removed, disabled or restricted | Copied byte-for-byte from the npm package and hash-verified on every start |
| No paying for, reselling or intermediating Claude usage on an end user's behalf; each user authenticates with their own credential | BYOK throughout. Keys live in the Windows Credential Manager, never leave the machine except as the user's own request to the provider they chose. No account, no billing relationship, nothing to intermediate |
| Developers using the Agent SDK should use API-key authentication, and may not offer Claude.ai login or route requests through subscription credentials | API keys only. The same principle already excludes subscription coding keys from the provider registry — see "Provider access policy" in the README |
| Names and logos may be used to state accurately, in plain text, that a product runs Claude Code — but not in a product name, logo, or in a way implying endorsement | The product is "Mental LEGOs"; the SDK is named descriptively in documentation. The client identifier sent upstream is the honest `mental-legos/<version>` and is never disguised |

**What remains an operator decision.** Distributing a product with Claude Code
inside it is described as requiring agreement to Anthropic's Commercial Terms of
Service. That is an acceptance to make, not a property of the code, and it is not
something this document can settle.

## 4. This project's own licence

The source is public and readable. It is **not** open-source licensed: see
[`../README.md`](../README.md#许可证) — copyright is reserved, and no rights to
copy, modify, redistribute or use commercially are granted without written
permission.

Source-available and open-source are different things, and the distinction is
worth keeping straight: a reader who sees "open source" reasonably infers rights
to fork, modify and redistribute that this licence does not grant.

Adopting a permissive licence later would be unobstructed by anything in §1 — a
proprietary dependency does not prevent licensing one's own code — but anyone
forking this project would still have to meet the terms in §3 themselves.
