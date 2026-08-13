---
name: deep-research
description: Plan and synthesize explicit multi-source research with source quality, date, contradiction, and claim-level provenance controls.
---

# Deep research

Use only when the user explicitly requests research and the host enables network/research capability for the current session. This is the sole product mode that may be expanded to research subagents later. Do not use web access in ordinary training, scenario preparation from local materials, or to upload private inputs.

Follow [references/source-policy.md](references/source-policy.md). Copy [scripts/synthesize-evidence.py](scripts/synthesize-evidence.py) to `scratch/` when a new evidence format needs normalization, then run the adapted copy with the sandboxed `python` command.

Define the decision question, freshness requirement, geographic/product scope, forbidden disclosures, and stopping rule before searching. Prefer primary authoritative sources; retain URLs, titles, publication/update dates, retrieval dates, and claim-level support. Mark inference explicitly.

Recommended routes depend on an explicitly enabled research provider plus `artifact.submit_candidate` for a research result. Formal knowledge/profile writes require separate confirmation. The ordinary runtime must not expose network tools merely because this Skill exists.

Quality output distinguishes sourced fact, source claim, synthesis, inference, disagreement, and unknown. Include what could have changed since retrieval and where sources are incomplete.

Never send resumes, recordings, private transcripts, client material, credentials, or full personal evidence to a search or model provider unless the host has shown the exact disclosure and received consent.
