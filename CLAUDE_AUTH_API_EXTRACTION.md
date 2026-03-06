# Claude Auth Token + API Provider Logic Extraction

This document explains how OpenClaw authenticates with Claude/Anthropic and uses it as the underlying model provider.

## Architecture Overview

```
User provides credential (setup-token / API key / OAuth)
  |
  v
Auth Profile Store (~/.openclaw/agents/<id>/auth-profiles.json)
  |
  v
Model Auth Resolution (resolveApiKeyForProvider)
  |
  v
Pi Model Registry (pi-ai / pi-coding-agent)
  |
  v
Anthropic Messages API (inference)
```

---

## 1. Credential Types

Defined in `src/agents/auth-profiles/types.ts`:

```typescript
// Three credential types supported:

type ApiKeyCredential = {
  type: "api_key";
  provider: string;       // "anthropic"
  key?: string;           // raw API key like "sk-ant-api03-..."
  keyRef?: SecretRef;     // reference to external secret store
  email?: string;
};

type TokenCredential = {
  type: "token";
  provider: string;       // "anthropic"
  token?: string;         // Claude setup-token "sk-ant-oat01-..."
  tokenRef?: SecretRef;
  expires?: number;       // ms since epoch
  email?: string;
};

type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;       // "anthropic"
  clientId?: string;
  email?: string;
  // Inherited from OAuthCredentials:
  //   access: string;    (access token)
  //   refresh: string;   (refresh token)
  //   expires: number;   (expiry timestamp)
};
```

## 2. Token Validation

From `src/commands/auth-token.ts`:

```typescript
const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;

function validateAnthropicSetupToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return "Required";
  if (!trimmed.startsWith("sk-ant-oat01-")) {
    return `Expected token starting with sk-ant-oat01-`;
  }
  if (trimmed.length < 80) {
    return "Token looks too short; paste the full setup-token";
  }
  return undefined; // valid
}

// Profile IDs are formatted as "anthropic:default" or "anthropic:<name>"
function buildTokenProfileId({ provider, name }): string {
  return `${normalizeProviderId(provider)}:${normalizeTokenProfileName(name)}`;
}
```

## 3. Onboarding / Storing Credentials

From `src/commands/auth-choice.apply.anthropic.ts`:

Two auth paths during onboarding:

### Path A: Setup Token (from `claude setup-token` CLI)
```typescript
// User runs `claude setup-token` and pastes the token
// Token is stored as a "token" credential:
upsertAuthProfile({
  profileId: "anthropic:default",  // or "anthropic:<name>"
  credential: {
    type: "token",
    provider: "anthropic",
    token: "sk-ant-oat01-...",
  },
});
// Default model is set to "anthropic/claude-sonnet-4-6"
```

### Path B: API Key
```typescript
// User provides an Anthropic API key
// Stored as "api_key" credential in profile "anthropic:default"
// Default model set to "anthropic/claude-sonnet-4-6"
```

## 4. Auth Profile Storage

From `src/agents/auth-profiles/store.ts`:

Credentials are stored in `~/.openclaw/agents/<agentId>/auth-profiles.json`:

```json
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "token",
      "provider": "anthropic",
      "token": "sk-ant-oat01-..."
    }
  },
  "order": {},
  "lastGood": {},
  "usageStats": {}
}
```

Key behaviors:
- Sub-agents inherit credentials from main agent if they have none
- OAuth tokens are refreshed automatically when expired (with file locking)
- Legacy `auth.json` format is auto-migrated to `auth-profiles.json`
- External CLI credentials (Qwen, MiniMax) are synced in automatically

## 5. Auth Resolution Chain

From `src/agents/model-auth.ts` - `resolveApiKeyForProvider()`:

