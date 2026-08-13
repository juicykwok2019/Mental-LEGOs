# Mental LEGOs

Mental LEGOs is a local-first training system for turning personal knowledge, experience, and professional judgment into reusable spoken-language modules that can be recalled and recombined under time or evaluation pressure.

The goal is not to let AI answer on the user's behalf. It is to help the user build language that becomes genuinely available in interviews, meetings, negotiations, client conversations, professional presentations, and live Q&A.

## Status

The project is currently in product-requirements and architecture definition. There is no public release or usable application yet.

The initial product target is a single-user Windows desktop application built with Electron. Web and mobile clients are possible later extensions, not part of the first release.

## The core idea

A language LEGO is smaller than a memorized answer and more meaningful than an isolated sentence. Each module has three layers:

1. **Semantic kernel** — the judgment, fact, or idea that should remain stable.
2. **Logical skeleton** — the reusable order in which the idea is explained.
3. **Language shell** — one or more natural ways the user is comfortable saying it aloud.

Complete answers are assembled from multiple modules, for example:

```text
thinking-time module
  + question-scoping module
  + core-viewpoint module
  + evidence or personal-case module
  + limitation or objection module
  + conclusion module
= one adaptable spoken response
```

The system is question-driven rather than sentence-driven: it trains the connection between a new prompt and the knowledge, structure, and language that should be recalled.

## Training loop

```text
open question
  → first unaided voice response (including "I cannot answer yet")
  → evidence-based diagnosis
  → minimum necessary hint
  → second response
  → user-confirmed language LEGO extraction
  → changed-question and composition practice
  → spaced recall and real-world review
```

The user always attempts the first response before receiving an answer, full outline, or ready-to-read wording. Assistance is introduced gradually and withdrawn as recall improves.

## Product modes

The same training engine supports three initial modes:

- **Daily open practice** — the system asks professional questions based on confirmed knowledge, existing modules, and training history.
- **Real-scenario preparation and review** — the user creates a bounded scenario, adds authorized materials, practices likely questions, and can later review an authorized recording or transcript.
- **Professional public speaking** — the user practices an audio presentation, extracts reusable opening, argument, story, transition, conclusion, and Q&A modules, then rehearses them under changed time and audience constraints.

The first release is intended for professional spoken communication. It does not target casual chat, emotional support, long-form writing, entertainment performance, or covert real-time answer prompting during actual interviews and meetings.

## P0 product direction

- Windows-first Electron desktop application.
- Single-user and local-first; no multi-tenant SaaS backend is required for P0.
- Local SQLite and filesystem storage for structured data, materials, recordings, and derived artifacts.
- Bring your own key (BYOK) for model providers through a configurable Anthropic-compatible Base URL.
- Local speech recognition by default, with optional user-selected cloud speech services.
- Audio-based public-speaking analysis in P0; video analysis is deferred.
- User-controlled export, retention, and deletion.

## Agent architecture

The core agent runtime is required to use the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) as a complete agent loop, not as a wrapper around a single text-generation request.

The architecture follows these constraints:

- One primary agent handles normal training, material analysis, scenario preparation, retrospective review, and public-speaking practice.
- Native capabilities such as file reading and editing, Bash, code execution, Skills, MCP, hooks, permissions, and session recovery remain available inside an isolated workspace.
- Deep Research is the only planned mode that may explicitly enable temporary sub-agents.
- Product methods, rubrics, reference implementations, and adaptable scripts live in Skills.
- A small MCP governance kernel protects scoped data access, provenance, user confirmation, formal persistence, practice events, media access, export, and deletion.
- The agent may copy and adapt Skill reference code inside a session workspace, but it cannot rewrite shared production Skills, MCP services, the formal database, or credential storage at runtime.
- LangGraph, LangChain, Dify, and hand-written state graphs are not used as the core reasoning architecture.

The desktop architecture separates the Electron renderer, preload bridge, main process, agent runtime worker, local policy/data broker, and speech worker. The renderer has no direct Node.js, database, credential, Shell, or unrestricted filesystem access.

## Privacy and security direction

Professional materials, recordings, transcripts, personal profiles, and API credentials are sensitive by default.

- Product data remains on the user's device unless the user deliberately invokes an external model, speech provider, or research service.
- Cloud processing requires a clear provider disclosure and explicit user choice.
- API keys must be kept in operating-system-backed credential storage or session memory, never in the agent workspace, logs, exports, or Git.
- The agent only receives authorized copies or excerpts in a per-session workspace; it does not scan the user's computer or directly open the formal database.
- User confirmation is required before candidate facts, profile observations, or language modules become formal assets.
- Destructive actions require a preview and explicit confirmation.

## Repository privacy

This repository is maintained as if every commit may eventually become public. Personal materials, recordings, transcripts, credentials, real client data, private product research, and other confidential inputs must never be committed.

Examples and future test fixtures must use synthetic or explicitly public data. Private product documents and local user materials are kept outside Git through ignored directories.
