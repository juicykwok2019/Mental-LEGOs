import json
import sys


payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
segments = payload.get("segments") if isinstance(payload.get("segments"), list) else []

result = []
for index, segment in enumerate(segments):
    segment = segment if isinstance(segment, dict) else {}
    start = float(segment.get("start_ms", 0))
    end = float(segment.get("end_ms", start))
    result.append({
        "ref": str(segment.get("ref", f"segment-{index + 1}")),
        "duration_ms": max(0, end - start),
        "text": str(segment.get("text", "")).strip(),
    })

sys.stdout.write(json.dumps({
    "total_ms": sum(segment["duration_ms"] for segment in result),
    "segments": result,
}, ensure_ascii=False, separators=(",", ":")))
