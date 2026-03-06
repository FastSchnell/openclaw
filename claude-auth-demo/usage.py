"""
Claude Usage Query Demo (Python)

Extracted from src/infra/provider-usage.fetch.claude.ts
Demonstrates querying Claude usage via:
1. OAuth token -> Anthropic usage API
2. Claude.ai session key -> Web API fallback

Usage:
    ANTHROPIC_TOKEN="sk-ant-oat01-..." python usage.py
    CLAUDE_AI_SESSION_KEY="sk-ant-..." python usage.py
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error


# ============================================================
# 1. OAuth Usage API
# ============================================================


def fetch_oauth_usage(token: str) -> list[dict] | None:
    """Query usage via Anthropic OAuth API."""
    print("-> Querying Anthropic OAuth usage API...")

    req = urllib.request.Request(
        "https://api.anthropic.com/api/oauth/usage",
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "claude-auth-demo",
            "Accept": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
        },
    )

    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            return parse_usage_windows(data)
    except urllib.error.HTTPError as e:
        body = {}
        try:
            body = json.loads(e.read())
        except Exception:
            pass
        msg = body.get("error", {}).get("message", f"HTTP {e.code}")
        print(f"   OAuth usage API failed: {msg}")

        if e.code == 403 and "scope requirement user:profile" in msg:
            print("   -> Token lacks user:profile scope, try web session fallback")
        return None


# ============================================================
# 2. Claude.ai Web Session Fallback
# ============================================================


def resolve_session_key() -> str | None:
    """Resolve claude.ai session key from env vars."""
    # Direct env vars
    for var in ("CLAUDE_AI_SESSION_KEY", "CLAUDE_WEB_SESSION_KEY"):
        val = os.environ.get(var, "").strip()
        if val.startswith("sk-ant-"):
            return val

    # Extract from cookie header
    cookie = os.environ.get("CLAUDE_WEB_COOKIE", "").strip()
    if not cookie:
        return None

    cookie = re.sub(r"^cookie:\s*", "", cookie, flags=re.IGNORECASE)
    match = re.search(r"(?:^|;\s*)sessionKey=([^;\s]+)", cookie, re.IGNORECASE)
    if match:
        val = match.group(1).strip()
        if val.startswith("sk-ant-"):
            return val
    return None


def fetch_web_usage(session_key: str) -> list[dict] | None:
    """Query usage via claude.ai web API using browser session key."""
    print("-> Querying claude.ai web usage API...")

    headers = {
        "Cookie": f"sessionKey={session_key}",
        "Accept": "application/json",
    }

    # Step 1: Get org ID
    req = urllib.request.Request("https://claude.ai/api/organizations", headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            orgs = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"   Org fetch failed: HTTP {e.code}")
        return None

    org_id = (orgs[0].get("uuid") or "").strip() if orgs else ""
    if not org_id:
        print("   No organization found")
        return None
    print(f"   Organization: {orgs[0].get('name')} ({org_id})")

    # Step 2: Get usage
    req = urllib.request.Request(
        f"https://claude.ai/api/organizations/{org_id}/usage",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            return parse_usage_windows(data)
    except urllib.error.HTTPError as e:
        print(f"   Usage fetch failed: HTTP {e.code}")
        return None


# ============================================================
# Shared
# ============================================================


def parse_usage_windows(data: dict) -> list[dict]:
    windows = []

    five_hour = data.get("five_hour", {})
    if five_hour.get("utilization") is not None:
        windows.append({
            "label": "5h",
            "used_percent": max(0, min(100, five_hour["utilization"])),
            "resets_at": five_hour.get("resets_at"),
        })

    seven_day = data.get("seven_day", {})
    if seven_day.get("utilization") is not None:
        windows.append({
            "label": "Week",
            "used_percent": max(0, min(100, seven_day["utilization"])),
            "resets_at": seven_day.get("resets_at"),
        })

    model_window = data.get("seven_day_sonnet") or data.get("seven_day_opus")
    if model_window and model_window.get("utilization") is not None:
        label = "Sonnet" if data.get("seven_day_sonnet") else "Opus"
        windows.append({
            "label": label,
            "used_percent": max(0, min(100, model_window["utilization"])),
        })

    return windows


def print_usage(windows: list[dict]):
    print("\n   Usage:")
    for w in windows:
        pct = w["used_percent"]
        filled = round(pct / 5)
        bar = "\u2588" * filled + "\u2591" * (20 - filled)
        reset = ""
        if w.get("resets_at"):
            reset = f" (resets {w['resets_at']})"
        print(f"     {w['label']:<8} {bar} {pct:.1f}%{reset}")


# ============================================================
# Main
# ============================================================


def main():
    token = (
        os.environ.get("ANTHROPIC_TOKEN", "").strip()
        or os.environ.get("ANTHROPIC_OAUTH_TOKEN", "").strip()
    )

    # Try OAuth usage API first
    if token:
        windows = fetch_oauth_usage(token)
        if windows:
            print_usage(windows)
            return

    # Fallback: claude.ai web session
    session_key = resolve_session_key()
    if session_key:
        windows = fetch_web_usage(session_key)
        if windows:
            print_usage(windows)
            return

    if not token and not session_key:
        print("Set ANTHROPIC_TOKEN or CLAUDE_AI_SESSION_KEY")
        print()
        print('  ANTHROPIC_TOKEN=sk-ant-oat01-... python usage.py')
        print('  CLAUDE_AI_SESSION_KEY=sk-ant-... python usage.py')
        sys.exit(1)

    print("\nCould not fetch usage from either source.")


if __name__ == "__main__":
    main()
