# AI-Pet BUG 修复计划

> 来源：2026-09-25 全项目代码审查（前端 21 个文件 + Rust 后端 8 个文件全量通读；vue-tsc 与 cargo check 均零错误通过，问题全部为逻辑/接线层面，编译器查不出来）。
> **结论先行：先执行本计划，再进入《优化改进计划》阶段 0。** 依赖关系与理由见文末第四节。

修复分四批：P0 功能失效 → P1 泄漏与稳定性 → P2 功能接线 → P3 顺手小修。每批独立可验证，P0+P1 建议一次提交。

---

## P0：功能失效（约半天，立即修）

| # | 缺陷 | 位置 | 修法 | 验证 |
|---|---|---|---|---|
| B1 | 窗口枚举恒为空，"跳上窗口顶"整个功能死亡：无 owner 的窗口 `GetWindow` 返回 NULL→`Err`→`unwrap_or(true)` 被跳过；有 owner 的窗口也返回 true 被跳过，两条路全跳 | `src-tauri/src/desktop.rs:146` | `unwrap_or(true)` 改 `unwrap_or(false)`（语义：无 owner 保留，有 owner 跳过） | 启动后宠物日志 `windows>0`；打开记事本，宠物能跳上其标题栏并跟随移动 |
| B2 | chat/settings 窗点原生 X 被销毁，托盘"聊天/设置"永久失效直到重启 | `src-tauri/src/main.rs:36`（setup 无 `on_window_event`） | setup 里对这两个窗口拦截 `CloseRequested` → `api.prevent_close()` + `hide()` | 托盘开聊天→点 X→托盘再开，可正常唤回 |
| B3 | 聊天窗永久卡"思考中"：`memory.save()` 在 try/catch 外，失败后 `thinking` 永不复位 | `src/chat/ChatApp.vue:112` | 把保存段挪进 try/finally，`thinking.value = false` 放 finally | 临时改坏 store 路径模拟失败，聊天窗仍可继续输入 |
| B4 | ~~窗口位置同步永久卡死：`posInFlight` 无 try/finally，`set_pet_position` 一次失败后宠物永不跟随~~ ✅ 已修 2026-09-30：`send()` 整体包 try/finally，finally 里复位 `posInFlight` | `src/pet/PetBrain.ts:822-834` | `send()` 整体包 try/finally，finally 里复位 `posInFlight` | 宠物走动时窗口持续跟随；人为注入一次失败后仍能恢复跟随 |
| B5 | 32ms 鼠标轮询 interval 句柄未保存，`stop()` 清不掉，泄漏且累积；且无 `.catch` | `src/desktop/World.ts:63-74` | 保存句柄，`stop()` 一并清除；`.then` 链补 `.catch(() => {})` | stop/start 循环 10 次，日志无重复轮询、无 unhandled rejection |

## 额外修复（2026-09-30，用户报告"小猫呆在右下角不动，不能拖拽点击"）

| 缺陷 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 行为树 Selector 提前退出：内层 Sequence 返回 `'success'`（条件满足但子 Selector 未命中）被外层当成 Goal 返回，导致后续分支（含随机行为池）永远走不到 | `src/behavior/BehaviorTree.ts:16-22` | Selector.tick 跳过 `'failure'` 和 `'success'`，只返回 Goal 对象 | 浏览器预览 30 秒采样，猫会走/坐/跳/爬 |
| pickRandomBehavior 概率失衡：0.07+0.16+0.13+0.21=57% 概率返回 IdleGoal（其中 21% 是 RunGoal 被 clamp 到边界后秒回 'arrived'） | `src/pet/PetBrain.ts:612-649` | 降低 IdleGoal 到 6%，移除无效 RunGoal 分支，概率分给 WanderGoal/SitGoal/SleepGoal 等 | 采样中 WanderGoal/SitGoal/LayGoal 正常轮换 |
| 预览模式 winX/winY 未初始化：预览分支没有 syncWindowPos，`winX/winY` 一直为 0，导致渲染和物理不同步 | `src/pet/PetBrain.ts:180-188` | 预览模式初始化时调用 `markPosDirty()`，让 tick 末尾的 syncWindowPos 重算 winX/winY | 预览模式猫位置正确 |

