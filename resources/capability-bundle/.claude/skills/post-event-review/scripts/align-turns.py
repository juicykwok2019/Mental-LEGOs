import json
import sys


payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
turns = payload.get("turns") if isinstance(payload.get("turns"), list) else []

normalized = []
for index, turn in enumerate(turns):
    turn = turn if isinstance(turn, dict) else {}
    text = str(turn.get("text", "")).strip()
    if not text:
        continue
    start = float(turn.get("start_ms", 0))
    normalized.append({
        "ref": str(turn.get("ref", f"turn-{index + 1}")),
        "speaker": str(turn.get("speaker", "unknown")),
        "start_ms": start,
        "end_ms": float(turn.get("end_ms", start)),
        "text": text,
    })

normalized.sort(key=lambda turn: turn["start_ms"])
sys.stdout.write(json.dumps({"turns": normalized}, ensure_ascii=False, separators=(",", ":")))
