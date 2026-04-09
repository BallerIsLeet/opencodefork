import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { decodeJWT, refreshAccessToken } from "./lib/auth/auth.js";
import { CODEX_BASE_URL, JWT_CLAIM_PATH, OPENAI_HEADERS, OPENAI_HEADER_VALUES } from "./lib/constants.js";
import { getCodexInstructions } from "./lib/prompts/codex.js";
import { transformRequestBody, normalizeModel } from "./lib/request/request-transformer.js";
import { convertSseToJson, ensureContentType } from "./lib/request/response-handler.js";
import { rewriteUrlForCodex, createCodexHeaders, handleErrorResponse, handleSuccessResponse } from "./lib/request/fetch-helpers.js";
import { loadPluginConfig, getCodexMode } from "./lib/config.js";
import type { UserConfig, RequestBody } from "./lib/types.js";

// --- Token state ---
interface TokenState {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

let tokenState: TokenState | null = null;

interface AuthJson {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

function initTokenState(): TokenState {
  let access = process.env.OPENAI_ACCESS_TOKEN || "";
  let refresh = process.env.OPENAI_REFRESH_TOKEN || "";
  let accountId = "";

  // AUTH_JSON takes precedence — pass the whole auth.json as an env var
  const authJson = process.env.AUTH_JSON;
  if (authJson) {
    try {
      const parsed = JSON.parse(authJson) as AuthJson;
      access = parsed.tokens?.access_token || access;
      refresh = parsed.tokens?.refresh_token || refresh;
      accountId = parsed.tokens?.account_id || "";
    } catch {
      console.error("Failed to parse AUTH_JSON env var");
      process.exit(1);
    }
  }

  if (!access) {
    console.error("No access token found. Set AUTH_JSON or OPENAI_ACCESS_TOKEN");
    process.exit(1);
  }

  // Extract account ID from JWT if not provided in auth.json
  if (!accountId) {
    const decoded = decodeJWT(access);
    accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id || "";
  }

  if (!accountId) {
    console.error("Could not determine chatgpt_account_id from token or AUTH_JSON");
    process.exit(1);
  }

  // Extract expiry from JWT
  const decoded = decodeJWT(access);
  const exp = (decoded as any)?.exp;
  const expires = exp ? exp * 1000 : Date.now() + 3600_000;

  return { access, refresh, expires, accountId };
}

async function getValidToken(): Promise<TokenState> {
  if (!tokenState) {
    tokenState = initTokenState();
  }

  if (tokenState.expires < Date.now() && tokenState.refresh) {
    const result = await refreshAccessToken(tokenState.refresh);
    if (result.type === "success") {
      tokenState.access = result.access;
      tokenState.refresh = result.refresh;
      tokenState.expires = result.expires;

      // Re-extract account ID from new token
      const decoded = decodeJWT(result.access);
      const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
      if (accountId) {
        tokenState.accountId = accountId;
      }
    } else {
      console.error("Token refresh failed — using existing (possibly expired) token");
    }
  }

  return tokenState;
}

// --- App ---
const app = new Hono();

const pluginConfig = loadPluginConfig();
const codexMode = getCodexMode(pluginConfig);

// Request logging middleware
app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  console.log(`→ ${method} ${path}`);
  await next();
  const ms = Date.now() - start;
  console.log(`← ${method} ${path} ${c.res.status} (${ms}ms)`);
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/v1/responses", async (c) => {
  const token = await getValidToken();
  const body = (await c.req.json()) as RequestBody;

  const isStreaming = body.stream === true;
  console.log(`  model: ${body.model} | stream: ${isStreaming} | tools: ${body.tools?.length ?? 0}`);

  // Normalize model and get instructions
  const normalizedModel = normalizeModel(body.model);
  const codexInstructions = await getCodexInstructions(normalizedModel);

  const userConfig: UserConfig = { global: {}, models: {} };

  const transformedBody = await transformRequestBody(
    body,
    codexInstructions,
    userConfig,
    codexMode,
  );

  // Build URL
  const url = `${CODEX_BASE_URL}/codex/responses`;

  // Build headers
  const init: RequestInit = {
    method: "POST",
    body: JSON.stringify(transformedBody),
    headers: { "Content-Type": "application/json" },
  };

  const headers = createCodexHeaders(init, token.accountId, token.access, {
    model: transformedBody.model,
    promptCacheKey: (transformedBody as any)?.prompt_cache_key,
  });

  // Proxy to Codex
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(transformedBody),
  });

  if (!response.ok) {
    const errResponse = await handleErrorResponse(response);
    const errBody = await errResponse.text();
    return new Response(errBody, {
      status: errResponse.status,
      headers: Object.fromEntries(errResponse.headers.entries()),
    });
  }

  const result = await handleSuccessResponse(response, isStreaming);

  if (isStreaming) {
    // Stream through
    return new Response(result.body, {
      status: result.status,
      headers: Object.fromEntries(result.headers.entries()),
    });
  }

  const jsonBody = await result.text();
  return new Response(jsonBody, {
    status: result.status,
    headers: Object.fromEntries(result.headers.entries()),
  });
});

const port = parseInt(process.env.PORT || "8080", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Codex proxy server listening on http://0.0.0.0:${info.port}`);
  console.log(`Endpoints: POST /v1/responses, GET /health`);
});
