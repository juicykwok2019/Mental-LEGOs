import json
import sys


prompts = {
    "QUESTION_CREATED": "Take a moment, then give your first unaided response.",
    "FIRST_ATTEMPT_RECORDING": "Continue with any fragments you can retrieve; what part is blocked?",
    "FIRST_ATTEMPT_CLOSED": "Your first attempt is recorded. Shall we analyze where retrieval slowed down?",
    "ASSISTANCE_ALLOWED": "Start with a process cue, and reveal more only if the learner requests it.",
}

payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
state = payload.get("state")
if state not in prompts:
    raise ValueError("A valid host attempt state is required.")

sys.stdout.write(json.dumps({"state": state, "prompt": prompts[state]}, separators=(",", ":")))
