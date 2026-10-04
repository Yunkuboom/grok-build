#!/usr/bin/env python3
"""Probe 3: capture the FULL serde error for a wrong ask_user_question response."""
import json, os, subprocess, sys, threading, time

GROK = os.path.expanduser("~/.grok/bin/grok")
CWD = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()

p = subprocess.Popen(
    [GROK, "--permission-mode", "plan", "agent", "--no-leader", "stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
state = {"next_id": 1, "pending": {}, "responses": {}, "ask": None, "stderr": []}

def send(msg):
    p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()

def request(method, params):
    i = state["next_id"]; state["next_id"] += 1
    ev = threading.Event(); state["pending"][i] = ev
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    return i

def wait(i, timeout=120):
    state["pending"][i].wait(timeout)
    return state["responses"].get(i)

def reader():
    for line in p.stdout:
        try: d = json.loads(line)
        except Exception: continue
        if "method" in d and "id" in d:
            if d["method"] == "_x.ai/ask_user_question":
                state["ask"] = d
                print(">>> ASK params:", json.dumps(d["params"], ensure_ascii=False), flush=True)
            elif d["method"] == "session/request_permission":
                print(">>> PERMISSION:", json.dumps(d["params"], ensure_ascii=False)[:800], flush=True)
                send({"jsonrpc": "2.0", "id": d["id"], "result": {"outcome": {"outcome": "cancelled"}}})
            else:
                print(">>> OTHER REQUEST:", d["method"], json.dumps(d.get("params"), ensure_ascii=False)[:800], flush=True)
                send({"jsonrpc": "2.0", "id": d["id"], "error": {"code": -32601, "message": "method not found"}})
        elif "id" in d:
            state["responses"][d["id"]] = d
            ev = state["pending"].get(d.get("id"))
            if ev: ev.set()

def stderr_reader():
    for line in p.stderr:
        state["stderr"].append(line.rstrip())

threading.Thread(target=reader, daemon=True).start()
threading.Thread(target=stderr_reader, daemon=True).start()

i = request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
wait(i, 30)
i = request("session/new", {"cwd": CWD, "mcpServers": []})
sid = wait(i, 60)["result"]["sessionId"]
print("session:", sid, flush=True)

pr = "在继续之前你必须先问我一个问题：代码注释用中文还是英文？给我两个选项，等我回答。"
i = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": pr}]})
t0 = time.time()
while state["ask"] is None and time.time() - t0 < 60:
    time.sleep(0.2)
if state["ask"] is None:
    print("no question arrived", flush=True)
    p.kill(); sys.exit(1)

ask = state["ask"]
q = ask["params"]["questions"][0]["question"]
payload = {"type": "accepted", "answers": [{"question": q, "answer": "中文"}]}
print("answering with deliberately-probe payload:", json.dumps(payload, ensure_ascii=False), flush=True)
send({"jsonrpc": "2.0", "id": ask["id"], "result": payload})
wait(i, 60)
time.sleep(3)

interesting = [l for l in state["stderr"] if any(k in l for k in ("invalid", "error", "Error", "variant", "field", "ask_user"))]
print("\n--- stderr interesting lines (full) ---", flush=True)
for l in interesting[-15:]:
    print(l, flush=True)
p.kill()
print("DONE", flush=True)
