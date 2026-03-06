"""
Claude Auth + Messages API Minimal Demo (Python)

Extracted from OpenClaw's auth logic. Demonstrates:
1. Setup token (sk-ant-oat01-*) auth via Bearer + beta headers
2. API key (sk-ant-api03-*) auth via x-api-key header
3. Calling Anthropic Messages API (non-streaming + streaming)

Usage:
    ANTHROPIC_TOKEN="sk-ant-oat01-..." python demo.py
    ANTHROPIC_API_KEY="sk-ant-api03-..." python demo.py
    ANTHROPIC_TOKEN="sk-ant-oat01-..." MODEL=opus python demo.py "your prompt"
"""

import json
import os
import sys
import urllib.request
import urllib.error

# ============================================================
# 1. Token Validation (from src/commands/auth-token.ts)
# ============================================================

SETUP_TOKEN_PREFIX = "sk-ant-oat01-"
SETUP_TOKEN_MIN_LENGTH = 80

ANTHROPIC_BASE_URL = "https://api.anthropic.com"


def validate_setup_token(token: str) -> str | None:
    """Validate a Claude setup-token. Returns error message or None if valid."""
    token = token.strip()
    if not token:
        return "Token is required"
    if not token.startswith(SETUP_TOKEN_PREFIX):
        return f"Expected token starting with {SETUP_TOKEN_PREFIX}"
    if len(token) < SETUP_TOKEN_MIN_LENGTH:
        return "Token looks too short; paste the full setup-token"
    return None


def is_oauth_token(token: str) -> bool:
    return "sk-ant-oat" in token


# ============================================================
# 2. Auth Header Construction
#    (from src/agents/pi-embedded-runner/extra-params.ts)
# ============================================================

# OAuth tokens (sk-ant-oat-*) require these beta headers.
# Without "oauth-2025-04-20", API returns 401.
OAUTH_REQUIRED_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "fine-grained-tool-streaming-2025-05-14",
    "interleaved-thinking-2025-05-14",
]

API_KEY_BETAS = [
    "fine-grained-tool-streaming-2025-05-14",
    "interleaved-thinking-2025-05-14",
]


def build_auth_headers(token: str) -> dict[str, str]:
    headers = {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    if is_oauth_token(token):
        # OAuth/setup-token: Bearer auth + required beta headers
        headers["authorization"] = f"Bearer {token}"
        headers["anthropic-beta"] = ",".join(OAUTH_REQUIRED_BETAS)
    else:
        # Standard API key: x-api-key header
        headers["x-api-key"] = token
        headers["anthropic-beta"] = ",".join(API_KEY_BETAS)

    return headers


# ============================================================
# 3. Model Aliases (from src/agents/model-selection.ts)
# ============================================================

MODEL_ALIASES = {
    "opus": "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "opus-4.5": "claude-opus-4-5",
    "sonnet": "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "sonnet-4.5": "claude-sonnet-4-5",
    "haiku": "claude-haiku-4-5-20251001",
}


def resolve_model(name: str) -> str:
    return MODEL_ALIASES.get(name.lower(), name)


# ============================================================
# 4. Non-streaming Messages API Call
# ============================================================


def call_messages(token: str, model: str, messages: list[dict], max_tokens: int = 1024) -> dict:
    """Call POST /v1/messages (non-streaming)."""
    headers = build_auth_headers(token)
    url = f"{ANTHROPIC_BASE_URL}/v1/messages"

    body = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    }).encode()

    auth_mode = "OAuth Bearer (setup-token)" if is_oauth_token(token) else "API Key"
    print(f"\n-> POST {url}")
    print(f"   Auth: {auth_mode}")
    print(f"   Model: {model}")

    req = urllib.request.Request(url, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        raise RuntimeError(f"API error {e.code}: {error_body}") from e


# ============================================================
# 5. Streaming Messages API Call
# ============================================================


def call_messages_stream(token: str, model: str, messages: list[dict], max_tokens: int = 1024):
    """Call POST /v1/messages with stream=true, print tokens as they arrive."""
    headers = build_auth_headers(token)
    url = f"{ANTHROPIC_BASE_URL}/v1/messages"

    body = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
        "stream": True,
    }).encode()

    auth_mode = "OAuth Bearer (setup-token)" if is_oauth_token(token) else "API Key"
    print(f"\n-> POST {url} (streaming)")
    print(f"   Auth: {auth_mode}")
    print(f"   Model: {model}")

    req = urllib.request.Request(url, data=body, headers=headers, method="POST")

    try:
        resp = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        raise RuntimeError(f"API error {e.code}: {error_body}") from e

    sys.stdout.write("\n   Response: ")
    sys.stdout.flush()

    buffer = ""
    while True:
        chunk = resp.read(4096)
        if not chunk:
            break
        buffer += chunk.decode()
        lines = buffer.split("\n")
        buffer = lines.pop()  # keep incomplete last line

        for line in lines:
            if not line.startswith("data: "):
                continue
            data = line[6:].strip()
            if data == "[DONE]":
                continue
            try:
                event = json.loads(data)
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("text"):
                        sys.stdout.write(delta["text"])
                        sys.stdout.flush()
                if event.get("type") == "message_delta" and event.get("usage"):
                    print(f"\n\n   Usage: {json.dumps(event['usage'])}")
            except json.JSONDecodeError:
                pass

    resp.close()
    print()


# ============================================================
# Main
# ============================================================


def main():
    token = (
        os.environ.get("ANTHROPIC_TOKEN", "").strip()
        or os.environ.get("ANTHROPIC_OAUTH_TOKEN", "").strip()
        or os.environ.get("ANTHROPIC_API_KEY", "").strip()
    )

    if not token:
        print("Error: Set ANTHROPIC_TOKEN (setup-token) or ANTHROPIC_API_KEY")
        print()
        print('  # From `claude setup-token`:')
        print('  ANTHROPIC_TOKEN="sk-ant-oat01-..." python demo.py')
        print()
        print('  # Standard API key:')
        print('  ANTHROPIC_API_KEY="sk-ant-api03-..." python demo.py')
        sys.exit(1)

    # Validate if it's a setup token
    if token.startswith(SETUP_TOKEN_PREFIX):
        error = validate_setup_token(token)
        if error:
            print(f"Token validation failed: {error}")
            sys.exit(1)
        print("[ok] Valid setup-token (OAuth)")
    else:
        print("[ok] Using API key auth")

    model = resolve_model(os.environ.get("MODEL", "sonnet"))
    prompt = sys.argv[1] if len(sys.argv) > 1 else "Say hello in one sentence."

    print(f"\nModel: {model}")
    print(f"Prompt: {prompt}")

    messages = [{"role": "user", "content": prompt}]

    # --- Non-streaming ---
    print("\n=== Non-streaming ===")
    resp = call_messages(token, model, messages)
    text = resp["content"][0].get("text", "")
    usage = resp.get("usage", {})
    print(f"\n   Response: {text}")
    print(f"   Usage: input={usage.get('input_tokens')} output={usage.get('output_tokens')}")

    # --- Streaming ---
    print("\n=== Streaming ===")
    call_messages_stream(token, model, messages)


if __name__ == "__main__":
    main()
