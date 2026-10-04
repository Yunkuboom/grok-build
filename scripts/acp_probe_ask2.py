#!/usr/bin/env python3
"""Probe 2: discover the response schema of `_x.ai/ask_user_question`.

Triggers a question, then answers with candidate payloads until one is accepted
(acceptance = no "invalid response" on stderr AND later agent text mentions the
chosen answer). Also captures any exit_plan_mode ext request.
"""
import json, os, subprocess, sys, threading, time

GROK = os.path.expanduser("~/.grok/bin/grok")
CWD = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()

CANDIDATES = [
    ("A", lambda q: {"type": "accepted", "answers": [{"question": q, "answer": "Rust"}]}),
    ("B", lambda q: {"type": "accepted", "answers": [{"question": q, "selected": ["Rust"]}]}),
    ("C", lambda q: {"type": "accepted", "answers": {"0": "Rust"}}),
    ("D", lambda q: {"outcome": "accepted", "answers": [{"question": q, "answer": "Rust"}]}),
]

p = subprocess.Popen(
    [GROK, "--permission-mode", "plan", "agent", "--no-leader", "stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)

state = {"next_id": 1, "pending": {}, "responses": {}, "ask": None, "text": [], "stderr": []}

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
                print(">>> ASK:", json.dumps(d["params"], ensure_ascii=False)[:600], flush=True)
            elif d["method"] == "session/request_permission":
                send({"jsonrpc": "2.0", "id": d["id"], "result": {"outcome": {"outcome": "cancelled"}}})
            else:
                print(">>> OTHER REQUEST:", d["method"], json.dumps(d.get("params"), ensure_ascii=False)[:600], flush=True)
                send({"jsonrpc": "2.0", "id": d["id"], "error": {"code": -32601, "message": "method not found"}})
        elif "method" in d:
            u = d.get("params", {}).get("update", {})
            k = u.get("sessionUpdate", "")
            if k == "agent_message_chunk":
                t = ((u.get("content") or {}).get("text")) or ""
                state["text"].append(t)
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

def ask_and_answer(tag, make_payload):
    state["ask"] = None; state["text"] = []; state["stderr"] = []
    pr = (f"轮次{tag}：在继续之前，你必须先问我一个问题：配置文件用 TOML 还是 JSON？"
          f"给出选项让我选，等我回答后再继续。")
    i = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": pr}]})
    # wait for the ask request
    t0 = time.time()
    while state["ask"] is None and time.time() - t0 < 60:
        time.sleep(0.2)
    if state["ask"] is None:
        print(f"[{tag}] no question arrived", flush=True)
        wait(i, 10)
        return False
    ask = state["ask"]
    q = ask["params"]["questions"][0]["question"]
    payload = make_payload(q)
    print(f"[{tag}] answering with:", json.dumps(payload, ensure_ascii=False), flush=True)
    send({"jsonrpc": "2.0", "id": ask["id"], "result": payload})
    # wait for prompt to finish
    wait(i, 60)
    time.sleep(2)
    bad = [l for l in state["stderr"] if "invalid response" in l or "Failed to parse" in l]
    text = "".join(state["text"])
    hit = "Rust" in text
    print(f"[{tag}] invalid_on_stderr={bool(bad)} answer_echoed={hit}", flush=True)
    if bad:
        print("   stderr:", bad[0][:300], flush=True)
    return not bad and hit

for tag, maker in CANDIDATES:
    ok = ask_and_answer(tag, maker)
    if ok:
        print(f"\nSUCCESS candidate {tag}", flush=True)
        break

# exit_plan_mode observation: ask for a plan and let it exit
state["text"] = []
i = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text":
    "写一个给本项目添加 README.md 的计划，然后用 exit_plan_mode 请求批准。"}]})
wait(i, 90)
time.sleep(2)
print("final text tail:", "".join(state["text"])[-300:], flush=True)

p.kill()
print("DONE", flush=True)
