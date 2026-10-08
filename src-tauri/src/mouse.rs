// 全局鼠标位置查询 + 变化时事件推送（附录 B3：替代前端 32ms 轮询）
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[derive(Serialize)]
pub struct CursorInfo {
    pub x: i32,
    pub y: i32,
    pub left_down: bool,
}

fn read_cursor() -> Option<CursorInfo> {
    let mut pt = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut pt).ok()? };
    let down = unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 };
    Some(CursorInfo {
        x: pt.x,
        y: pt.y,
        left_down: down,
    })
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
    read_cursor().ok_or_else(|| "GetCursorPos failed".to_string())
}

static CURSOR_STREAM: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 后台线程 ~125Hz 采样全局鼠标，仅在位置/左键状态变化时 emit 到 pet 窗口。
/// 前端保留低频轮询作丢事件兜底，32ms 高频轮询已废除（附录 B3）
pub fn start_cursor_stream(app: AppHandle) {
    if CURSOR_STREAM.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("cursor-stream".into())
        .spawn(move || {
            let mut last = (i32::MIN, i32::MIN, false);
            loop {
                if let Some(c) = read_cursor() {
                    let cur = (c.x, c.y, c.left_down);
                    if cur != last {
                        last = cur;
                        let _ = app.emit_to("pet", "desktop://cursor", &c);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
        });
}