```typescript
async function resolveApiKeyForProvider({ provider, cfg, profileId, preferredProfile, store, agentDir }) {
  // 1. If explicit profileId given, use it directly
  if (profileId) {
    return resolveApiKeyForProfile({ store, profileId });
  }

  // 2. Check config auth override (e.g. "aws-sdk" mode)
  const authOverride = resolveProviderAuthOverride(cfg, provider);

  // 3. Try all profiles in priority order
  const order = resolveAuthProfileOrder({ cfg, store, provider, preferredProfile });
  for (const candidate of order) {
    const resolved = await resolveApiKeyForProfile({ store, profileId: candidate });
    if (resolved) return resolved;
  }

  // 4. Check environment variables
  //    For anthropic: ANTHROPIC_OAUTH_TOKEN -> ANTHROPIC_API_KEY
  const envResolved = resolveEnvApiKey(provider);
  if (envResolved) return envResolved;

  // 5. Check custom provider API key from models.json config
  const customKey = getCustomProviderApiKey(cfg, provider);
  if (customKey) return customKey;

  // 6. Throw if nothing found
  throw new Error(`No API key found for provider "${provider}"`);
}
```

Environment variable priority for Anthropic:
```typescript
// ANTHROPIC_OAUTH_TOKEN takes priority over ANTHROPIC_API_KEY
if (normalized === "anthropic") {
  return pick("ANTHROPIC_OAUTH_TOKEN") ?? pick("ANTHROPIC_API_KEY");
}
```

## 6. OAuth Token Refresh

From `src/agents/auth-profiles/oauth.ts`:

```typescript
// When an OAuth token expires:
async function refreshOAuthTokenWithLock({ profileId, agentDir }) {
  // Uses file lock to prevent concurrent refresh
  return await withFileLock(authPath, options, async () => {
    const store = ensureAuthProfileStore(agentDir);
    const cred = store.profiles[profileId];

    // If still valid, return as-is
    if (Date.now() < cred.expires) {
      return { apiKey: cred.access, newCredentials: cred };
    }

    // Refresh via pi-ai OAuth library
    const oauthProvider = resolveOAuthProvider(cred.provider); // "anthropic"
    const result = await getOAuthApiKey(oauthProvider, { [cred.provider]: cred });

    // Save refreshed credentials
    store.profiles[profileId] = { ...cred, ...result.newCredentials, type: "oauth" };
    saveAuthProfileStore(store, agentDir);
    return result;
  });
}

// Bearer-token modes (oauth and token) are interchangeable:
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);
```

## 7. Converting to Pi-AI Format

From `src/agents/pi-auth-credentials.ts`:

OpenClaw credentials are converted to the format expected by the `@mariozechner/pi-ai` library:

```typescript
function convertAuthProfileCredentialToPi(cred): PiCredential | null {
  if (cred.type === "api_key") {
    return { type: "api_key", key: cred.key };
  }
  if (cred.type === "token") {
    // Token treated as api_key for pi-ai
    return { type: "api_key", key: cred.token };
  }
  if (cred.type === "oauth") {
    return { type: "oauth", access: cred.access, refresh: cred.refresh, expires: cred.expires };
  }
  return null;
}
```

## 8. Model Discovery & Registry

From `src/agents/pi-model-discovery.ts`:

```typescript
// Create auth storage from OpenClaw's auth profiles
function discoverAuthStorage(agentDir: string): PiAuthStorage {
  const credentials = resolvePiCredentials(agentDir);
  return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}

// Create model registry using auth storage
function discoverModels(authStorage: PiAuthStorage, agentDir: string): PiModelRegistry {
  return new PiModelRegistryClass(authStorage, path.join(agentDir, "models.json"));
}
```

## 9. Model Selection & Aliases

From `src/agents/model-selection.ts`:

```typescript
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-opus-4-6";

// Model aliases for Anthropic:
const ANTHROPIC_MODEL_ALIASES = {
  "opus-4.6": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
};

// Provider normalization:
function normalizeProviderId(provider: string): string {
  // handles aliases like "z.ai" -> "zai", "bedrock" -> "amazon-bedrock"
  return provider.trim().toLowerCase();
}
```

## 10. Claude Web Session (Usage Reporting)

