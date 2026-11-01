"""Expose only public Usage-Widget allowance rows, without opening its GUI.

Credentials remain inside the existing widget fetch functions. Never include
exceptions, provider payloads, chat titles or authentication material in output.
"""
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime, timezone
import importlib.machinery
import importlib.util
import io
import json
import math
from pathlib import Path
import sys


PROVIDERS = (("claude", "Claude"), ("codex", "Codex"), ("kilo", "Kilo Code"))


def widget_module():
    folder = Path(__file__).resolve().parents[2] / "Usage-Widget"
    sys.path.insert(0, str(folder))
    loader = importlib.machinery.SourceFileLoader("monitor_usage_widget", str(folder / "usage_widget.pyw"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return value
    return None


def public_rows(rows):
    result = []
    for label, used, resets, window in rows:
        percent = number(used)
        result.append({
            "label": str(label), "percent": percent, "tokens": None,
            "resetsAt": resets.astimezone(timezone.utc).isoformat() if resets else None,
            "windowSeconds": number(window.total_seconds()) if window else None,
        })
    return result


def collect(module=None):
    # Capture accidental prints from imported modules, including future changes.
    # Captured text is discarded, never sent to the dashboard or a log file.
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        try:
            module = module or widget_module()
        except Exception:
            return {"providers": [{"id": provider, "name": name, "status": "error", "error": "Usage-Widget is unavailable on this PC", "rows": []}
                                  for provider, name in PROVIDERS]}
        providers = []
        for provider, name in PROVIDERS:
            try:
                if provider == "kilo":
                    data = module.kilo_usage.fetch(module.get_json)
                    rows = [{"label": "Tokens (7 days)", "percent": None, "tokens": number(data.get("tokens")), "resetsAt": None, "windowSeconds": 7 * 24 * 60 * 60}]
                else:
                    rows = public_rows(module.fetch_claude() if provider == "claude" else module.fetch_codex())
                providers.append({"id": provider, "name": name, "status": "ok", "error": None, "rows": rows})
            except Exception as exc:
                # Widget's friendly_error only emits fixed actionable messages.
                providers.append({"id": provider, "name": name, "status": "error", "error": module.friendly_error(name, exc), "rows": []})
        return {"providers": providers}


if __name__ == "__main__":
    payload = collect()
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, allow_nan=False))
    sys.stdout.flush()
