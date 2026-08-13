import json
import re
import sys


payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
text = str(payload.get("text", "")).strip()
if not text:
    raise ValueError("text is required")

markers = {
    "convergence": re.compile(r"focus|scope|收敛|范围|具体来看", re.IGNORECASE),
    "judgment": re.compile(r"I (?:think|believe)|my view|我认为|核心是", re.IGNORECASE),
    "structure": re.compile(r"first|second|finally|第一|第二|最后", re.IGNORECASE),
    "evidence": re.compile(r"for example|because|案例|例如|因为", re.IGNORECASE),
    "closure": re.compile(r"therefore|in short|所以|归根结底|总结", re.IGNORECASE),
}
signals = {name: bool(pattern.search(text)) for name, pattern in markers.items()}

sys.stdout.write(json.dumps({
    "signals": signals,
    "note": "Heuristic signals require transcript review.",
}, separators=(",", ":")))
