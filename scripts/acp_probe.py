#!/usr/bin/env python3
"""Minimal readout for the installed Grok ACP contract. Sends no model prompt."""
import json
import subprocess
import sys
import time

proc = subprocess.Popen(
    ["grok", "agent", "--no-leader", "stdio"],
    cwd=sys.argv[1] if len(sys.argv) > 1 else ".",
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    bufsize=1,
)

def request(request_id, method, params):
    assert proc.stdin and proc.stdout
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n")
    proc.stdin.flush()
    deadline = time.time() + 20
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        value = json.loads(line)
        if value.get("id") == request_id:
            return value
    raise RuntimeError(f"No response for {method}")

try:
    initialized = request(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "grok-builder-probe", "version": "0.1.0"}})
    print(json.dumps({"initialize": initialized}, indent=2))
    created = request(2, "session/new", {"cwd": sys.argv[1] if len(sys.argv) > 1 else ".", "mcpServers": []})
    print(json.dumps({"sessionNew": created}, indent=2))
    result = created.get("result", {})
    session_id = result.get("sessionId")
    modes = result.get("modes", {}).get("availableModes", [])
    if session_id and any(mode.get("id") == "plan" for mode in modes):
        changed = request(3, "session/set_mode", {"sessionId": session_id, "modeId": "plan"})
        print(json.dumps({"setPlan": changed}, indent=2))
finally:
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
