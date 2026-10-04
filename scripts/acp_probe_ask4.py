#!/usr/bin/env python3
"""Probe 4: parameterized ask_user_question response tester.
Usage: python3 acp_probe_ask4.py '{"outcome":"accepted"}'
Prints serde errors verbatim and whether the agent echoed our chosen answer."""
import json, os, subprocess, sys, threading, time

GROK = os.path.expanduser("~/.grok/bin/grok")
CWD = os.getcwd()
PAYLOAD = json.loads(sys.argv[1])
EXPECT = sys.argv[2] if len(sys.argv) > 2 else "中文"

p = subprocess.Popen(
    [GROK, "--permission-mode", "plan", "agent", "--no-leader", "stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
state = {"next_id": 1, "pending": {}, "responses": {}, "ask": None, "stderr": [], "text": []}

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
                print(">>> ASK:", json.dumps(d["params"], ensure_ascii=False)[:700], flush=True)
            else:
                print(">>> OTHER REQUEST:", d["method"], flush=True)
                send({"jsonrpc": "2.0", "id": d["id"], "error": {"code": -32601, "message": "method not found"}})
        elif "method" in d:
            u = d.get("params", {}).get("update", {})
            if u.get("sessionUpdate") == "agent_message_chunk":
                state["text"].append(((u.get("content") or {}).get("text")) or "")
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

i = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text":
    "在继续之前你必须先问我一个问题：代码注释用中文还是英文？给我两个选项，等我回答。"}]})
t0 = time.time()
while state["ask"] is None and time.time() - t0 < 60:
    time.sleep(0.2)
if state["ask"] is None:
    print("RESULT: no question arrived", flush=True); p.kill(); sys.exit(1)

ask = state["ask"]
q = ask["params"]["questions"][0]["question"]
payload = json.loads(json.dumps(PAYLOAD).replace("$Q", q))
print("answering:", json.dumps(payload, ensure_ascii=False), flush=True)
send({"jsonrpc": "2.0", "id": ask["id"], "result": payload})
wait(i, 60)
time.sleep(2)

errs = [l for l in state["stderr"] if "invalid response" in l or "missing field" in l or "unknown variant" in l or "unknown field" in l]
echoed = EXPECT in "".join(state["text"])
print("SERDE_ERRORS:", errs[-1][:400] if errs else "none", flush=True)
print("ANSWER_ECHOED:", echoed, flush=True)
p.kill()
print("DONE", flush=True)
