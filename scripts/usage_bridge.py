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
import os
from pathlib import Path
import sys
import time


PROVIDERS = (("claude", "Claude"), ("codex", "Codex"), ("kilo", "Kilo Code"))
API = "https://api.anthropic.com/api/oauth"
RATE_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP"
RATE_TTL = 24 * 60 * 60
RATE_CACHE = Path(os.environ.get("AGENT_MONITOR_DATA") or Path(__file__).resolve().parents[1] / "data") / "usage-rate.json"


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
    # The widget may append extra fields (e.g. used credits); only the first four are public.
    for label, used, resets, window, *_ in rows:
        percent = number(used)
        result.append({
            "label": str(label), "percent": percent, "tokens": None,
            "resetsAt": resets.astimezone(timezone.utc).isoformat() if resets else None,
            "windowSeconds": number(window.total_seconds()) if window else None,
        })
    return result


def exchange_rate(module):
    """Public USD->GBP reference rate (no credentials), cached for a day."""
    try:
        cached = json.loads(RATE_CACHE.read_text())
        if time.time() - cached["fetchedAt"] < RATE_TTL and number(cached["usdToGbp"]):
            return {"usdToGbp": cached["usdToGbp"], "asOf": cached["asOf"]}
    except Exception:
        cached = None
    try:
        data = module.get_json(RATE_URL, {"User-Agent": "agent-monitor"})
        rate, as_of = number(data["rates"]["GBP"]), str(data["date"])[:10]
        if not rate:
            raise ValueError
        RATE_CACHE.parent.mkdir(parents=True, exist_ok=True)
        RATE_CACHE.write_text(json.dumps({"usdToGbp": rate, "asOf": as_of, "fetchedAt": time.time()}))
        return {"usdToGbp": rate, "asOf": as_of}
    except Exception:
        # An expired cache is still a dated reference rate; better than none.
        return {"usdToGbp": cached["usdToGbp"], "asOf": cached["asOf"]} if cached else None


def prepaid_gbp(module, headers, rate):
    # Read-only endpoints used by the official Claude client for the prepaid balance.
    org = module.get_json(API + "/profile", headers)["organization"]["uuid"]
    data = module.get_json(f"{API}/organizations/{org}/prepaid/credits", headers)
    amount, currency = data.get("amount"), data.get("currency")
    if number(amount) is None or not isinstance(amount, int):
        return None
    if currency == "GBP":
        return amount / 100
    if currency == "USD" and rate and number(rate.get("usdToGbp")):
        return amount / 100 * rate["usdToGbp"]
    return None


def claude_rows(module, rate):
    # Borrow the widget's own auth headers so credentials never pass through this file's logic.
    original, seen = module.get_json, {}
    def capture(url, headers):
        seen.setdefault("headers", headers)
        return original(url, headers)
    module.get_json = capture
    try:
        rows = public_rows(module.fetch_claude())
    finally:
        module.get_json = original
    credits = None
    try:
        if "headers" in seen:
            credits = prepaid_gbp(module, seen["headers"], rate)
    except Exception:
        credits = None
    for row in rows:
        if row["label"] == "Weekly (7 days)":
            row["credits"] = credits
    return rows


def collect(module=None):
    # Capture accidental prints from imported modules, including future changes.
    # Captured text is discarded, never sent to the dashboard or a log file.
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        try:
            module = module or widget_module()
        except Exception:
            return {"providers": [{"id": provider, "name": name, "status": "error", "error": "Usage-Widget is unavailable on this PC", "rows": []}
                                  for provider, name in PROVIDERS]}
        rate = exchange_rate(module)
        providers = []
        for provider, name in PROVIDERS:
            try:
                if provider == "kilo":
                    data = module.kilo_usage.fetch(module.get_json)
                    rows = [{"label": "Tokens (7 days)", "percent": None, "tokens": number(data.get("tokens")), "resetsAt": None, "windowSeconds": 7 * 24 * 60 * 60}]
                elif provider == "claude":
                    rows = claude_rows(module, rate)
                else:
                    rows = public_rows(module.fetch_codex())
                providers.append({"id": provider, "name": name, "status": "ok", "error": None, "rows": rows})
            except Exception as exc:
                # Widget's friendly_error only emits fixed actionable messages.
                providers.append({"id": provider, "name": name, "status": "error", "error": module.friendly_error(name, exc), "rows": []})
        return {"providers": providers, "exchangeRate": rate}


if __name__ == "__main__":
    payload = collect()
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, allow_nan=False))
    sys.stdout.flush()
