# AI-Pet BUG 修复计划

> 来源：2026-09-25 全项目代码审查（前端 21 个文件 + Rust 后端 8 个文件全量通读；vue-tsc 与 cargo check 均零错误通过，问题全部为逻辑/接线层面，编译器查不出来）。
> **结论先行：先执行本计划，再进入《优化改进计划》阶段 0。** 依赖关系与理由见文末第四节。

修复分四批：P0 功能失效 → P1 泄漏与稳定性 → P2 功能接线 → P3 顺手小修。每批独立可验证，P0+P1 建议一次提交。

> **2026-10-03 复核**：B1–B17 与 P3 在代码层面均已落实，`vue-tsc` / `vite build` / `cargo check` 全绿，并已用 `npm run tauri dev` 做实机验证——逐条状态见文末「2026-10-03 复核」一节。该节另记 4 个原清单未覆盖的新缺陷 **B18–B21**，其中 B18 是 B4 修法引入的回归（正是它导致"宠物不动、点不到也拖不动"）。

---

## P0：功能失效（约半天，立即修）

| # | 缺陷 | 位置 | 修法 | 验证 |
|---|---|---|---|---|
| B1 | 窗口枚举恒为空，"跳上窗口顶"整个功能死亡：无 owner 的窗口 `GetWindow` 返回 NULL→`Err`→`unwrap_or(true)` 被跳过；有 owner 的窗口也返回 true 被跳过，两条路全跳 | `src-tauri/src/desktop.rs:146` | `unwrap_or(true)` 改 `unwrap_or(false)`（语义：无 owner 保留，有 owner 跳过） | 启动后宠物日志 `windows>0`；打开记事本，宠物能跳上其标题栏并跟随移动 |
| B2 | chat/settings 窗点原生 X 被销毁，托盘"聊天/设置"永久失效直到重启 | `src-tauri/src/main.rs:36`（setup 无 `on_window_event`） | setup 里对这两个窗口拦截 `CloseRequested` → `api.prevent_close()` + `hide()` | 托盘开聊天→点 X→托盘再开，可正常唤回 |
| B3 | 聊天窗永久卡"思考中"：`memory.save()` 在 try/catch 外，失败后 `thinking` 永不复位 | `src/chat/ChatApp.vue:112` | 把保存段挪进 try/finally，`thinking.value = false` 放 finally | 临时改坏 store 路径模拟失败，聊天窗仍可继续输入 |
| B4 | ~~窗口位置同步永久卡死：`posInFlight` 无 try/finally，`set_pet_position` 一次失败后宠物永不跟随~~ ⚠️ 2026-09-30 的修法不完整：try/finally 确实保住了 `posInFlight`，但脏标记在进循环前就被消费掉，导致 `set_pet_position` 一次都没调用过 → 见 **B18** | `src/pet/PetBrain.ts:822-834` | `send()` 整体包 try/finally，finally 里复位 `posInFlight` | 宠物走动时窗口持续跟随；人为注入一次失败后仍能恢复跟随 |
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

## 2026-10-03 复核：验证状态 + 本轮新增缺陷

### 环境已打通（下次别再踩）

- `npm install` 必须带 `--registry=https://registry.npmmirror.com`：`package-lock.json` 的 `resolved` 全在 npmmirror，而 npm 12 默认 `allow-remote = "none"`，registry 不一致时所有 tarball 被判为 remote 直接拒绝（`EALLOWREMOTE`）。
- 已装 rustup（`stable-x86_64-pc-windows-msvc`）+ VS 2022 Build Tools（VCTools 工作负载）。**注意**：`C:\Program Files\Git\usr\bin\link.exe` 是 coreutils 的 `ln` 克隆，没有真 MSVC 时 rustc 会误用它，报错形如 `link: extra operand '...rcgu.o'`——那是"链接器找错人"，不是链接失败。
- `npm run tauri dev` 内部是裸 `cargo run`，不吃 `--config`，所以仓库根放了 `.cargo/config.toml`（rsproxy 源替换）；它是未跟踪文件，决定是否 `.gitignore` 或提交。

### 编译级验证（全部通过）

| 命令 | 结果 |
|---|---|
| `vue-tsc --noEmit` | 0 错误 |
| `vite build` | 成功产出 `dist/` |
| `cargo check`（src-tauri） | exit 0，**0 error / 0 warning**，冷编译 3m19s |

