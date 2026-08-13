import json
import sys


payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
module_id = str(payload.get("module_id", "")).strip()
if not module_id:
    raise ValueError("module_id is required")

dimensions = payload.get("dimensions") or {
    "audience": ["executive", "peer"],
    "objective": ["explain", "defend"],
    "seconds": [30, 60],
}
matrix = [
    {
        "module_id": module_id,
        "audience": audience,
        "objective": objective,
        "seconds": seconds,
    }
    for audience in dimensions.get("audience", [])
    for objective in dimensions.get("objective", [])
    for seconds in dimensions.get("seconds", [])
]

sys.stdout.write(json.dumps({"matrix": matrix}, ensure_ascii=False, separators=(",", ":")))
