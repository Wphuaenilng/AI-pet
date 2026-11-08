// 系统托盘：聊天/暂停/召唤/设置/隐藏/退出（"更换宠物"随单宠物化移除）
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub struct PauseState(pub Mutex<bool>);
pub struct TrayUi {
    pub pause_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    pub agentsync_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

/// 设置面板改 agentSync 时同步托盘勾选状态（唯一事实源在前端 settings）
/// 注意：前端页面加载后可能立即调用本命令，早于 create_tray 执行，
/// 因此 TrayUi 必须在 setup 开头 manage（见 main.rs），这里再用 try_state 兜底
#[tauri::command]
pub fn set_tray_agentsync(app: AppHandle, checked: bool) {
    if let Some(ui) = app.try_state::<TrayUi>() {
        if let Some(item) = ui
            .agentsync_item
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = item.set_checked(checked);
        }
    }
}

/// 统一的暂停状态切换：更新 PauseState、托盘菜单文字，并广播事件。
/// 托盘菜单与设置面板都走这里，保证两处状态一致。
pub fn set_paused_impl(app: &AppHandle, paused: bool) {
    if let Some(state) = app.try_state::<PauseState>() {
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = paused;
    }
    if let Some(ui) = app.try_state::<TrayUi>() {
        if let Some(item) = ui
            .pause_item
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = item.set_text(if paused { "继续活动" } else { "暂停宠物" });
        }
    }
    let _ = app.emit("tray://pause", paused);
}

/// 翻转暂停状态（设置面板用）：以 PauseState 为唯一事实源，
/// 同步托盘菜单文字并广播事件，返回翻转后的状态
#[tauri::command]
pub fn toggle_paused(app: AppHandle) -> bool {
    let paused = match app.try_state::<PauseState>() {
        Some(state) => {
            let mut v = state.0.lock().unwrap_or_else(|e| e.into_inner());
            *v = !*v;
            *v
        }
        None => false,
    };
    set_paused_impl(&app, paused);
    paused
}

pub fn create_tray(app: AppHandle) -> tauri::Result<()> {
    let chat = MenuItem::with_id(&app, "chat", "聊天", true, None::<&str>)?;
    let pause = MenuItem::with_id(&app, "pause", "暂停宠物", true, None::<&str>)?;
    let summon = MenuItem::with_id(&app, "summon", "重新召唤", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(&app)?;
    let settings = MenuItem::with_id(&app, "settings", "设置", true, None::<&str>)?;
    let hide = MenuItem::with_id(&app, "hide", "隐藏宠物", true, None::<&str>)?;
    let agentsync = CheckMenuItem::with_id(&app, "agentsync", "聊天感知（ZCode）", true, false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(&app)?;
    let quit = MenuItem::with_id(&app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        &app,
        &[&chat, &pause, &summon, &sep1, &settings, &hide, &agentsync, &sep2, &quit],
    )?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon_32.png"))?;
    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Desktop AI Pet")
        .menu(&menu)
        .build(&app)?;

    // PauseState / TrayUi 已在 main.rs setup 开头 manage（避免前端早期 IPC 抢跑 panic），
    // 这里只负责把真实菜单项句柄填进去
    {
        let ui = app.state::<TrayUi>();
        *ui.pause_item.lock().unwrap_or_else(|e| e.into_inner()) = Some(pause);
        *ui.agentsync_item.lock().unwrap_or_else(|e| e.into_inner()) = Some(agentsync);
    }

    tray.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        match id {
            "chat" => {
                let _ = crate::window::show_window_impl(app, "chat");
            }
            "settings" => {
                let _ = crate::window::show_window_impl(app, "settings");
            }
            "pause" => {
                let paused = match app.try_state::<PauseState>() {
                    Some(state) => {
                        let mut v = state.0.lock().unwrap_or_else(|e| e.into_inner());
                        *v = !*v;
                        *v
                    }
                    None => false,
                };
                set_paused_impl(app, paused);
            }
            "summon" => {
                let _ = crate::window::show_window_impl(app, "pet");
                let _ = app.emit("tray://summon", ());
            }
            "hide" => {
                if let Some(pet) = app.get_webview_window("pet") {
                    let _ = pet.hide();
                }
            }
            "agentsync" => {
                // 状态翻转在前端（settings 唯一事实源），托盘只做入口与勾选显示
                let _ = app.emit("tray://toggle-agentsync", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        }
    });

    Ok(())
}
