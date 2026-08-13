import json
from pathlib import Path
import re
import sys


if len(sys.argv) < 2:
    raise ValueError("Pass an authorized input file path.")

file_path = Path(sys.argv[1])
raw = file_path.read_text(encoding="utf-8")
if file_path.suffix.lower() == ".json":
    parsed = json.loads(raw)
    sections = [
        {"heading": str(heading), "text": str(value)}
        for heading, value in parsed.items()
    ]
else:
    chunks = re.split(r"^#{1,6}\s+", raw, flags=re.MULTILINE)
    sections = [
        {"heading": "document" if index == 0 else f"section-{index}", "text": text.strip()}
        for index, text in enumerate(chunks)
        if text.strip()
    ]

sys.stdout.write(json.dumps({
    "source_name": file_path.name,
    "sections": sections,
}, ensure_ascii=False, separators=(",", ":")))
