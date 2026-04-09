# Codex Proxy Server — Developer Guide

## Overview

This is a proxy server that forwards requests to OpenAI's Codex API using OAuth tokens (ChatGPT Plus/Pro accounts). It handles token refresh automatically and injects the Codex system prompt.

**Deployed at:** `https://opencodefork-production.up.railway.app`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check — returns `{"status":"ok"}` |
| POST | `/v1/responses` | Proxy to Codex responses API |

**Note:** There is no `/v1/chat/completions` endpoint. This server only supports the Responses API format.

## Authentication

The server authenticates to OpenAI using tokens from the `AUTH_JSON` environment variable (the contents of `~/.codex/auth.json`). No client-side auth is required — the proxy handles it.

### Token structure (`AUTH_JSON`)

```json
{
  "tokens": {
    "access_token": "eyJ...",
    "refresh_token": "rt_...",
    "account_id": "ae466293-..."
  }
}
```

The server auto-refreshes expired access tokens using the refresh token.

## Making Requests

### Important: You MUST provide tools

The Codex system prompt configures the model as a **coding agent** that operates via tool calls. If you send a request without tools, the model will return **empty output** — it expects to act through tools, not reply as a chatbot.

### Minimal working request

```bash
curl -s https://opencodefork-production.up.railway.app/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "input": [{"role": "user", "content": "Write a hello world in Python"}],
    "stream": false,
    "tools": [
      {
        "type": "function",
        "name": "apply_patch",
        "description": "Apply a patch to files on disk.",
        "parameters": {
          "type": "object",
          "properties": {
            "patch": {"type": "string", "description": "The patch content"}
          },
          "required": ["patch"]
        }
      },
      {
        "type": "function",
        "name": "shell",
        "description": "Run a shell command.",
        "parameters": {
          "type": "object",
          "properties": {
            "command": {"type": "string", "description": "The command to execute"}
          },
          "required": ["command"]
        }
      }
    ]
  }'
```

### Streaming

Set `"stream": true` to get Server-Sent Events (SSE). Key event types:

| Event type | Description |
|------------|-------------|
| `response.output_text.delta` | Text output chunks (field: `delta`) |
| `response.reasoning_summary_text.delta` | Reasoning/thinking chunks (field: `delta`) |
| `response.function_call_arguments.delta` | Tool call argument chunks (field: `delta`) |
| `response.output_item.added` | New output item started (check `item.type`) |
| `response.completed` | Request finished (contains `usage` stats) |

### Model mapping

The server normalizes model names before forwarding. See `lib/request/request-transformer.ts` for the mapping. Common models like `gpt-4o-mini` are accepted.

## Running Locally

```bash
# Install dependencies
npm install

# Set auth (paste contents of ~/.codex/auth.json)
export AUTH_JSON='{"tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}'

# Or set individual tokens
export OPENAI_ACCESS_TOKEN="eyJ..."
export OPENAI_REFRESH_TOKEN="rt_..."

# Start server (default port 8080)
npm start

# Or specify port
PORT=3000 npm start
```

## Architecture

```
Client Request
  → POST /v1/responses
  → Token validation & auto-refresh
  → Model normalization
  → System prompt injection (Codex instructions)
  → Forward to https://api.openai.com/codex/responses
  → Stream/return response to client
```

Key source files:

- `server.ts` — Main server, routing, token management
- `lib/auth/auth.ts` — JWT decoding, token refresh
- `lib/request/request-transformer.ts` — Model normalization, body transforms
- `lib/request/fetch-helpers.ts` — URL rewriting, header construction
- `lib/request/response-handler.ts` — SSE/JSON response handling
- `lib/prompts/codex.ts` — System prompt generation
- `lib/constants.ts` — Base URLs, header names

## Test Script

`test_proxy.py` is included for quick validation:

```bash
python3 test_proxy.py
```

Sends a streaming request with tools and prints the model's response.
