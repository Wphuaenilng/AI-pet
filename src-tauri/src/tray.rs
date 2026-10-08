// 系统托盘：聊天/暂停/召唤/设置/隐藏/退出（"更换宠物"随单宠物化移除）
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub struct PauseState(pub Mutex<bool>);
pub struct TrayUi {
    pub pause_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

/// 统一的暂停状态切换：更新 PauseState、托盘菜单文字，并广播事件。
/// 托盘菜单与设置面板都走这里，保证两处状态一致。
pub fn set_paused_impl(app: &AppHandle, paused: bool) {
    {
        let state = app.state::<PauseState>();
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = paused;
    }
    if let Some(item) = app
        .state::<TrayUi>()
        .pause_item
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        let _ = item.set_text(if paused { "继续活动" } else { "暂停宠物" });
    }
    let _ = app.emit("tray://pause", paused);
}

/// 翻转暂停状态（设置面板用）：以 PauseState 为唯一事实源，
/// 同步托盘菜单文字并广播事件，返回翻转后的状态
#[tauri::command]
pub fn toggle_paused(app: AppHandle) -> bool {
    let paused = {
        let state = app.state::<PauseState>();
        let mut v = state.0.lock().unwrap_or_else(|e| e.into_inner());
        *v = !*v;
        *v
    };
    set_paused_impl(&app, paused);
    paused
}

pub fn create_tray(app: AppHandle) -> tauri::Result<()> {
    let chat = MenuItem::with_id(&app, "chat", "聊天", true, None::<&str>)?;
    let feed = MenuItem::with_id(&app, "feed", "投喂", true, None::<&str>)?;
    let pause = MenuItem::with_id(&app, "pause", "暂停宠物", true, None::<&str>)?;
    let summon = MenuItem::with_id(&app, "summon", "重新召唤", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(&app)?;
    let settings = MenuItem::with_id(&app, "settings", "设置", true, None::<&str>)?;
    let hide = MenuItem::with_id(&app, "hide", "隐藏宠物", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(&app)?;
    let quit = MenuItem::with_id(&app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        &app,
        &[&chat, &feed, &pause, &summon, &sep1, &settings, &hide, &sep2, &quit],
    )?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon_32.png"))?;
    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Desktop AI Pet")
        .menu(&menu)
        .build(&app)?;

    app.manage(PauseState(Mutex::new(false)));
    app.manage(TrayUi {
        pause_item: Mutex::new(Some(pause)),
    });

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
                let paused = {
                    let state = app.state::<PauseState>();
                    let mut v = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    *v = !*v;
                    *v
                };
                set_paused_impl(app, paused);
            }
            "summon" => {
                let _ = crate::window::show_window_impl(app, "pet");
                let _ = app.emit("tray://summon", ());
            }
            "feed" => {
                let _ = crate::window::show_window_impl(app, "pet");
                let _ = app.emit("tray://feed", ());
            }
            "hide" => {
                if let Some(pet) = app.get_webview_window("pet") {
                    let _ = pet.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        }
    });

    Ok(())
}
