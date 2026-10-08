#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod desktop;
mod mouse;
mod petdex;
mod server;
mod store;
mod tray;
mod tts;
mod window;

use tauri::Manager;

/// 全局热键 Ctrl+Shift+P：宠物可见则隐藏，否则召唤回光标所在屏（附录 A.1）
fn toggle_pet_visible(app: &tauri::AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        if pet.is_visible().unwrap_or(false) {
            let _ = pet.hide();
        } else {
            let _ = pet.unminimize();
            let _ = pet.show();
            use tauri::Emitter;
            let _ = app.emit_to("pet", "tray://summon", ());
        }
    }
}

/// 开机自启状态（走 autostart 插件的 Rust API，前端无需插件 JS 包与 capabilities）
#[tauri::command]
fn autostart_status(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enable {
        al.enable().map_err(|e| e.to_string())
    } else {
        al.disable().map_err(|e| e.to_string())
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(pet) = app.get_webview_window("pet") {
                let _ = pet.unminimize();
                let _ = pet.show();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            desktop::get_desktop_info,
            mouse::get_cursor_pos,
            window::set_pet_position,
            window::set_pet_scale,
            window::set_pet_ignore_cursor_events,
            window::show_window,
            window::hide_window,
            window::get_window_info,
            ai::ai_chat,
            tts::tts_speak,
            tray::toggle_paused,
            store::read_data,
            store::write_data,
            store::frontend_log,
            store::read_text,
            store::write_text,
            store::open_text,
            petdex::petdex_list,
            server::report_status,
            server::approval_decide,
            autostart_status,
            autostart_set,
        ])
        .on_window_event(|window, event| {
            // 拦截原生关闭（标题栏 X / Alt+F4）：窗口被销毁后托盘无法再唤回，
            // 统一改为隐藏。退出走托盘"退出"（app.exit 不经过此事件）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            // 桥接状态 + 本地 HTTP 桥（附录 A.4，M5）
            app.manage(server::BridgeState {
                status: std::sync::Mutex::new(serde_json::Value::Null),
                approval: std::sync::Mutex::new(None),
                decisions: std::sync::Mutex::new(std::collections::HashMap::new()),
            });
            server::start(app.handle().clone());
            // panic 信息落到 app_data_dir/panic.log（附录 A.1：崩溃可事后取证）
            let log_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let _ = std::fs::create_dir_all(&log_dir);
            let panic_log = log_dir.join("panic.log");
            std::panic::set_hook(Box::new(move |info| {
                eprintln!("{info}");
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let msg = format!("[{ts}] {info}\n");
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&panic_log)
                    .and_then(|mut f| std::io::Write::write_all(&mut f, msg.as_bytes()));
            }));
            // 鼠标事件流（附录 B3）：Rust 侧采样，变化时推送给 pet 窗口
            mouse::start_cursor_stream(app.handle().clone());
            window::init_windows(app.handle().clone());
            tray::create_tray(app.handle().clone())?;
            // 全局热键（附录 A.1）：Ctrl+Shift+P 召唤/隐藏，Ctrl+Shift+U 切换鼠标穿透
            app.global_shortcut()
                .on_shortcut("ctrl+shift+p", |app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_pet_visible(app);
                    }
                })?;
            app.global_shortcut()
                .on_shortcut("ctrl+shift+u", |app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        use tauri::Emitter;
                        let _ = app.emit_to("pet", "hotkey://toggle-clickthrough", ());
                    }
                })?;
            // 审批快捷键（附录 A.4，M5）：Ctrl+Shift+Y 允许 / Ctrl+Shift+N 拒绝
            app.global_shortcut()
                .on_shortcut("ctrl+shift+y", |app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        server::resolve_current(app, "allowed");
                    }
                })?;
            app.global_shortcut()
                .on_shortcut("ctrl+shift+n", |app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        server::resolve_current(app, "denied");
                    }
                })?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building desktop-ai-pet");
    // RunEvent::Exit：托盘"退出"（app.exit）与正常退出都会走到这里，
    // 顺手清掉还在播报的 TTS 子进程（附录 B2）
    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            tts::kill_speaking();
        }
    });
}
