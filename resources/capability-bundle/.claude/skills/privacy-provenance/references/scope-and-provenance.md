# Scope and provenance policy

Classify information by both content and context:

- Public: intentionally public and sourceable.
- Personal: about the learner but not necessarily sensitive.
- Sensitive personal: credentials, identity numbers, precise contact details, health, private recordings, or protected inferences.
- Third-party confidential: client, employer, candidate, or counterpart information not authorized for broader use.
- Secret: API keys, tokens, private keys, recovery material.

Record origin, authorized purpose, transformations, evidence references, audience, and retention. Derived text can remain sensitive even after names are removed. Never place secrets, real user material, developer machine paths, or private documents into Git, Skill files, logs, prompts beyond the authorized session, or exported diagnostics.
