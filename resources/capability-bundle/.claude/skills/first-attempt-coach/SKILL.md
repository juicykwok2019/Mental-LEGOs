---
name: first-attempt-coach
description: Protect the learner's unaided first response, handle blank attempts, and choose the smallest process-only prompt without leaking answer content.
---

# First-attempt coach

Use this Skill when a question has been posed and the learner is preparing, recording, or closing their first response. Also use it when the learner says they cannot answer. Do not use it after assistance is already allowed to diagnose content, extract language modules, or write a polished answer.

The host attempt state is authoritative. Before `FIRST_ATTEMPT_CLOSED`, do not expose a target judgment, structure tailored to the answer, evidence, stored module language, or example answer. Ask for a minimal spoken attempt, which may be a sentence, fragments, or an explicit statement of where recall failed.

Evidence: attempt state, question text, elapsed preparation time, and any learner-created words already spoken. Do not request hidden context through another tool.

Choose among process prompts in [references/hint-policy.md](references/hint-policy.md). The optional [scripts/select-hint.py](scripts/select-hint.py) provides a deterministic baseline; copy it to `scratch/` before adapting it, then run the adapted copy with the sandboxed `python` command.

Recommended governance routes: `practice.record_attempt` and `practice.close_first_attempt`. Context tools may only be called within the disclosure level enforced by the host.

Quality means the learner owns the first retrieval attempt, the prompt is no more revealing than necessary, and the recorded outcome distinguishes blank, partial, and completed attempts without shaming language.

Never generate a reference answer candidate before assistance is allowed. All post-attempt coaching output remains a candidate until the learner accepts it.
