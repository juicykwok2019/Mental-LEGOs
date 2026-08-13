import json
import sys


candidate = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
states = {
    "confirmed_fact",
    "learner_viewpoint",
    "observation",
    "hypothesis",
    "conflicted",
    "retired",
}

errors = []
if candidate.get("state") not in states:
    errors.append("invalid assertion state")
if not str(candidate.get("claim", "")).strip():
    errors.append("claim is required")
if not isinstance(candidate.get("evidence_refs"), list) or not candidate["evidence_refs"]:
    errors.append("at least one evidence reference is required")
if not str(candidate.get("scope", "")).strip():
    errors.append("scope is required")

sys.stdout.write(json.dumps({"valid": not errors, "errors": errors}, separators=(",", ":")))
