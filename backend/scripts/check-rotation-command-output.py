"""Check actual operator-image diagnostics without displaying transient logs."""
import json
import pathlib
import sys

try:
    raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
    event = json.loads(raw)
except (OSError, ValueError):
    raise SystemExit("Operator command did not emit a safe fixed diagnostic.") from None
if event != {"status": "attention_required", "error_code": sys.argv[2]}:
    raise SystemExit("Operator command emitted an unexpected diagnostic.")
