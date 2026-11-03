#!/usr/bin/env python3
"""ZCode → Desktop AI Pet 桥接钩子（整改计划 M6-P1）。

ZCode hooks 机制：配置于 ~/.zcode/cli/config.json 的 hooks.events，
process 钩子在事件触发时以 stdin JSON（HookInput）调用本脚本。

零副作用原则（§9.3-1）：
- 任何异常都被吞掉，退出码恒 0，stdout 恒空——宠物绝不能拖垮 ZCode 回合
- HTTP 超时 500ms，fire-and-forget
- 本脚本不打印任何日志到 stdout（协议要求 stdout 只出决策 JSON，P1 无决策）
- 诊断日志只写文件（PET_HOOK_LOG=0 可关）

P1 事件映射（§9.2）：
  SessionStart         → POST /event {kind: agent-session}
  UserPromptSubmit     → POST /event {kind: agent-thinking}
  PreToolUse           → POST /event {kind: agent-working}
  PostToolUse          → POST /event {kind: agent-tool-ok}（P2：前端低频摘要）
  PostToolUseFailure   → POST /event {kind: agent-failed}
  Stop                 → POST /event {kind: agent-done}

P2 审批双向回写（PermissionRequest）：
  POST /approval 拿 id → 轮询 GET /approval/poll（默认预算 110s，
  PET_APPROVAL_WAIT_S 可调）→ 主人在宠物横幅/快捷键决策后，stdout 输出
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
   "decision":{"behavior":"allow"|"deny","message":...}}}
  （协议经 zcode.cjs 源码确认：z_a/permissionRequestResult 分支）。
  超时/异常 → stdout 空、exit 0，ZCode 默认审批 UI 照常接管，绝不卡死回合。
  注意：本事件是唯一允许 stdout 非空的分支（协议要求），其他事件 stdout 恒空。
"""
import json
import os
import sys
import tempfile
import time
import urllib.request

BRIDGE = os.environ.get("PET_BRIDGE_URL", "http://127.0.0.1:7788")
TIMEOUT = 0.5
LOG_ENABLED = os.environ.get("PET_HOOK_LOG", "1") != "0"
LOG_PATH = os.path.join(tempfile.gettempdir(), "ai-pet-hook.log")
LOG_MAX = 256 * 1024
# 审批等待预算：须小于 install.py 给 PermissionRequest 的 timeoutMs（120s）
APPROVAL_WAIT_S = float(os.environ.get("PET_APPROVAL_WAIT_S", "110"))

EVENT_MAP = {
    "SessionStart": ("event", "agent-session"),
    "UserPromptSubmit": ("event", "agent-thinking"),
    "PreToolUse": ("event", "agent-working"),
    "PostToolUse": ("event", "agent-tool-ok"),
    "PostToolUseFailure": ("event", "agent-failed"),
    "Stop": ("event", "agent-done"),
}

# ZCode 协议字段若升级可能改名，逐个兜底取（§9.5：解析失败静默跳过）
EVENT_KEYS = ("event", "hook_event_name", "hookEventName", "type", "event_name")


def log(line):
    """诊断日志写临时文件（不进 stdout）；超 256KB 清空重写。"""
    if not LOG_ENABLED:
        return
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX:
            os.remove(LOG_PATH)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def extract_event(data):
    for k in EVENT_KEYS:
        v = data.get(k)
        if isinstance(v, str) and v:
            return v
    return ""


def post(path, payload):
    req = urllib.request.Request(
        BRIDGE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def get_json(path):
    with urllib.request.urlopen(BRIDGE + path, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def pick(data, *keys):
    """ZCode 同时发驼峰/蛇形双命名字段，逐个兜底取。"""
    for k in keys:
        v = data.get(k)
        if v:
            return v
    return None


def emit_decision(behavior, message=None):
    """PermissionRequest 决策回写（唯一允许 stdout 输出的路径），写完必须 flush。"""
    decision = {"behavior": behavior}
    if message:
        decision["message"] = message
    out = {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()
    log(f"decision written behavior={behavior}")


def handle_permission(data):
    tool = pick(data, "toolName", "tool_name", "tool") or ""
    tool_input = pick(data, "toolInput", "tool_input")
    detail = str(tool)
    if tool_input is not None:
        detail += " " + json.dumps(tool_input, ensure_ascii=False)
    resp = post("/approval", {"title": "ZCode 请求许可", "detail": detail[:200]})
    approval_id = (resp or {}).get("id") or ""
    if not approval_id:
        return  # 没拿到 id：静默退出，ZCode 默认审批接管
    log(f"approval posted id={approval_id}")
    deadline = time.monotonic() + APPROVAL_WAIT_S
    while time.monotonic() < deadline:
        time.sleep(1.0)
        try:
            r = get_json(f"/approval/poll?id={approval_id}")
        except BaseException:
            continue  # 单次轮询失败（宠物重启中等）不致命，继续等到预算用尽
        status = (r or {}).get("status")
        if status == "allowed":
            emit_decision("allow")
            return
        if status == "denied":
            emit_decision("deny", "主人在桌面宠物上拒绝了这次操作")
            return
    log("approval wait timeout, fallback to ZCode default UI")


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        if not isinstance(data, dict):
            return
        event = extract_event(data)
        log(f"event={event!r} keys={sorted(data.keys())}")
        if not event:
            return
        if event == "PermissionRequest":
            handle_permission(data)
            return
        mapped = EVENT_MAP.get(event)
        if not mapped:
            return
        _path, kind = mapped
        post("/event", {"kind": kind})
        log(f"posted kind={kind}")
    except BaseException:
        # 零副作用：任何失败都不影响 ZCode
        log("exception swallowed")
    finally:
        try:
            sys.stdout.flush()  # os._exit 绕过缓冲刷新，决策 JSON 必须先落管道
        except BaseException:
            pass
        os._exit(0)


if __name__ == "__main__":
    main()
