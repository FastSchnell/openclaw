/**
 * Claude Usage Query Demo
 *
 * Extracted from src/infra/provider-usage.fetch.claude.ts
 * Demonstrates querying Claude usage via:
 * 1. OAuth token → Anthropic usage API
 * 2. Claude.ai session key → Web API fallback
 *
 * Usage:
 *   ANTHROPIC_TOKEN="sk-ant-oat01-..." npx tsx usage.ts
 *   CLAUDE_AI_SESSION_KEY="sk-ant-sid01-..." npx tsx usage.ts
 */

// ============================================================
// 1. OAuth Usage API
// ============================================================

interface UsageWindow {
  label: string;
  usedPercent: number;
  resetAt?: number;
}

interface UsageResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number };
  seven_day_opus?: { utilization?: number };
}

function parseUsageWindows(data: UsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  if (data.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: Math.min(100, Math.max(0, data.five_hour.utilization)),
      resetAt: data.five_hour.resets_at
        ? new Date(data.five_hour.resets_at).getTime()
        : undefined,
    });
  }

  if (data.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: Math.min(100, Math.max(0, data.seven_day.utilization)),
      resetAt: data.seven_day.resets_at
        ? new Date(data.seven_day.resets_at).getTime()
        : undefined,
    });
  }

  const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
  if (modelWindow?.utilization !== undefined) {
    windows.push({
      label: data.seven_day_sonnet ? "Sonnet" : "Opus",
      usedPercent: Math.min(100, Math.max(0, modelWindow.utilization)),
    });
  }

  return windows;
}

async function fetchOAuthUsage(token: string): Promise<UsageWindow[] | null> {
  console.log("→ Querying Anthropic OAuth usage API...");

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "claude-auth-demo",
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as {
      error?: { message?: string };
    };
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    console.log(`  OAuth usage API failed: ${msg}`);

    // If 403 + scope error, caller should try web session fallback
    if (res.status === 403 && msg.includes("scope requirement user:profile")) {
      console.log("  → Token lacks user:profile scope, try web session fallback");
      return null;
    }
    return null;
  }

  const data = (await res.json()) as UsageResponse;
  return parseUsageWindows(data);
}

// ============================================================
// 2. Claude.ai Web Session Fallback
//    (from src/infra/provider-usage.fetch.claude.ts)
// ============================================================

function resolveSessionKey(): string | undefined {
  // Direct env vars
  const direct =
    process.env.CLAUDE_AI_SESSION_KEY?.trim() ??
    process.env.CLAUDE_WEB_SESSION_KEY?.trim();
  if (direct?.startsWith("sk-ant-")) return direct;

  // Extract from cookie header
  const cookie = process.env.CLAUDE_WEB_COOKIE?.trim();
  if (!cookie) return undefined;

  const stripped = cookie.replace(/^cookie:\s*/i, "");
  const match = stripped.match(/(?:^|;\s*)sessionKey=([^;\s]+)/i);
  const value = match?.[1]?.trim();
  return value?.startsWith("sk-ant-") ? value : undefined;
}

async function fetchWebUsage(sessionKey: string): Promise<UsageWindow[] | null> {
  console.log("→ Querying claude.ai web usage API...");

  const headers = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
  };

  // Step 1: Get org ID
  const orgRes = await fetch("https://claude.ai/api/organizations", { headers });
  if (!orgRes.ok) {
    console.log(`  Org fetch failed: HTTP ${orgRes.status}`);
    return null;
  }

  const orgs = (await orgRes.json()) as Array<{ uuid?: string; name?: string }>;
  const orgId = orgs?.[0]?.uuid?.trim();
  if (!orgId) {
    console.log("  No organization found");
    return null;
  }
  console.log(`  Organization: ${orgs[0].name} (${orgId})`);

  // Step 2: Get usage
  const usageRes = await fetch(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers },
  );
  if (!usageRes.ok) {
    console.log(`  Usage fetch failed: HTTP ${usageRes.status}`);
    return null;
  }

  const data = (await usageRes.json()) as UsageResponse;
  return parseUsageWindows(data);
}

// ============================================================
// Main
// ============================================================

function printUsage(windows: UsageWindow[]) {
  console.log("\n  Usage:");
  for (const w of windows) {
    const bar = "█".repeat(Math.round(w.usedPercent / 5)) +
      "░".repeat(20 - Math.round(w.usedPercent / 5));
    const reset = w.resetAt
      ? ` (resets ${new Date(w.resetAt).toLocaleString()})`
      : "";
    console.log(`    ${w.label.padEnd(8)} ${bar} ${w.usedPercent.toFixed(1)}%${reset}`);
  }
}

async function main() {
  const token =
    process.env.ANTHROPIC_TOKEN?.trim() ??
    process.env.ANTHROPIC_OAUTH_TOKEN?.trim();

  // Try OAuth usage API first
  if (token) {
    const windows = await fetchOAuthUsage(token);
    if (windows && windows.length > 0) {
      printUsage(windows);
      return;
    }
  }

  // Fallback: claude.ai web session
  const sessionKey = resolveSessionKey();
  if (sessionKey) {
    const windows = await fetchWebUsage(sessionKey);
    if (windows && windows.length > 0) {
      printUsage(windows);
      return;
    }
  }

  if (!token && !sessionKey) {
    console.error("Set ANTHROPIC_TOKEN or CLAUDE_AI_SESSION_KEY");
    console.error("");
    console.error("  ANTHROPIC_TOKEN=sk-ant-oat01-... npx tsx usage.ts");
    console.error("  CLAUDE_AI_SESSION_KEY=sk-ant-... npx tsx usage.ts");
    process.exit(1);
  }

  console.log("\nCould not fetch usage from either source.");
}

main().catch((err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