| # | 缺陷 | 位置 | 修法 | 验证 |
|---|---|---|---|---|
| B6 | TTS 每次泄漏 2 个内核句柄（`Child` 被丢弃）；连续说话并发重叠、无排队 | `src-tauri/src/tts.rs:58` | 保留 `Child` 句柄（或 try_wait 收尸）；加"上一句未读完先取消/跳过"的单飞逻辑 | 连续触发 20 次语音，任务管理器句柄数平稳；快速连说不叠音 |
| B7 | 事件监听器与定时器 `stop()` 不清理：canvas `pointerdown`、window `pointerup`、`dblclick`、预览 `resize`、onLand/pickRandomBehavior/onPatted 的 setTimeout、DEV 心跳 interval | `src/pet/PetBrain.ts:224-228、409、617、779、264` | 统一登记到 `this.disposers` 数组，`stop()` 遍历执行；setTimeout 改为可取消封装 | stop/start 循环后摸摸、双击、落地各触发一次（不重复触发） |
| B8 | `refresh()` 与鼠标轮询无 catch，后端偶发错误即 rejection 风暴；预览分支 mousemove/mousedown/up 监听不移除 | `src/desktop/World.ts:59-62、47-56` | 补 `.catch(() => {})`（或记入 frontend_log）；预览监听器登记并在 stop 移除 | 挂机 1h 无 unhandled rejection 刷屏 |
| B9 | pet 窗口硬编码 `x:1200,y:700` 且 `visible:true`，小屏启动先闪现在错误位置 | `src-tauri/tauri.conf.json:20-21` | 去掉 x/y（或 `visible:false`），由 `window.rs` setup 定位后 show | 1366×768 屏启动，宠物直接出现在右下角，无闪跳 |
| B10 | 损坏的 settings.json/memory.json 被静默当"不存在"，用户数据无提示重置 | `src-tauri/src/store.rs:38-39` | 解析失败时区分返回错误，前端读到损坏标记时提示"存档损坏已重置"（并顺手备份坏文件为 `.bak`） | 手工写坏 JSON，启动有提示且生成 .bak |
| B11 | `start()` 关键路径（get_window_info/set_pet_scale）无异常保护，任一失败宠物窗白屏静默死亡 | `src/pet/PetBrain.ts:144-166` + `PetApp.vue:20` | start 包 try/catch，失败写 frontend_log 并重试一次；`PetApp.vue` 的 promise 补 `.catch` | 临时改坏命令名模拟失败，控制台有明确错误而非静默白屏 |

## P2：功能接线（约 1-2 天，"写了但没接"的未完成项）

| # | 缺陷 | 位置 | 修法 |
|---|---|---|---|
| B12 | `pet://memory-event` 发出 4 处、监听 0 处——宠物自动记忆空转，记忆里永远只有"和用户聊天" | `src/pet/PetBrain.ts:677/707/770/783` | 聊天窗 MemoryStore 监听该事件并 `addPetMemory` + 落盘；加去重与条数上限（上限已有） |
| B13 | 喂给 AI 的情绪/状态是硬编码常量，AI 感知不到宠物真实心情 | `src/chat/ChatApp.vue:81-83` | 聊天窗监听 `pet://emotion`（已有广播，PetBrain.ts:340），发送时用最新值 |
| B14 | 4 组台词写好未接线：拖拽/放下/犯困/玩耍开心无台词 | `src/ai/Personality.ts:58-75` | 在 dragStart/onLand/进入 SLEEP/玩耍成功路径补 `pickCanned` 调用 |
| B15 | 死代码清理或接线：`headTilt` 每帧归零（倾斜功能全链路无效）、`INTERACT`/`SAD`/`concern`/`wink` 不可达、ClimbGoal 空中纠偏永不执行、`takePendingIntent` 死变量、`updateEyes`/`onCursorMove` 空函数、ApproachAndSpeakGoal 每帧重掷随机方向（醉步抖动） | `PetBrain.ts:567-591、642、296`；`goals.ts:308` | headTilt 接进 compose 或删；随机侧在 start 固定；空中也调 updateGoal（只禁位移）；其余按"接线或删除"二选一，不留半成品 |
| B16 | 设置窗"清空记忆"与聊天窗内存态竞态，旧记忆下次保存时"复活" | `SettingsApp.vue:136` ↔ `ChatApp.vue:112` | 清空后广播 `settings://updated`（已有通道），聊天窗收到后重载 MemoryStore |
| B17 | scale 范围三处不一致（Rust 0.5–2 / UI 0.6–1.6）；DEFAULT_SETTINGS 三处手抄 | `store.ts:18`、`SettingsApp.vue:294`、`window.rs:49` | 范围统一为一处常量；DEFAULT_SETTINGS 收敛到 `lib/tauri.ts` 单源导出 |

