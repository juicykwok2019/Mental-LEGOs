import json
import sys


payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
claims = payload.get("claims") if isinstance(payload.get("claims"), list) else []
allowed_states = {"supported", "disputed", "inferred", "unknown"}

normalized = []
for index, claim in enumerate(claims):
    claim = claim if isinstance(claim, dict) else {}
    status = claim.get("status")
    normalized.append({
        "claim_id": str(claim.get("claim_id", f"claim-{index + 1}")),
        "text": str(claim.get("text", "")).strip(),
        "source_refs": [str(value) for value in claim.get("source_refs", [])]
        if isinstance(claim.get("source_refs"), list) else [],
        "status": status if status in allowed_states else "unknown",
        "as_of": None if claim.get("as_of") is None else str(claim["as_of"]),
    })

sys.stdout.write(json.dumps({"claims": normalized}, ensure_ascii=False, separators=(",", ":")))
