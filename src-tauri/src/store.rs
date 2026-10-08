// 本地 JSON 数据存储（settings / memory），保存于应用数据目录
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn check_name(name: &str) -> Result<(), String> {
    // 允许点号（memory.md）；显式拒绝 ".." 防目录穿越
    if name.is_empty()
        || name.contains("..")
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("invalid data name".into());
    }
    Ok(())
}

/// 前端日志转发（debug 排查用）
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    eprintln!("[frontend:{}] {}", level, message);
}

#[tauri::command]
pub fn read_data(app: AppHandle, name: String) -> Result<Option<Value>, String> {
    check_name(&name)?;
    let dir = data_dir(&app)?;
    let path = dir.join(format!("{name}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match serde_json::from_str::<Value>(&s) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            // 存档损坏：备份原文件再回落默认值，并通知前端提示（不做无感知重置）
            let bak = dir.join(format!("{name}.json.bak"));
            let _ = std::fs::write(&bak, &s);
            eprintln!("[store] {name}.json 损坏（{e}），已备份为 {name}.json.bak");
            let _ = app.emit("store://corrupted", name.clone());
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn write_data(app: AppHandle, name: String, data: Value) -> Result<(), String> {
    check_name(&name)?;
    let dir = data_dir(&app)?;
    let path = dir.join(format!("{name}.json"));
    let tmp = dir.join(format!("{name}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 读写任意文本文件（M5：memory.md 可编辑长期记忆），原子写
#[tauri::command]
pub fn read_text(app: AppHandle, name: String) -> Result<Option<String>, String> {
    check_name(&name)?;
    let path = data_dir(&app)?.join(&name);
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text(app: AppHandle, name: String, content: String) -> Result<(), String> {
    check_name(&name)?;
    let dir = data_dir(&app)?;
    let path = dir.join(&name);
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 用记事本打开记忆文件，供用户直接编辑
#[tauri::command]
pub fn open_text(app: AppHandle, name: String) -> Result<(), String> {
    let path = data_dir(&app)?.join(&name);
    if !path.exists() {
        std::fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    std::process::Command::new("notepad.exe")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
