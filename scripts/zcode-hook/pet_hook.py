#!/usr/bin/env python3
"""ZCode → Desktop AI Pet 桥接钩子（整改计划 M6-P1）。

ZCode hooks 机制：配置于 ~/.zcode/cli/config.json 的 hooks.events，
process 钩子在事件触发时以 stdin JSON（HookInput）调用本脚本。

零副作用原则（§9.3-1）：
- 任何异常都被吞掉，退出码恒 0，stdout 恒空——宠物绝不能拖垮 ZCode 回合
- HTTP 超时 500ms，fire-and-forget
- 本脚本不打印任何日志到 stdout（协议要求 stdout 只出决策 JSON，P1 无决策）

P1 事件映射（§9.2）：
  SessionStart         → POST /event {kind: agent-session}
  UserPromptSubmit     → POST /event {kind: agent-thinking}
  PreToolUse           → POST /event {kind: agent-working}
  PostToolUseFailure   → POST /event {kind: agent-failed}
  Stop                 → POST /event {kind: agent-done}
  PermissionRequest    → POST /approval {title, detail}（复用 M5 审批闭环，P2 做决策回写）
  PostToolUse          → 忽略（P2 低频摘要）
"""
import json
import os
import sys
import urllib.request

BRIDGE = os.environ.get("PET_BRIDGE_URL", "http://127.0.0.1:7788")
TIMEOUT = 0.5

EVENT_MAP = {
    "SessionStart": ("event", "agent-session"),
    "UserPromptSubmit": ("event", "agent-thinking"),
    "PreToolUse": ("event", "agent-working"),
    "PostToolUseFailure": ("event", "agent-failed"),
    "Stop": ("event", "agent-done"),
}

# ZCode 协议字段若升级可能改名，逐个兜底取（§9.5：解析失败静默跳过）
EVENT_KEYS = ("event", "hook_event_name", "type", "event_name")


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
        resp.read()


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        if not isinstance(data, dict):
            return
        event = extract_event(data)
        if not event:
            return
        if event == "PermissionRequest":
            tool = data.get("tool_name") or data.get("tool") or ""
            title = "ZCode 请求许可"
            detail = str(tool)[:120]
            post("/approval", {"title": title, "detail": detail})
            return
        mapped = EVENT_MAP.get(event)
        if not mapped:
            return
        _path, kind = mapped
        post("/event", {"kind": kind})
    except BaseException:
        # 零副作用：任何失败都不影响 ZCode（含 KeyboardInterrupt 之外的系统退出）
        pass
    finally:
        os._exit(0)  # 绕过缓冲刷新，保证不往 stdout 写任何东西


if __name__ == "__main__":
    main()