### 实机验证（`npm run tauri dev`）

已确认：`world started monitors=1 windows=2`（B1 生效）、`settings ok, scale=1 species=cat`、心跳状态轮换覆盖 WALK/SIT/LAY/SLEEP/TALK/LOOK/JUMP 且 `air=true→false` 落地正常（9-30 三条追加修复生效）、全程 **0 条 error / panic / unhandled rejection**。

| 项 | 代码 | 实机 | 备注 |
|---|---|---|---|
| B1 窗口枚举 | ✅ | ✅ `windows=2` | "跳上标题栏并跟随"依赖 B18，需重测 |
| B2 拦截原生关闭 | ✅ | ⬜ | 需托盘：关聊天窗再唤回 |
| B3 聊天卡思考中 | ✅ | ⬜ | 需注入保存失败 |
| B4 `posInFlight` | ✅ | ❌ | **修法不完整，见 B18** |
| B5 轮询句柄 | ✅ | ⬜ | 需 stop/start 循环 |
| B6 TTS `Child` 泄漏 | ✅ | ⬜ | 需连续 20 次语音看句柄数 |
| B7 监听器/定时器登记 | ✅ | ⬜ | 需 stop/start 后看摸摸是否重复触发 |
| B8 refresh/轮询 catch | ✅ | 部分 | 挂机期间 0 rejection |
| B9 启动不闪跳 | ✅ | 部分 | 本机单屏正常；1366×768 待测 |
| B10 损坏存档提示 | ✅ | ⬜ | 需手写坏 JSON 看 `.bak` |
| B11 `start()` 异常保护 | ✅ | 部分 | 无静默白屏，未注入失败 |
| 追加三条（行为树/概率/预览几何） | ✅ | ✅ | 见上表状态轮换 |
| B12 memory-event 消费 | ✅ | ⬜ | 需看 `memory.json` 是否长出非聊天记忆 |
| B13 真实情绪喂 AI | ✅ | ⬜ | 需抓 prompt 或看 AI 回应 |
| B14 四组台词接线 | ✅ | ⬜ | 拖拽/放下/犯困/玩耍 |
| B15 死代码接线或删除 | ✅ | ⬜ | `headTilt`/`concern`/`updateAir` 已接，观感待看 |
| B16 清空记忆竞态 | ✅ | ⬜ | 需双窗操作 |
| B17 scale/默认值单源 | ✅ | ⬜ | ⚠️ Rust 端 `window.rs:51` 仍硬编码 `clamp(0.5, 2.0)`，与前端常量同值但双写，未真正单源 |
| P3 小修 | ✅ | ⬜ | bunny 头像仍 emoji 兜底（计划内已允许） |

### 本轮新增缺陷（原清单未覆盖）

