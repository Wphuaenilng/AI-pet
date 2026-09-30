# Desktop AI Pet 🦊

一个运行在 Windows 桌面上的轻量级 AI 虚拟宠物 —— **一个拥有 AI 灵魂的桌面生物**。

> 本地行为系统负责"身体"，AI 负责"灵魂"。断网时它依然会散步、睡觉、追鼠标。

![tech](https://img.shields.io/badge/Tauri_2-Rust-orange) ![tech](https://img.shields.io/badge/Vue_3-TypeScript-green)

## ✨ 功能一览

- **桌宠核心**：透明、无边框、始终置顶的宠物窗口；透明区域鼠标穿透，不挡操作
- **自主行为**：状态机 + 行为树驱动的散步、坐下、趴下、睡觉（Zzz）、自言自语、跳舞、跑步、爬上窗口顶
- **鼠标互动**：看向鼠标 → 关注 → 追鼠标/扑捉；点击摸摸（爱心 ♥），连续戳会生气；拖拽拎起、松手下落
- **窗口互动**：枚举桌面可见窗口，跳上窗口顶趴着；窗口移动时跟随；窗口关闭时掉下来
- **AI 对话**：OpenAI Compatible API（DeepSeek / OpenAI / Moonshot / Ollama…），AI 返回 `{reply, emotion, action, memory}` 结构化结果，驱动表情、气泡、动作与长期记忆
- **两种人格**：温柔型 🍑 / 务实型 📋，各有独立台词库与提示词参数
- **情绪系统**：happiness / energy / curiosity / affection / boredom 五维状态，可视化在设置面板
- **记忆系统**：短期对话 + 用户信息 + 宠物记忆，本地 JSON 持久化
- **语音**：TTS 播报（Windows SAPI，离线可用）
- **系统托盘**：聊天 / 暂停宠物 / 重新召唤 / 更换宠物 / 设置 / 隐藏宠物 / 退出
- **三种宠物**：小橘猫（奶糖）🐱 / 小白兔（雪团）🐰 / 小狐狸（小狐）🦊，程序化 Canvas 绘制，无素材依赖

## 🚀 开发

前置要求（Windows）：

1. **Node.js ≥ 18** 与 npm
2. **Rust**（rustup，`stable-x86_64-pc-windows-msvc`）
3. **Visual Studio Build Tools**（含 "使用 C++ 的桌面开发" 工作负载）
4. WebView2 Runtime（Win10/11 一般自带）

```bash
npm install
npm run tauri dev     # 开发模式（前端热更新）
```

> 注意：dev 端口固定为 **5199**（vite.config.ts 与 src-tauri/tauri.conf.json 的 devUrl 需一致）。

## 📦 构建发布版

```bash
npm run tauri build   # 产出 NSIS 安装包与独立 exe
```

调试期快速运行（无需打包）：

```bash
npm run build                # 构建前端到 dist/
cd src-tauri && cargo build  # 构建 src-tauri/target/debug/desktop-ai-pet.exe
```

> ⚠️ 注意：debug 版 exe 启动时会连接 vite dev server（localhost:5199），需要先 `npm run dev`。
> **release 版完全自包含**（内嵌 dist），双击即可运行，推荐日常使用 `target/release/desktop-ai-pet.exe`。

## 🤖 配置 AI

托盘菜单 → **设置** → AI 配置：

| 字段 | 示例 |
|---|---|
| API Base URL | `https://api.deepseek.com`（会自动补 `/v1/chat/completions`） |
| API Key | `sk-...`（只保存在本机 `%APPDATA%\com.desktop-ai-pet.app\`） |
| Model | `deepseek-chat` / `gpt-4o-mini` / `moonshot-v1-8k` / 本地 Ollama 模型 |

不配置也能用：宠物会以离线人格台词陪聊，行为系统完全不受影响（验收标准 §27-11）。

## 🖥 预览模式（浏览器）

前端支持脱离 Tauri 在浏览器里预览宠物与界面（假桌面数据）：

```bash
npm run dev
# http://localhost:5199           宠物（左下角有调试按钮）
# http://localhost:5199/?win=chat     聊天窗
# http://localhost:5199/?win=settings 设置中心
```

## 🗂 项目结构

```text
desktop-ai-pet/
├── src/                      # 前端 (Vue 3 + TS)
│   ├── pet/                  # PetBrain 主循环 / PetRenderer 程序化绘制 / PetAnimation / PetState 情绪
│   ├── behavior/             # StateMachine 状态机 / BehaviorTree 行为树 / behaviors 目标与规划器
│   ├── desktop/              # World：显示器/窗口/鼠标的世界模型
│   ├── ai/                   # AIClient / PromptBuilder / Personality 人格与台词 / Memory 记忆
│   ├── chat/                 # 聊天窗口
│   ├── settings/             # 设置中心（含情绪可视化与宠物图鉴）
│   └── lib/tauri.ts          # IPC 封装（浏览器预览自动降级）
├── src-tauri/                # Rust 后端
│   └── src/
│       ├── main.rs           # 入口 + 单实例
│       ├── window.rs         # 窗口控制（位置/缩放/鼠标穿透）
│       ├── desktop.rs        # Win32 枚举显示器/可见窗口/任务栏
│       ├── mouse.rs          # 全局鼠标位置
│       ├── tray.rs           # 系统托盘菜单
│       ├── ai.rs             # OpenAI Compatible 请求
│       ├── tts.rs            # Windows SAPI 语音合成
│       └── store.rs          # 本地 JSON 存储
├── design-assets/            # 吉祥物设计图
└── scripts/                  # 资产生成（图标/头像）
```

## 🏗 架构原则（与设计文档 §26 对应）

1. **行为与 AI 解耦**：AI 不控制窗口与动画，只返回高层意图（`approach_user` / `jump_on_window` / `sit` / `sleep` / `play` / `dance`），由本地行为系统裁决执行
2. **所有行为受状态机约束**：状态转换表见 `src/behavior/StateMachine.ts`
3. **AI 不可用照常运行**：行为全部本地；聊天自动降级为离线台词
4. **API Key 本地保存**：无任何云端中转
5. **稳定性优先**：鼠标穿透按命中区域动态切换；位置同步合并节流；枚举轮询低频；粒子/记忆条目均有上限

## 📁 数据位置

设置与记忆：`%APPDATA%\com.desktop-ai-pet.app\settings.json`、`memory.json`
