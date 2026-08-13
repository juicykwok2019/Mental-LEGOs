---
name: privacy-provenance
description: Classify sensitivity, verify provenance and scope, minimize disclosure, and scan candidate outputs before persistence or export.
---

# Privacy and provenance

Use whenever content is imported, combined, cited, persisted, sent to a provider, exported, or deleted. Also use when source ownership or scope is uncertain. Do not use this Skill as a substitute for host enforcement or as permission to inspect unscoped files.

Apply [references/scope-and-provenance.md](references/scope-and-provenance.md). Copy [scripts/scan-output.py](scripts/scan-output.py) into `scratch/` to add task-specific public-safe patterns, then run the adapted copy with the sandboxed `python` command; the host's privacy scanner remains authoritative for Git and formal outputs.

Evidence: host-issued scope, source reference, consent state, intended audience, retention rule, and transformation history. Unknown provenance is a finding, not a cue to invent a source.

Recommended routes: context tools for minimum excerpts, artifact tools for provenance-bearing candidates, media prepare/consent tools for cloud disclosure, and lifecycle preview tools for export/delete. Never request credentials.

Quality output identifies sensitivity, allowed purpose, minimum necessary fields, source chain, recipient boundary, retention/delete implications, and unresolved risks. Prefer redaction or a synthetic placeholder when exact content is unnecessary.

This Skill cannot approve uploads, exports, deletes, scope promotion, or formal commits. Those actions require host-issued tokens after user preview.
