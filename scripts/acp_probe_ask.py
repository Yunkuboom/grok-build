#!/usr/bin/env python3
"""Probe: how do clarification questions / plan-exit requests reach an ACP client?

Spawns `grok agent stdio` in plan mode, sends prompts that should force
1) a clarifying question with options, 2) an ExitPlanMode-style approval.
Logs every agent->client request (method, id, params) and every notification.
Answers any session/request_permission with the cancelled outcome after logging.
"""
import json, os, subprocess, sys, time, threading

GROK = os.path.expanduser("~/.grok/bin/grok")
CWD = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()

p = subprocess.Popen(
    [GROK, "--permission-mode", "plan", "agent", "--no-leader", "stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
)

next_id = [1]
pending = {}
log_lock = threading.Lock()

def log(tag, obj):
    with log_lock:
        print(f"\n===== {tag} =====")
        print(json.dumps(obj, ensure_ascii=False, indent=1)[:3000])
        sys.stdout.flush()

def send(msg):
    p.stdin.write(json.dumps(msg) + "\n")
    p.stdin.flush()

def request(method, params):
    i = next_id[0]; next_id[0] += 1
    ev = threading.Event()
    pending[i] = ev
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    return i, ev

responses = {}

def reader():
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if "method" in d and "id" in d:  # agent->client REQUEST
            log(f"REQUEST method={d['method']}", d)
            if d["method"] == "session/request_permission":
                send({"jsonrpc": "2.0", "id": d["id"],
                      "result": {"outcome": {"outcome": "cancelled"}}})
        elif "method" in d:  # notification
            u = d.get("params", {}).get("update", {})
            kind = u.get("sessionUpdate", "?")
            if kind not in ("agent_message_chunk", "agent_thought_chunk"):
                log(f"NOTIF {d['method']} kind={kind}", d)
        elif "id" in d:  # response to our request
            responses[d["id"]] = d
            ev = pending.get(d.get("id"))
            if ev:
                ev.set()

threading.Thread(target=reader, daemon=True).start()

def wait(i, timeout=90):
    ev = pending[i]
    ev.wait(timeout)
    return responses.get(i)

i, _ = request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
log("initialize.result", wait(i) or {})
i, _ = request("session/new", {"cwd": CWD, "mcpServers": []})
r = wait(i)
log("session/new.result", r or {})
sid = r["result"]["sessionId"]

prompt1 = ("我要给这个项目加一个新功能：一个命令行计数器。开始之前你必须先问我一个问题："
           "实现语言用 Rust 还是 Python？请给我选项让我选择，不要自己决定。")
log("PROMPT1", prompt1)
i, _ = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": prompt1}]})
r = wait(i, 120)
log("prompt1.response", r or {})

prompt2 = "给这个项目做一个添加 README.md 的计划，写完计划后请求我批准执行。"
log("PROMPT2", prompt2)
i, _ = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": prompt2}]})
r = wait(i, 120)
log("prompt2.response", r or {})

p.kill()
print("\nDONE")
