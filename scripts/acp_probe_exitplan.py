#!/usr/bin/env python3
"""Probe: exit_plan_mode ext request — method name, params, response schema.
Triggers plan-mode exit, captures the client request, then tries response shapes."""
import json, os, subprocess, sys, threading, time

GROK = os.path.expanduser("~/.grok/bin/grok")
CWD = os.getcwd()
RESPOND = json.loads(sys.argv[1]) if len(sys.argv) > 1 else None

p = subprocess.Popen(
    [GROK, "--permission-mode", "plan", "agent", "--no-leader", "stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
state = {"next_id": 1, "pending": {}, "responses": {}, "req": None, "stderr": [], "text": []}

def send(msg):
    p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()

def request(method, params):
    i = state["next_id"]; state["next_id"] += 1
    ev = threading.Event(); state["pending"][i] = ev
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    return i

def wait(i, timeout=150):
    state["pending"][i].wait(timeout)
    return state["responses"].get(i)

def reader():
    for line in p.stdout:
        try: d = json.loads(line)
        except Exception: continue
        if "method" in d and "id" in d:
            if d["method"] == "session/request_permission":
                opts = d["params"].get("options") or []
                allow = next((o for o in opts if "allow" in str(o.get("optionId","")).lower() or "允许" in str(o.get("name",""))), opts[0] if opts else None)
                send({"jsonrpc": "2.0", "id": d["id"], "result": {"outcome": {"outcome": "selected", "optionId": allow.get("optionId") if allow else None}}})
            elif d["method"] == "_x.ai/ask_user_question":
                print(">>> ASK:", json.dumps(d["params"], ensure_ascii=False)[:400], flush=True)
                send({"jsonrpc": "2.0", "id": d["id"], "result": {"outcome": "skip_interview"}})
            else:
                state["req"] = d
                print(">>> UNKNOWN REQUEST:", d["method"], flush=True)
                print(json.dumps(d.get("params"), ensure_ascii=False)[:1500], flush=True)
                if RESPOND is not None:
                    print(">>> responding with:", json.dumps(RESPOND, ensure_ascii=False), flush=True)
                    send({"jsonrpc": "2.0", "id": d["id"], "result": RESPOND})
                else:
                    # 不回包，观察挂起行为
                    pass
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
print("session:", sid, flush=True)

i = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text":
    "给这个项目做一个添加 LICENSE 文件的计划。计划写完后立即用 exit_plan_mode 请求我批准。"}]})
t0 = time.time()
while state["req"] is None and time.time() - t0 < 150:
    time.sleep(0.3)
if state["req"] is None:
    print("NO unknown request arrived; text tail:", "".join(state["text"])[-200:], flush=True)
else:
    wait(i, 60 if RESPOND else 15)
    time.sleep(2)
    print("after-response text tail:", "".join(state["text"])[-300:], flush=True)
    errs = [l for l in state["stderr"] if "error" in l.lower() or "invalid" in l.lower() or "exit_plan" in l.lower()]
    for l in errs[-6:]:
        print("STDERR:", l[:300], flush=True)
p.kill()
print("DONE", flush=True)
