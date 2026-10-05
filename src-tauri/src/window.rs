// 宠物窗口控制：位置 / 缩放 / 鼠标穿透 / 显示隐藏
use serde::Serialize;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Position};

pub const PET_W: f64 = 560.0;
pub const PET_H: f64 = 340.0;

pub fn init_windows(app: AppHandle) {
    let monitor = crate::desktop::primary_monitor_info();
    if let Some(pet) = app.get_webview_window("pet") {
        let size = pet
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(560, 340));
        // 初始位置：右下角、探头（猫绘制在窗口中心且面朝行进方向，
        // 露出 60% 窗口宽度才能看到猫脸；完全在屏幕外时 WebView2 还会节流 rAF）
        // 脚底（窗口底部 - PAD_BOTTOM）必须正好落在工作区底（地板）上
        let peek = (size.width as i32 * 3 / 5).max(120);
        let x = monitor.wx + monitor.ww - peek;
        let y = monitor.wy + monitor.wh - size.height as i32;
        let _ = pet.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        // 配置里初始隐藏（避免小屏先闪现在默认位置），定位完成后再显示
        let _ = pet.show();
    }
    if let Some(chat) = app.get_webview_window("chat") {
        let cs = chat
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(340, 480));
        let _ = chat.set_position(Position::Physical(PhysicalPosition::new(
            monitor.wx + monitor.ww - cs.width as i32 - 24,
            monitor.wy + monitor.wh - cs.height as i32 - 12,
        )));
    }
}

#[tauri::command]
pub fn set_pet_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    #[cfg(debug_assertions)]
    eprintln!("[pet] set_pet_position {:.0},{:.0}", x, y);
    let pet = app.get_webview_window("pet").ok_or("pet window not found")?;
    pet.set_position(Position::Physical(PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    )))
    .map_err(|e| e.to_string())
}

/// 缩放宠物窗口，保持脚底位置与水平中心不变
#[tauri::command]
pub fn set_pet_scale(app: AppHandle, scale: f64) -> Result<(), String> {
    let pet = app.get_webview_window("pet").ok_or("pet window not found")?;
    let s = scale.clamp(0.5, 2.0);
    let old = pet.outer_size().map_err(|e| e.to_string())?;
    let pos = pet.outer_position().map_err(|e| e.to_string())?;
    let dpr = pet.scale_factor().map_err(|e| e.to_string())? as f64;
    let new_w = PET_W * s;
    let new_h = PET_H * s;
    pet.set_size(tauri::Size::Logical(LogicalSize::new(new_w, new_h)))
        .map_err(|e| e.to_string())?;
    let new_w_phys = new_w * dpr;
    let new_h_phys = new_h * dpr;
    let feet_shift = old.height as f64 - new_h_phys;
    let cx_shift = (old.width as f64 - new_w_phys) / 2.0;
    pet.set_position(Position::Physical(PhysicalPosition::new(
        (pos.x as f64 + cx_shift).round() as i32,
        (pos.y as f64 + feet_shift).round() as i32,
    )))
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_pet_ignore_cursor_events(app: AppHandle, ignore: bool) -> Result<(), String> {
    let pet = app.get_webview_window("pet").ok_or("pet window not found")?;
    pet.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

pub fn show_window_impl(app: &AppHandle, label: &str) -> Result<(), String> {
    let w = app.get_webview_window(label).ok_or("window not found")?;
    let _ = w.unminimize();
    w.show().map_err(|e| e.to_string())?;
    if label != "pet" {
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn show_window(app: AppHandle, label: String) -> Result<(), String> {
    show_window_impl(&app, &label)
}

#[tauri::command]
pub fn hide_window(app: AppHandle, label: String) -> Result<(), String> {
    let w = app.get_webview_window(&label).ok_or("window not found")?;
    w.hide().map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct WindowInfoR {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f64,
}

#[tauri::command]
pub fn get_window_info(app: AppHandle, label: String) -> Result<WindowInfoR, String> {
    #[cfg(debug_assertions)]
    eprintln!("[pet] get_window_info {label}");
    let w = app.get_webview_window(&label).ok_or("window not found")?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    Ok(WindowInfoR {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        scale,
    })
}
