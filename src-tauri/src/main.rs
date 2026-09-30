#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod desktop;
mod mouse;
mod store;
mod tray;
mod tts;
mod window;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(pet) = app.get_webview_window("pet") {
                let _ = pet.unminimize();
                let _ = pet.show();
            }
        }))
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
            window::init_windows(app.handle().clone());
            tray::create_tray(app.handle().clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running desktop-ai-pet");
}
