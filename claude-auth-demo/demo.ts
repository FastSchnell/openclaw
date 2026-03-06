/**
 * Claude Auth + Messages API Minimal Demo
 *
 * Extracted from OpenClaw's auth logic. Demonstrates:
 * 1. Setup token (sk-ant-oat01-*) auth via Bearer + beta headers
 * 2. API key (sk-ant-api03-*) auth via x-api-key header
 * 3. Calling Anthropic Messages API
 *
 * Usage:
 *   ANTHROPIC_TOKEN="sk-ant-oat01-..." npx tsx demo.ts
 *   ANTHROPIC_API_KEY="sk-ant-api03-..." npx tsx demo.ts
 */

// ============================================================
// 1. Token Validation (from src/commands/auth-token.ts)
// ============================================================

const SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
const SETUP_TOKEN_MIN_LENGTH = 80;

function validateSetupToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return "Token is required";
  if (!trimmed.startsWith(SETUP_TOKEN_PREFIX)) {
    return `Expected token starting with ${SETUP_TOKEN_PREFIX}`;
  }
  if (trimmed.length < SETUP_TOKEN_MIN_LENGTH) {
    return "Token looks too short; paste the full setup-token";
  }
  return null; // valid
}

function isOAuthToken(token: string): boolean {
  return token.includes("sk-ant-oat");
}

// ============================================================
// 2. Auth Header Construction
//    (from src/agents/pi-embedded-runner/extra-params.ts)
// ============================================================

/**
 * When using OAuth tokens (sk-ant-oat-*), Anthropic requires these beta headers.
 * Without "oauth-2025-04-20", the API returns 401 "OAuth authentication is
 * currently not supported".
 */
const OAUTH_REQUIRED_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
];

const API_KEY_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
];

interface AuthHeaders {
  Authorization?: string;
  "x-api-key"?: string;
  "anthropic-version": string;
  "anthropic-beta"?: string;
  "content-type": string;
}

function buildAuthHeaders(token: string): AuthHeaders {
  const headers: AuthHeaders = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };

  if (isOAuthToken(token)) {
    // OAuth/setup-token: Bearer auth + required beta headers
    headers["Authorization"] = `Bearer ${token}`;
    headers["anthropic-beta"] = OAUTH_REQUIRED_BETAS.join(",");
  } else {
    // Standard API key: x-api-key header
    headers["x-api-key"] = token;
    headers["anthropic-beta"] = API_KEY_BETAS.join(",");
  }

  return headers;
}

// ============================================================
// 3. Messages API Call
//    (pi-ai calls POST ${baseUrl}/v1/messages)
// ============================================================

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
  stream?: boolean;
}

interface MessagesResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

async function callClaudeMessages(
  token: string,
  request: MessagesRequest,
): Promise<MessagesResponse> {
  const headers = buildAuthHeaders(token);
  const url = `${ANTHROPIC_BASE_URL}/v1/messages`;

  console.log(`\n→ POST ${url}`);
  console.log(`  Auth mode: ${isOAuthToken(token) ? "OAuth Bearer (setup-token)" : "API Key"}`);
  console.log(`  Model: ${request.model}`);

  const res = await fetch(url, {
    method: "POST",
    headers: headers as Record<string, string>,
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`API error ${res.status}: ${errorBody}`);
  }

  return (await res.json()) as MessagesResponse;
}

// ============================================================
// 4. Streaming Messages API
// ============================================================

async function callClaudeMessagesStream(
  token: string,
  request: MessagesRequest,
): Promise<void> {
  const headers = buildAuthHeaders(token);
  const url = `${ANTHROPIC_BASE_URL}/v1/messages`;

  console.log(`\n→ POST ${url} (streaming)`);
  console.log(`  Auth mode: ${isOAuthToken(token) ? "OAuth Bearer (setup-token)" : "API Key"}`);
  console.log(`  Model: ${request.model}`);

  const res = await fetch(url, {
    method: "POST",
    headers: headers as Record<string, string>,
    body: JSON.stringify({ ...request, stream: true }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`API error ${res.status}: ${errorBody}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  process.stdout.write("\n  Response: ");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data) as {
          type: string;
          delta?: { type: string; text?: string };
          usage?: Record<string, number>;
        };
        if (event.type === "content_block_delta" && event.delta?.text) {
          process.stdout.write(event.delta.text);
        }
        if (event.type === "message_delta" && event.usage) {
          console.log(`\n\n  Usage: ${JSON.stringify(event.usage)}`);
        }
      } catch {
        // skip non-JSON lines
      }
    }
  }

  console.log("");
}

// ============================================================
// 5. Model Aliases (from src/agents/model-selection.ts)
// ============================================================

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  "opus-4.6": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  sonnet: "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
  haiku: "claude-haiku-4-5-20251001",
};

function resolveModel(input: string): string {
  return MODEL_ALIASES[input.toLowerCase()] ?? input;
}

// ============================================================
// Main
// ============================================================

async function main() {
  // Resolve token from env
  const token =
    process.env.ANTHROPIC_TOKEN?.trim() ??
    process.env.ANTHROPIC_OAUTH_TOKEN?.trim() ??
    process.env.ANTHROPIC_API_KEY?.trim();

  if (!token) {
    console.error("Error: Set ANTHROPIC_TOKEN (setup-token) or ANTHROPIC_API_KEY");
    console.error("");
    console.error("  # From `claude setup-token`:");
    console.error('  ANTHROPIC_TOKEN="sk-ant-oat01-..." npx tsx demo.ts');
    console.error("");
    console.error("  # Standard API key:");
    console.error('  ANTHROPIC_API_KEY="sk-ant-api03-..." npx tsx demo.ts');
    process.exit(1);
  }

  // Validate if it's a setup token
  if (token.startsWith(SETUP_TOKEN_PREFIX)) {
    const error = validateSetupToken(token);
    if (error) {
      console.error(`Token validation failed: ${error}`);
      process.exit(1);
    }
    console.log("✓ Valid setup-token (OAuth)");
  } else {
    console.log("✓ Using API key auth");
  }

  const model = resolveModel(process.env.MODEL ?? "sonnet");
  const prompt = process.argv[2] ?? "Say hello in one sentence.";

  console.log(`\nModel: ${model}`);
  console.log(`Prompt: ${prompt}`);

  // --- Non-streaming call ---
  console.log("\n=== Non-streaming ===");
  const response = await callClaudeMessages(token, {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  console.log(`\n  Response: ${response.content[0]?.text}`);
  console.log(`  Usage: input=${response.usage.input_tokens} output=${response.usage.output_tokens}`);

  // --- Streaming call ---
  console.log("\n=== Streaming ===");
  await callClaudeMessagesStream(token, {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
