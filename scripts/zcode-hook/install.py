#!/usr/bin/env python3
"""ZCode hooks 幂等安装器（整改计划 M6-P1，§9.3-6）。

用法：
  python install.py install    # 注册钩子（重复运行不重复添加）
  python install.py uninstall  # 只删除本安装器添加的组，不动其他配置
  python install.py status     # 查看注册状态

只改用户级 ~/.zcode/cli/config.json 的 hooks.events（§9.5：不动工作区配置、
不动配置里其他字段）。

本安装器添加的组按"内容特征"识别（组内任一 hook 的 command/args 引用
pet_hook.py），不使用自定义键——ZCode 的组 schema 只认 matcher/hooks，
多余键（如 id）会导致整个用户配置文件加载失败（2026-11-03 实机踩坑，
见 ~/.zcode/cli/log/zcode-*.jsonl 的 config.file.invalid 记录）。

2026-11-03 二次踩坑（读 zcode.cjs 运行时代码确认）：
- 用户级 hooks 有总开关 hooks.enabled，缺省=false 时 HookRunner 整个不创建
  （oyt: e.config.enabled ? ... : []），事件配置再多也不会触发，且无任何
  日志/UI 提示。必须显式写 "enabled": true。
- process 类型钩子的超时键是 timeoutMs（不是 timeout，后者被 passthrough
  忽略，会落回默认 60s）。
- matcher "*" 是合法通配（ZSo: t==="*" → true）。
"""
import json
import sys
from pathlib import Path

HOOK_SCRIPT = Path(__file__).resolve().parent / "pet_hook.py"
CONFIG_PATH = Path.home() / ".zcode" / "cli" / "config.json"

# 7 个事件（P2 补 PostToolUse：前端低频摘要气泡）
EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "PermissionRequest",
]


def load_config():
    if not CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        # 配置损坏时不要覆盖：让使用者先处理
        print(f"错误：{CONFIG_PATH} 不是合法 JSON，请先修复。")
        sys.exit(1)


def make_group(event):
    # 组 schema 只保留 ZCode 认识的键（matcher/hooks）；
    # process 钩子的超时键是 timeoutMs（毫秒）：普通事件 3s（python 冷启动 + HTTP 500ms）；
    # PermissionRequest 需要等主人在宠物上点决策，给 120s（钩子内轮询预算 110s，
    # 超时后静默退出，ZCode 默认审批 UI 接管）
    timeout_ms = 120000 if event == "PermissionRequest" else 3000
    return {
        "matcher": "*",
        "hooks": [
            {
                "type": "process",
                "command": sys.executable,
                "args": [str(HOOK_SCRIPT)],
                "timeoutMs": timeout_ms,
            }
        ],
    }


def is_ours(group):
    """内容特征识别本安装器的组：兼容旧的 id 标记（迁移用）+ pet_hook.py 路径。"""
    if not isinstance(group, dict):
        return False
    if group.get("id") == "ai-pet":  # 旧版残留（该键会导致配置整体加载失败）
        return True
    for h in group.get("hooks") or []:
        if not isinstance(h, dict):
            continue
        if "pet_hook.py" in str(h.get("command") or ""):
            return True
        if any("pet_hook.py" in str(a) for a in h.get("args") or []):
            return True
    return False


def cmd_install():
    cfg = load_config()
    hooks = cfg.get("hooks")
    if hooks is None:
        hooks = {}
        cfg["hooks"] = hooks
    if not isinstance(hooks, dict):
        print("错误：config.json 的 hooks 字段不是对象，无法安装。")
        sys.exit(1)
    # 总开关：缺省时 ZCode 不创建 HookRunner，事件配置不会触发（见文件头踩坑记录）
    hooks["enabled"] = True
    events = hooks.get("events")
    if events is None:
        events = {}
        hooks["events"] = events
    if not isinstance(events, dict):
        print("错误：config.json 的 hooks.events 字段不是对象，无法安装。")
        sys.exit(1)

    added, updated = [], []
    for name in EVENTS:
        group = make_group(name)
        lst = events.get(name)
        if lst is None:
            lst = []
            events[name] = lst
        if not isinstance(lst, list):
            print(f"错误：hooks.events.{name} 不是数组，无法安装。")
            sys.exit(1)
        ours = [g for g in lst if is_ours(g)]
        if ours:
            # 原位置更新第一个，清掉多余的本方组（防重复）
            ours[0].clear()
            ours[0].update(group)
            for extra in ours[1:]:
                lst.remove(extra)
            updated.append(name)
        else:
            lst.append(dict(group))
            added.append(name)

    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已安装：新增 {len(added)} 个事件（{', '.join(added) or '无'}），"
          f"更新 {len(updated)} 个（{', '.join(updated) or '无'}）。")
    print(f"配置：{CONFIG_PATH}")


def cmd_uninstall():
    if not CONFIG_PATH.exists():
        print("未安装（配置文件不存在）。")
        return
    cfg = load_config()
    hooks = cfg.get("hooks")
    if not isinstance(hooks, dict):
        print("未安装。")
        return
    events = hooks.get("events")
    if not isinstance(events, dict):
        print("未安装。")
        return
    removed = []
    for name, lst in list(events.items()):
        if not isinstance(lst, list):
            continue
        kept = [g for g in lst if not is_ours(g)]
        if len(kept) != len(lst):
            removed.append(name)
            if kept:
                events[name] = kept
            else:
                del events[name]
    if removed:
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"已卸载：移除 {len(removed)} 个事件（{', '.join(removed)}），其他配置未动。")
    else:
        print("未安装（没有找到 ai-pet 钩子组）。")


def cmd_status():
    print(f"配置：{CONFIG_PATH}")
    print(f"桥接：http://127.0.0.1:7788（宠物运行时）")
    if not CONFIG_PATH.exists():
        print("状态：未安装（配置文件不存在）")
        return
    cfg = load_config()
    hooks = cfg.get("hooks")
    if not isinstance(hooks, dict):
        print("状态：未安装（无 hooks 配置）")
        return
    events = hooks.get("events")
    if not isinstance(events, dict):
        print("状态：未安装（无 hooks.events）")
        return
    print(f"总开关 hooks.enabled：{hooks.get('enabled')!r}"
          + ("" if hooks.get("enabled") is True else "  ← 未开启，钩子不会触发！请运行 install"))
    ok = 0
    for name in EVENTS:
        lst = events.get(name)
        ours = [g for g in lst if is_ours(g)] if isinstance(lst, list) else []
        if ours:
            ok += 1
            g = ours[0]
            hooks_def = (g.get("hooks") or [{}])[0]
            print(f"  [✓] {name}: {hooks_def.get('command')} {hooks_def.get('args')}")
        else:
            print(f"  [ ] {name}")
    print(f"状态：{ok}/{len(EVENTS)} 事件已注册" + ("（已安装）" if ok == len(EVENTS) else ""))


COMMANDS = {"install": cmd_install, "uninstall": cmd_uninstall, "status": cmd_status}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    COMMANDS[cmd]()
