---
name: profile-evidence
description: Propose evidence-linked professional-profile observations while separating confirmed facts, observations, hypotheses, and conflicts.
---

# Profile evidence

Use when repeated answers, materials, or confirmed experiences may improve the learner's professional evidence map. Do not psychoanalyze, lock the learner into a trait, infer sensitive attributes, or silently convert one answer into a fact.

Apply assertion states from [references/assertion-states.md](references/assertion-states.md). Copy [scripts/check-profile-candidate.mjs](scripts/check-profile-candidate.mjs) into `scratch/` to adapt validation for a new evidence shape.

Evidence must have stable references, source type, date, scope, and confidence. Prefer behavioral statements tied to context over identity labels. Record contradictory evidence rather than averaging it away.

Recommended routes: `context.search`, `artifact.submit_candidate` with kind `profile_observation`, and confirmed commit tools only after the learner reviews wording and evidence.

Quality output contains the assertion state, bounded claim, supporting and conflicting evidence, alternative interpretation, scope, expiry/review cue, and the user's control options.

Profile writes are never automatic. Do not store speculative diagnoses, protected/sensitive inferences, or another person's confidential information.
