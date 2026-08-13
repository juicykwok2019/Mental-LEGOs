import json
import sys


candidate = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
required = [
    "semantic_core",
    "logical_skeleton",
    "language_shells",
    "retrieval_cues",
    "scope",
    "provenance",
]

errors = [
    f"missing:{key}"
    for key in required
    if candidate.get(key) is None or candidate.get(key) == ""
]

if not isinstance(candidate.get("language_shells"), list) or not candidate["language_shells"]:
    errors.append("language_shells must be a non-empty array")

if len(str(candidate.get("semantic_core", ""))) > 280:
    errors.append("semantic_core is probably too large for one module")

sys.stdout.write(json.dumps({"valid": not errors, "errors": errors}, separators=(",", ":")))