## P3：顺手小修（随上面批次带走，不单开）

- `ai.rs`：reqwest Client 放入 State 复用；补 `connect_timeout`；请求带 `max_tokens`；`resp.text()` 错误不再吞成"解析失败"。（`src-tauri/src/ai.rs:56-75`）
- TTS 静默失败可见化：去掉 `SilentlyContinue` 一刀切，失败写 `frontend_log`，用户至少能在日志看到"无中文语音"。（`tts.rs:28-35`）
- 暂停状态同步：设置窗切换暂停时同步托盘菜单文字（读 `PauseState` 或发事件给托盘）。（`tray.rs:49-60`、`SettingsApp.vue:152`）
- 昵称正则收紧：排除"我是说/叫我怎么办"等误伤句式，提取后气泡里确认一次。（`ChatApp.vue:96-99`）
- `PromptBuilder.ts:45`：`.filter(l => l !== '')` 误删空行哨兵，改用显式分隔逻辑；`:69` JSON 缺 `reply` 时不要把原始 JSON 读出来，走离线兜底。
- 补 bunny 头像（可先用 `scripts/make-assets.ps1` 生成，或继续 emoji 兜底并接受）。

---

## 与《优化改进计划》的关系（谁先谁后）

**先执行本计划，再进入优化计划阶段 0**，理由：

1. **优化计划 M0 的验收标准会被现有 BUG 污染**。"连续挂机 8h 内存涨幅 < 30MB"——B5/B6/B7/B8 这四组泄漏不修，内存基线测出来就是假的，阶段 0 的"内存预算与监控"等于在流沙上建baseline。
2. **B1 是优化计划多个阶段的地基**。阶段 0 的"多显示器适配"、阶段 2 的"窗口互动增强"、行为树里所有窗口相关分支，全部建立在 `get_desktop_info().windows` 之上——这个列表现在是恒空的，不修则这些改进是在死地基上开发、也无法验证。
3. **B2 是阶段 0"全局热键"的前置**。窗口被原生销毁后热键也唤不回，先拦截关闭才有资格谈热键召唤。
4. **B12/B13/B16 是阶段 3"记忆系统升级"的硬前置**。SQLite/embedding 是在记忆链路上的升级——现在这条链路本身有断点（事件无消费者、竞态复活、AI 读不到情绪），先闭环再升级，否则新旧问题混在一起查不动。
5. **本计划量小风险低**。全部是定点修复，无架构改动，估 3-5 个工作日（P0 半天 + P1 一天 + P2 一两天 + P3 随手）；优化计划阶段 0 起步就是一周量级。先用小成本把调试噪音（rejection 风暴、静默白屏）清掉，后续开发的日志才是干净的。
6. **优化计划自己也这么排序**：阶段 0 的定位就是"先还债不加功能"——本计划正是其中"债"里最优先的部分，相当于把它提前拆成了"阶段 -1"。

**重叠项去重**：优化计划阶段 0 的"排查 rAF 循环、事件监听泄漏"与本计划 B7/B8 是同一件事，执行完本计划后在优化计划里直接勾掉；阶段 0 的"多显示器/竖屏适配"动 `World.ts` 与 `window.rs`，请在 B1/B9 合入后再开工，避免同文件冲突。P2 批次（B12-B17）如着急开皮肤包（阶段 1），可与阶段 0 并行或顺延，但 **P0+P1（B1-B11）是任何后续工作的硬门槛**。

## 验证方式

- 每批修完：`npx vue-tsc --noEmit` + `cargo check` 过 → `npm run tauri dev` 按上表"验证"列手工过一遍。
- P1 完成后加一次 1h 挂机观察（任务管理器句柄数与内存平稳、无 rejection 刷屏）。
- 全部完成后跑一次 `npm run tauri build`，release 版按验收标准 §27 的 13 条过一遍（重点 5/6/12/13）。
