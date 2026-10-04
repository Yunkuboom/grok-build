#!/usr/bin/env python3
"""Probe session/load replay behavior and session/set_config_option field names.

Read-only: loads an existing session, sends NO prompt.
Usage: acp_probe_load.py <cwd> <session_id>
"""
import json
import subprocess
import sys
import time

if len(sys.argv) < 3:
    print("usage: acp_probe_load.py <cwd> <session_id>", file=sys.stderr)
    sys.exit(2)
CWD = sys.argv[1]
SID = sys.argv[2]

proc = subprocess.Popen(
    ["grok", "agent", "--no-leader", "stdio"],
    cwd=CWD,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    bufsize=1,
)

def send(payload):
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()

def collect_until(request_id, deadline_s=25):
    """Read lines until response for request_id arrives; return (response, notifications_seen)."""
    notes = []
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            notes.append({"raw": line[:200]})
            continue
        if value.get("id") == request_id and "method" not in value:
            return value, notes
        notes.append(value)
    return None, notes

try:
    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": 1, "clientCapabilities": {},
        "clientInfo": {"name": "grok-builder-probe", "version": "0.1.0"}}})
    init, _ = collect_until(1)
    print("=== initialize result keys:", list((init or {}).get("result", {}).keys()))

    send({"jsonrpc": "2.0", "id": 2, "method": "session/load", "params": {
        "cwd": CWD, "mcpServers": [], "sessionId": SID}})
    resp, notes = collect_until(2, deadline_s=30)
    print("=== session/load response:", json.dumps(resp)[:800])
    print(f"=== notifications during load: {len(notes)}")
    for n in notes[:12]:
        m = n.get("method")
        p = n.get("params", {})
        upd = p.get("update", {}) if isinstance(p, dict) else {}
        print("  notif:", m, "| sessionUpdate:", upd.get("sessionUpdate"), "| keys:", list(upd.keys())[:6])
        if upd.get("sessionUpdate") in ("user_message_chunk", "agent_message_chunk"):
            print("    chunk:", json.dumps(upd.get("content"))[:200])

    # After response, keep draining briefly for trailing replay notifications
    time.sleep(2)
    import select
    trailing = 0
    while select.select([proc.stdout], [], [], 0.5)[0]:
        line = proc.stdout.readline()
        if not line:
            break
        trailing += 1
        try:
            v = json.loads(line)
            upd = v.get("params", {}).get("update", {})
            print("  trailing:", v.get("method"), upd.get("sessionUpdate"), json.dumps(upd.get("content"))[:150])
        except json.JSONDecodeError:
            print("  trailing raw:", line[:150])
    print(f"=== trailing notifications: {trailing}")

    # Probe session/set_config_option shapes
    result = (resp or {}).get("result", {})
    sid = result.get("sessionId", SID)
    print("=== session/load result keys:", list(result.keys()))
    for key in ("modes", "configOptions", "models", "availableCommands"):
        if key in result:
            print(f"=== result.{key}:", json.dumps(result[key])[:600])

    probe_shapes = [
        {"sessionId": sid, "configId": "mode", "value": {"value": "plan"}},
        {"sessionId": sid, "configId": "mode", "value": "plan"},
        {"sessionId": sid, "category": "mode", "value": "plan"},
    ]
    for i, params in enumerate(probe_shapes):
        send({"jsonrpc": "2.0", "id": 10 + i, "method": "session/set_config_option", "params": params})
        r, _ = collect_until(10 + i, deadline_s=10)
        print(f"=== set_config_option shape {i}: {json.dumps(r)[:300]}")

    # Also probe session/set_mode as fallback
    send({"jsonrpc": "2.0", "id": 20, "method": "session/set_mode", "params": {"sessionId": sid, "modeId": "plan"}})
    r, _ = collect_until(20, deadline_s=10)
    print("=== session/set_mode:", json.dumps(r)[:300])
finally:
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