| # | 缺陷 | 位置 | 修法 | 状态 |
|---|---|---|---|---|
| B18 | **`syncWindowPos` 在进循环前就消费掉脏标记**：`if (!posDirty) return` 之后紧跟 `posDirty = false`，而 `void send()` 是同步调用、其 `while (this.posDirty)` 立即求值 → 循环体一次都不执行，`set_pet_position` **从未被调用**（日志 0 条），宠物窗永不跟随。连带 `winX/winY` 只按物理坐标乐观更新而与真实窗口脱钩 → `updateHitTest` 恒 false → `set_pet_ignore_cursor_events(ignore: true)` 常驻，鼠标对整个窗口穿透，**点不到也拖不动**。这是 B4 修法引入的回归 | `src/pet/PetBrain.ts:843-876` | 删掉循环前的 `this.posDirty = false`，交给 `while` 自己消费 | ✅ 已修并实机验证：修复后同一时刻前端发送值与 OS 窗口物理矩形逐项对齐（697↔700、543↔547、393↔396、241↔243），累计 4603 次调用、0 失败 |
| B19 | `autoActivity` 名不副实：只在"主动搭话"分支和 `maybeProactive` 被读，随机行为池完全不受控，关掉开关它照样满屏走 | `src/behavior/behaviors/planner.ts:65` | 随机池外套 `Sequence([Cond(ctx => ctx.settings.autoActivity), Act(...)])`；Selector 已能跳过 `'success'`，条件不满足时自然落到兜底 IdleGoal | ✅ 已修，待复测"关掉后只回应交互" |
| B20 | 设置/聊天窗 `skipTaskbar: true`：点减号后窗口进入"任务栏上没有入口"的最小化态，用户观感是"直接进了托盘" | `src-tauri/tauri.conf.json` settings/chat 两项 | ⚠️ 第一次修反了方向（加了 `minimizable: false` 把减号禁掉）。用户要的是**能最小化到任务栏**，正解是 `"skipTaskbar": false`，让两窗出现在任务栏、减号可用且可还原 | ✅ 已改为 skipTaskbar:false 并恢复默认可最小化，待复测 |
| B21 | 设置窗三处布局不和谐：① `.field input` 选择器同时命中 range，把文本框的边框/内边距/底色套上滑块，加上未声明 `color-scheme`，WebView2 按系统深色模式画原生轨道 → 一条黑杠；② `.switch-row` 用 `flex-wrap`，5 个开关排成 3+2 失衡；③ `.hero-actions` 三颗胶囊被 flex 压缩，"聊天"二字竖排拆行 | `src/settings/SettingsApp.vue` CSS、`src/style.css` | ① 加 `.field input[type='range']` 覆盖 + 全局 `color-scheme: light`；② 开关区改 `grid-template-columns: repeat(2, minmax(0,1fr))`；③ 按钮 `flex: 0 0 auto; white-space: nowrap`，gap 8→6、padding 12→10 | ✅ 已修并在 420px 宽度实测：三按钮一行（需 226px / 可用 232px）、开关区两列三行、滑块 `border: 0px none` 且高 22px。② 后续又发现仅 `color-scheme` 不足以让轨道变浅，已改为 `-webkit-appearance:none` + 自绘 `::-webkit-slider-runnable-track`（6px `#f0e0d6`）与 thumb |
| B22 | **`PetApp.vue` 没有卸载钩子**：HMR 或组件重挂载时旧 `PetBrain` 的 rAF 与 `World` 鼠标轮询继续跑，多个 brain 同时 `set_pet_position` 驱动同一个 OS 窗口。表现为**拖拽时窗口闪烁**、以及"把自动活动关掉照样走动"（旧 brain 跑的是改动前的 Planner）。日志特征：`start begin` 次数远大于页面加载次数，心跳里出现两条互不相干的 x 轨迹（其中一条恒定越界，如 `x=2572` > 屏宽 1920） | `src/pet/PetApp.vue:12-28` | `onBeforeUnmount(() => { brain.value?.stop(); brain.value = null })` | ✅ 已修并实机验证：干净重启后 `start begin=1`、x 轨迹单一恒定、`max x=1667 < 1920`；`autoActivity=false` 状态下 45s 内目标只有 `idle`/`enter`，**无 wander** |
| B23 | `clearMemory()` 只写空存档、不广播：聊天窗内存里的旧记忆会在它下次 `save()` 时把空存档覆盖回去。B16 的修法只补了消费端（聊天窗会重载），生产端从没发过事件 | `src/settings/SettingsApp.vue` `clearMemory` | `resetMemory()` 之后 `await saveSettings({ ...s })` 触发 `settings://updated` | ✅ 已修，待双窗复测 |
| B24 | 提示用的是原生 `alert` / `confirm`：WebView2 弹出的是灰底系统对话框（标题还带 `localhost:5199 显示`），与奶油色设计语言冲突 | `src/settings/SettingsApp.vue` 3 处调用 | 换成应用内组件弹框：`askConfirm(text): Promise<boolean>` + `showAlert(text)`，遮罩 + 卡片 + 胶囊按钮，沿用 `.onboard` 视觉 | ✅ 已改，待复测观感 |

### 仍未验证（下一步）

B1 后半段跳窗跟随、B2 托盘唤回、B6 句柄数、B5/B7/B8 的 stop/start 循环、B10 损坏存档、B12-B17 的功能观感、1h 挂机内存基线、`npm run tauri build` 的 release 验收。

本轮改动的肉眼复测（需要人看/人手操作）：拖拽是否还闪（B22 修后应为单 brain）、拖拽手感（B18 修后窗口才第一次真正跟随）、设置窗减号能否最小化并从任务栏还原（B20）、组件弹框观感（B24）、滑块轨道是否已变浅（B21②）。

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
