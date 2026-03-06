# Claude Auth API Minimal Demo

Minimal standalone demo extracted from OpenClaw, demonstrating how to authenticate
with Claude using setup-tokens (OAuth tokens from `claude setup-token`) and call
the Anthropic Messages API directly.

## Usage

```bash
# Install deps
npm install

# Method 1: Setup token from `claude setup-token`
ANTHROPIC_TOKEN="sk-ant-oat01-..." npx tsx demo.ts

# Method 2: Standard API key
ANTHROPIC_API_KEY="sk-ant-api03-..." npx tsx demo.ts

# Method 3: Claude.ai browser session key (for usage query only)
CLAUDE_AI_SESSION_KEY="sk-ant-sid01-..." npx tsx demo.ts
```

## What This Demonstrates

1. **Token validation** - Validates `sk-ant-oat01-*` setup tokens
2. **Auth header construction** - OAuth tokens use `Bearer` auth + required beta headers
3. **API key auth** - Standard `x-api-key` header
4. **Messages API call** - Direct POST to `https://api.anthropic.com/v1/messages`
5. **Usage query** - Fetch usage from both OAuth API and claude.ai web session
