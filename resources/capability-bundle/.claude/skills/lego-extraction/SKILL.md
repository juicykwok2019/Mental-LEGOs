---
name: lego-extraction
description: Extract reusable three-layer language LEGO candidates from the learner's own responses, evidence, and confirmed viewpoints.
---

# LEGO extraction

Use after the learner has attempted an answer and assistance is allowed, or when reviewing authorized personal materials. Do not treat an entire polished answer as one module, mine other people's language as the learner's own, or create unsupported personal claims.

Each candidate must separate semantic core, logical skeleton, and language shell. Add retrieval cues, slots, connectors, evidence links, scope, and counterexamples as described in [references/module-schema.md](references/module-schema.md). Copy [scripts/validate-candidate.py](scripts/validate-candidate.py) into `scratch/` to validate new formats or extend checks, then run the adapted copy with the sandboxed `python` command.

Evidence: learner-authored transcript spans, confirmed facts/viewpoints, and explicit provenance. If wording comes from the agent, mark it as an agent-proposed shell rather than learned language.

Recommended routes: `context.get_module_with_evidence`, `artifact.submit_candidate` with kind `language_module`, then `commit.prepare_commit` and `commit.commit_confirmed` only after user preview.

Quality means one module expresses one reusable move; it can survive a changed question; its slots are explicit; the shell sounds natural for the learner; and evidence is not fused into a universal claim. Produce multiple small candidates when content contains distinct moves.

Never promote a candidate, alter mastery, or claim ownership without confirmation. Do not reveal target module wording before the first-attempt gate opens.
