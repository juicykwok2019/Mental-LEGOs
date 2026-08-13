---
name: scenario-preparation
description: Prepare a real professional scenario from authorized materials by identifying objectives, likely questions, evidence, and language-module gaps.
---

# Scenario preparation

Use for an upcoming interview, negotiation, meeting, decision review, expert exchange, or public talk with concrete materials and stakes. Do not use for generic daily practice or to fabricate facts missing from the learner's materials.

Map materials by authority and purpose using [references/material-routing.md](references/material-routing.md). The parser in [scripts/extract-material.mjs](scripts/extract-material.mjs) is deliberately simple and adaptable; copy it into `scratch/` before adding a new input format.

Evidence: host-authorized input copies, scenario objective, counterpart/audience, constraints, and confirmed profile evidence. Mark contradictions, unknowns, and likely evaluation criteria instead of silently resolving them.

Recommended routes: `context.get_scenario_context`, `context.search`, `artifact.submit_candidate` for questions, evidence gaps, and module candidates. Formal profile or module updates require commit confirmation.

Quality output includes a concise scenario brief, prioritized question/objection map, evidence map, reusable module inventory, gaps, and practice suggestions. Probabilities must be labeled as estimates, not facts.

Do not contact third parties, upload material, or perform web research unless the user explicitly selects a research mode and approves its data boundary. Do not reveal prepared answer content before each training first attempt.
