#!/usr/bin/env python3
"""Test the Codex proxy with tools so the model can actually respond.

Usage:
  python test_proxy.py             # default: /v1/responses with tool-calling
  python test_proxy.py --image     # /v1/images/generations streaming test
"""

import base64
import json
import sys
import httpx

BASE_URL = "https://opencodefork-production.up.railway.app"


def run_responses_test() -> None:
    url = f"{BASE_URL}/v1/responses"
    payload = {
        "model": "gpt-4o-mini",
        "input": [
            {"role": "user", "content": "Write a C++ hello world program. Output it as text."}
        ],
        "stream": True,
        "tools": [
            {
                "type": "function",
                "name": "apply_patch",
                "description": "Apply a patch to files on disk. The patch should be in unified diff format.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "patch": {
                            "type": "string",
                            "description": "The patch content in the custom patch format"
                        }
                    },
                    "required": ["patch"]
                }
            },
            {
                "type": "function",
                "name": "shell",
                "description": "Run a shell command and return its output.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute"
                        }
                    },
                    "required": ["command"]
                }
            }
        ]
    }

    print("Sending request (streaming)...\n")

    with httpx.stream("POST", url, json=payload, timeout=60) as resp:
        print(f"Status: {resp.status_code}\n")
        for line in resp.iter_lines():
            if not line.startswith("data: "):
                continue
            data = json.loads(line[6:])
            evt = data.get("type", "")

            if evt == "response.reasoning_summary_text.delta":
                print(data["delta"], end="", flush=True)
            elif evt == "response.output_text.delta":
                print(data["delta"], end="", flush=True)
            elif evt == "response.function_call_arguments.delta":
                print(data["delta"], end="", flush=True)
            elif evt == "response.output_item.added":
                item = data.get("item", {})
                itype = item.get("type", "")
                if itype == "function_call":
                    print(f"\n\n--- Tool call: {item.get('name', '?')} ---\n", flush=True)
                elif itype == "message":
                    print("\n\n--- Model output ---\n", flush=True)
            elif evt == "response.completed":
                usage = data.get("response", {}).get("usage", {})
                print(f"\n\n--- Done ---")
                print(f"Tokens: {usage.get('input_tokens', '?')} in, {usage.get('output_tokens', '?')} out")


def run_image_test() -> None:
    url = f"{BASE_URL}/v1/images/generations"
    payload = {
        "model": "gpt-5.2",
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "a toasty sunrise over snowy mountains, digital painting"}
                ],
            }
        ],
        "stream": True,
    }

    print("Sending image generation request (streaming)...\n")

    event_types_seen: set[str] = set()
    image_b64: str | None = None
    revised_prompt: str | None = None

    with httpx.stream("POST", url, json=payload, timeout=180) as resp:
        print(f"Status: {resp.status_code}\n")
        for line in resp.iter_lines():
            if not line.startswith("data: "):
                continue
            data = json.loads(line[6:])
            evt = data.get("type", "")
            event_types_seen.add(evt)

            if evt == "response.output_text.delta":
                print(data.get("delta", ""), end="", flush=True)
            elif evt == "response.output_item.done":
                item = data.get("item", {})
                if item.get("type") == "image_generation_call":
                    image_b64 = item.get("result")
                    revised_prompt = item.get("revised_prompt")
                    print(f"\n\n--- image_generation_call done: status={item.get('status')} ---", flush=True)
            elif evt == "response.completed":
                print("\n\n--- Done ---")

    print(f"\nEvent types seen: {sorted(event_types_seen)}")
    assert image_b64, "No image_generation_call item with a non-empty 'result' was received"

    raw = base64.b64decode(image_b64)
    assert raw[:8] == b"\x89PNG\r\n\x1a\n", f"Result is not a valid PNG (first bytes: {raw[:8]!r})"
    print(f"PNG validated ({len(raw)} bytes). Revised prompt: {revised_prompt!r}")


if __name__ == "__main__":
    if "--image" in sys.argv:
        run_image_test()
    else:
        run_responses_test()
