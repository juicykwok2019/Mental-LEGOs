import json
import re
import sys


payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
text = str(payload.get("text", ""))
patterns = [
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("api-key-like", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("windows-user-path", re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+")),
    ("unix-user-path", re.compile(r"/(?:Users|home)/[^/\s]+")),
]

findings = [{"name": name} for name, pattern in patterns if pattern.search(text)]
sys.stdout.write(json.dumps({"safe": not findings, "findings": findings}, separators=(",", ":")))
