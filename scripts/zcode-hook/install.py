#!/usr/bin/env python3
"""编码代理 hooks 幂等安装器（整改计划 M6-P1/P3，§9.3-6）。

用法（默认 --target zcode）：
  python install.py install  [--target zcode|claude]   # 注册钩子（重复运行不重复添加）
  python install.py uninstall [--target zcode|claude]  # 只删除本安装器添加的组
  python install.py status   [--target zcode|claude]   # 查看注册状态

目标与配置结构（只改用户级配置，§9.5：不动工作区配置、不动其他字段）：
- zcode：~/.zcode/cli/config.json 的 hooks.enabled + hooks.events.<事件>，
  组内 type=process（command+args+timeoutMs 毫秒）。
- claude：~/.claude/settings.json 的 hooks.<事件>（无 events 层、无总开关），
  组内 type=command（shell 字符串+timeout 秒）。M6-P3 同构移植。

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
TARGETS = ("zcode", "claude")

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


def config_path(target):
    if target == "claude":
        return Path.home() / ".claude" / "settings.json"
    return Path.home() / ".zcode" / "cli" / "config.json"


def load_config(target):
    path = config_path(target)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        # 配置损坏时不要覆盖：让使用者先处理
        print(f"错误：{path} 不是合法 JSON，请先修复。")
        sys.exit(1)


def make_group(event, target):
    # 组 schema 只保留目标 harness 认识的键（matcher/hooks）。
    # PermissionRequest 需要等主人在宠物上点决策，给 120s（钩子内轮询预算 110s，
    # 超时后静默退出，harness 默认审批 UI 接管）。
    if target == "claude":
        # Claude Code：type=command（shell 字符串），timeout 单位为秒
        return {
            "matcher": "*",
            "hooks": [
                {
                    "type": "command",
                    "command": f'"{sys.executable}" "{HOOK_SCRIPT}"',
                    "timeout": 120 if event == "PermissionRequest" else 10,
                }
            ],
        }
    # ZCode：type=process（command+args），timeoutMs 毫秒
    return {
        "matcher": "*",
        "hooks": [
            {
                "type": "process",
                "command": sys.executable,
                "args": [str(HOOK_SCRIPT)],
                "timeoutMs": 120000 if event == "PermissionRequest" else 3000,
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


def events_container(cfg, target, create):
    """事件名 → 组列表的字典：zcode=hooks.events（并确保总开关），claude=hooks 本身。"""
    hooks = cfg.get("hooks")
    if hooks is None and create:
        hooks = {}
        cfg["hooks"] = hooks
    if not isinstance(hooks, dict):
        return None
    if target == "claude":
        return hooks
    if create:
        # 总开关：缺省时 ZCode 不创建 HookRunner，事件配置不会触发（见文件头踩坑记录）
        hooks["enabled"] = True
    events = hooks.get("events")
    if events is None and create:
        events = {}
        hooks["events"] = events
    return events if isinstance(events, dict) else None


def cmd_install(target):
    cfg = load_config(target)
    events = events_container(cfg, target, create=True)
    if events is None:
        print("错误：hooks 配置结构异常（不是对象），无法安装。")
        sys.exit(1)

    added, updated = [], []
    for name in EVENTS:
        group = make_group(name, target)
        lst = events.get(name)
        if lst is None:
            lst = []
            events[name] = lst
        if not isinstance(lst, list):
            print(f"错误：hooks.{name} 不是数组，无法安装。")
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

    path = config_path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已安装（{target}）：新增 {len(added)} 个事件（{', '.join(added) or '无'}），"
          f"更新 {len(updated)} 个（{', '.join(updated) or '无'}）。")
    print(f"配置：{path}")


def cmd_uninstall(target):
    path = config_path(target)
    if not path.exists():
        print("未安装（配置文件不存在）。")
        return
    cfg = load_config(target)
    events = events_container(cfg, target, create=False)
    if events is None:
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
        path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"已卸载（{target}）：移除 {len(removed)} 个事件（{', '.join(removed)}），其他配置未动。")
    else:
        print("未安装（没有找到 ai-pet 钩子组）。")


def cmd_status(target):
    path = config_path(target)
    print(f"目标：{target}　配置：{path}")
    print(f"桥接：http://127.0.0.1:7788（宠物运行时）")
    if not path.exists():
        print("状态：未安装（配置文件不存在）")
        return
    cfg = load_config(target)
    events = events_container(cfg, target, create=False)
    if events is None:
        print("状态：未安装（无 hooks 配置）")
        return
    if target == "zcode":
        enabled = (cfg.get("hooks") or {}).get("enabled")
        print(f"总开关 hooks.enabled：{enabled!r}"
              + ("" if enabled is True else "  ← 未开启，钩子不会触发！请运行 install"))
    ok = 0
    for name in EVENTS:
        lst = events.get(name)
        ours = [g for g in lst if is_ours(g)] if isinstance(lst, list) else []
        if ours:
            ok += 1
            g = ours[0]
            hooks_def = (g.get("hooks") or [{}])[0]
            print(f"  [✓] {name}: {hooks_def.get('command')} {hooks_def.get('args') or ''}")
        else:
            print(f"  [ ] {name}")
    print(f"状态：{ok}/{len(EVENTS)} 事件已注册" + ("（已安装）" if ok == len(EVENTS) else ""))


COMMANDS = {"install": cmd_install, "uninstall": cmd_uninstall, "status": cmd_status}

if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "status"
    target = "zcode"
    if "--target" in args:
        i = args.index("--target")
        target = args[i + 1] if i + 1 < len(args) else ""
    if cmd not in COMMANDS or target not in TARGETS:
        print(__doc__)
        sys.exit(1)
    COMMANDS[cmd](target)
