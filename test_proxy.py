#!/usr/bin/env python3
"""Test the Codex proxy with tools so the model can actually respond."""

import json
import httpx

URL = "https://opencodefork-production.up.railway.app/v1/responses"

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

with httpx.stream("POST", URL, json=payload, timeout=60) as resp:
    print(f"Status: {resp.status_code}\n")
    for line in resp.iter_lines():
        if not line.startswith("data: "):
            continue
        data = json.loads(line[6:])
        evt = data.get("type", "")

        # Print reasoning summary deltas
        if evt == "response.reasoning_summary_text.delta":
            print(data["delta"], end="", flush=True)

        # Print text output deltas
        elif evt == "response.output_text.delta":
            print(data["delta"], end="", flush=True)

        # Print function calls
        elif evt == "response.function_call_arguments.delta":
            print(data["delta"], end="", flush=True)

        # Notify on new output items
        elif evt == "response.output_item.added":
            item = data.get("item", {})
            itype = item.get("type", "")
            if itype == "function_call":
                print(f"\n\n--- Tool call: {item.get('name', '?')} ---\n", flush=True)
            elif itype == "message":
                print("\n\n--- Model output ---\n", flush=True)

        # Done
        elif evt == "response.completed":
            usage = data.get("response", {}).get("usage", {})
            print(f"\n\n--- Done ---")
            print(f"Tokens: {usage.get('input_tokens', '?')} in, {usage.get('output_tokens', '?')} out")
