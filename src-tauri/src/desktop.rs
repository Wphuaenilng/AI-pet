// 桌面世界感知：显示器、可见窗口、任务栏
use serde::Serialize;
use tauri::{AppHandle, Manager};
use windows::core::w;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, IsIconic, IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, GW_OWNER,
    MONITORINFOF_PRIMARY, WS_CAPTION, WS_EX_TOOLWINDOW,
};

#[derive(Serialize, Clone, Debug)]
pub struct MonitorInfo {
    pub id: usize,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    #[serde(rename = "wx")]
    pub wx: i32,
    #[serde(rename = "wy")]
    pub wy: i32,
    #[serde(rename = "ww")]
    pub ww: i32,
    #[serde(rename = "wh")]
    pub wh: i32,
    pub primary: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct OSWindow {
    pub id: isize,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Serialize, Clone, Debug)]
pub struct RectR {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Serialize, Clone, Debug)]
pub struct DesktopInfo {
    pub monitors: Vec<MonitorInfo>,
    pub windows: Vec<OSWindow>,
    pub taskbar: Option<RectR>,
}

pub fn monitors() -> Vec<MonitorInfo> {
    let mut out: Vec<MonitorInfo> = Vec::new();
    let ptr = &mut out as *mut Vec<MonitorInfo> as isize;
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(enum_mon), LPARAM(ptr));
    }
    out
}

unsafe extern "system" fn enum_mon(hmon: HMONITOR, _hdc: HDC, _rect: *mut RECT, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
    let mut mi: MONITORINFO = std::mem::zeroed();
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if GetMonitorInfoW(hmon, &mut mi).as_bool() {
        out.push(MonitorInfo {
            id: hmon.0 as usize,
            x: mi.rcMonitor.left,
            y: mi.rcMonitor.top,
            w: mi.rcMonitor.right - mi.rcMonitor.left,
            h: mi.rcMonitor.bottom - mi.rcMonitor.top,
            wx: mi.rcWork.left,
            wy: mi.rcWork.top,
            ww: mi.rcWork.right - mi.rcWork.left,
            wh: mi.rcWork.bottom - mi.rcWork.top,
            primary: (mi.dwFlags & MONITORINFOF_PRIMARY) != 0,
        });
    }
    BOOL(1)
}

pub fn primary_monitor_info() -> MonitorInfo {
    monitors()
        .into_iter()
        .find(|m| m.primary)
        .unwrap_or(MonitorInfo {
            id: 0,
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
            wx: 0,
            wy: 0,
            ww: 1920,
            wh: 1040,
            primary: true,
        })
}

pub fn own_hwnds(app: &AppHandle) -> Vec<isize> {
    ["pet", "settings", "chat"]
        .iter()
        .filter_map(|l| {
            app.get_webview_window(l)
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as isize)
        })
        .collect()
}

struct Collector {
    out: Vec<OSWindow>,
    exclude: Vec<isize>,
}

unsafe extern "system" fn enum_wnd(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut Collector);
    if ctx.exclude.contains(&(hwnd.0 as isize)) {
        return BOOL(1);
    }
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    // 跳过被隐藏/挂起的 UWP 幽灵窗口
    let mut cloaked: u32 = 0;
    let hr = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut core::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
    );
    if hr.is_ok() && cloaked != 0 {
        return BOOL(1);
    }
    let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
    let exstyle = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    // 只保留有标题栏的常规应用窗口（排除任务栏、菜单、提示条等）
    if style & WS_CAPTION.0 == 0 || exstyle & WS_EX_TOOLWINDOW.0 != 0 {
        return BOOL(1);
    }
    // 无 owner 的窗口 GetWindow 返回 Err（NULL 包装），此处必须保留；
    // unwrap_or(true) 会把所有正常主窗口一起跳过，导致枚举结果恒为空
    if GetWindow(hwnd, GW_OWNER).map(|h| h != HWND::default()).unwrap_or(false) {
        return BOOL(1);
    }
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return BOOL(1);
    }
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    if w < 80 || h < 80 {
        return BOOL(1);
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return BOOL(1);
    }
    let mut buf = [0u16; 512];
    let copied = GetWindowTextW(hwnd, &mut buf);
    let title = String::from_utf16_lossy(&buf[..(copied.min(511).max(0) as usize)]);
    if title.trim().is_empty() {
        return BOOL(1);
    }
    ctx.out.push(OSWindow {
        id: hwnd.0 as isize,
        title,
        x: rect.left,
        y: rect.top,
        w,
        h,
    });
    BOOL(1)
}

pub fn taskbar_rect() -> Option<RectR> {
    unsafe {
        let hwnd = FindWindowW(w!("Shell_TrayWnd"), None).ok()?;
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        Some(RectR {
            x: rect.left,
            y: rect.top,
            w: rect.right - rect.left,
            h: rect.bottom - rect.top,
        })
    }
}

#[tauri::command]
pub fn get_desktop_info(app: AppHandle) -> Result<DesktopInfo, String> {
    #[cfg(debug_assertions)]
    {
        static COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n < 3 {
            eprintln!("[pet] get_desktop_info call #{n}");
        }
    }
    let exclude = own_hwnds(&app);
    let mut col = Collector {
        out: Vec::new(),
        exclude,
    };
    let ptr = &mut col as *mut Collector as isize;
    unsafe {
        let _ = EnumWindows(Some(enum_wnd), LPARAM(ptr));
    }
    Ok(DesktopInfo {
        monitors: monitors(),
        windows: col.out,
        taskbar: taskbar_rect(),
    })
}
