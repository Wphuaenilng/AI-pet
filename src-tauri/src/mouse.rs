// 全局鼠标位置查询
use serde::Serialize;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[derive(Serialize)]
pub struct CursorInfo {
    pub x: i32,
    pub y: i32,
    pub left_down: bool,
}

#[tauri::command]
pub fn get_cursor_pos() -> Result<CursorInfo, String> {
    #[cfg(debug_assertions)]
    {
        static COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n < 3 {
            eprintln!("[pet] get_cursor_pos call #{n}");
        }
    }
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut pt).map_err(|e| e.to_string())?;
    }
    let down = unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 };
    Ok(CursorInfo {
        x: pt.x,
        y: pt.y,
        left_down: down,
    })
}