From `src/infra/provider-usage.fetch.claude.ts`:

For usage reporting, OpenClaw can also use `claude.ai` browser session keys:

```typescript
// Session key resolution (for usage API, not inference):
function resolveClaudeWebSessionKey(): string | undefined {
  // 1. Direct env var: CLAUDE_AI_SESSION_KEY or CLAUDE_WEB_SESSION_KEY
  const direct = process.env.CLAUDE_AI_SESSION_KEY ?? process.env.CLAUDE_WEB_SESSION_KEY;
  if (direct?.startsWith("sk-ant-")) return direct;

  // 2. Extract from cookie header: CLAUDE_WEB_COOKIE
  const cookieHeader = process.env.CLAUDE_WEB_COOKIE;
  // Parses sessionKey=<value> from the cookie string
}

// Usage fetch via OAuth token:
async function fetchClaudeUsage(token, timeoutMs, fetchFn) {
  const res = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  // Fallback: if OAuth token lacks "user:profile" scope, use claude.ai web API
  if (res.status === 403 && message.includes("scope requirement user:profile")) {
    const sessionKey = resolveClaudeWebSessionKey();
    // Uses https://claude.ai/api/organizations and .../usage
  }
}
```

## 11. Claude CLI Backend

From `src/agents/cli-backends.ts`:

OpenClaw can also delegate to the `claude` CLI as a backend:

```typescript
const DEFAULT_CLAUDE_BACKEND = {
  command: "claude",
  args: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"],
  resumeArgs: [..., "--resume", "{sessionId}"],
  modelArg: "--model",
  modelAliases: {
    "opus-4.6": "opus",
    "claude-opus-4-6": "opus",
    "sonnet-4.6": "sonnet",
    "claude-sonnet-4-6": "sonnet",
    // ...
  },
  sessionArg: "--session-id",
  systemPromptArg: "--append-system-prompt",
  clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],  // CLI handles auth separately
};
```

## Key File Index

| File | Purpose |
|------|---------|
| `src/agents/auth-profiles/types.ts` | Credential type definitions (ApiKey, Token, OAuth) |
| `src/agents/auth-profiles/store.ts` | Load/save/merge auth-profiles.json |
| `src/agents/auth-profiles/oauth.ts` | OAuth token refresh, profile resolution |
| `src/agents/auth-profiles/external-cli-sync.ts` | Sync credentials from external CLIs |
| `src/commands/auth-token.ts` | Setup token validation, profile ID generation |
| `src/commands/auth-choice.apply.anthropic.ts` | Onboarding flow for Anthropic auth |
| `src/agents/model-auth.ts` | Main auth resolution chain, env var mapping |
| `src/agents/pi-auth-credentials.ts` | Convert OpenClaw creds to pi-ai format |
| `src/agents/pi-model-discovery.ts` | Create Pi auth storage and model registry |
| `src/agents/model-selection.ts` | Model aliases, provider normalization |
| `src/agents/defaults.ts` | Default provider ("anthropic") and model ("claude-opus-4-6") |
| `src/agents/cli-backends.ts` | Claude CLI backend configuration |
| `src/agents/anthropic-payload-log.ts` | Request/usage payload logging |
| `src/infra/provider-usage.fetch.claude.ts` | Claude usage API + web session fallback |

## Summary

The core flow is:

1. **Credential entry**: User provides a setup-token (`sk-ant-oat01-*`), API key, or OAuth tokens
2. **Storage**: Credentials stored in `auth-profiles.json` with type `token`, `api_key`, or `oauth`
3. **Resolution**: `resolveApiKeyForProvider("anthropic")` cascades through profiles -> env vars -> config
4. **Conversion**: OpenClaw credentials converted to pi-ai format via `convertAuthProfileCredentialToPi()`
5. **Registry**: Pi model registry handles actual API calls using `anthropic-messages` API
6. **Refresh**: OAuth tokens auto-refreshed via file-locked refresh flow
7. **Fallback**: CLI backend delegates to `claude` command directly (separate auth)
