// 设置/存档导出备份与恢复（M0 收尾项）
// 备份 = 把数据目录下的存档文件拷入「文档\DesktopAIPet-Backups\backup-<时间戳>\」
// 恢复 = 先把当前存档另存为 *.pre-restore.bak，再用备份覆盖回去
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 备份涵盖的存档文件（panic.log 等诊断文件除外）
const BACKUP_FILES: &[&str] = &["settings.json", "petstate.json", "memory.json", "memory.md", "kb_docs.json"];
const MANIFEST: &str = "backup.json";

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 备份根目录：优先用户 Documents，拿不到（如路径不存在且创建失败）退回数据目录
fn backups_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            let root = PathBuf::from(profile).join("Documents").join("DesktopAIPet-Backups");
            if std::fs::create_dir_all(&root).is_ok() {
                return Ok(root);
            }
        }
    }
    let fallback = data_dir(app)?.join("backups");
    std::fs::create_dir_all(&fallback).map_err(|e| e.to_string())?;
    Ok(fallback)
}

/// 本地时间戳 YYYYMMDD-HHMMSS（不引 chrono，直接走 Win32 GetLocalTime）
fn local_stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let st = unsafe { GetLocalTime() };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
    )
}

/// 备份目录名必须是 backup-时间戳（可带 -N 重名后缀），且仅含数字/短横线（防目录穿越）
fn valid_backup_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("backup-") else {
        return false;
    };
    let ok = (15..=17).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_digit() || b == b'-');
    ok && Path::new(name).components().count() == 1
}

// ---------- 纯文件逻辑（不依赖 AppHandle，单测直接覆盖） ----------

/// 导出备份到 root/backup-<stamp>，返回备份目录（同名时追加 -N，绝不覆盖旧备份）
fn do_export(src: &Path, root: &Path, stamp: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let dir = root.join(format!("backup-{stamp}"));
    let mut final_dir = dir.clone();
    for i in 1..100 {
        if !final_dir.exists() {
            break;
        }
        final_dir = root.join(format!("backup-{stamp}-{i}"));
    }
    std::fs::create_dir_all(&final_dir).map_err(|e| e.to_string())?;

    let mut copied = Vec::new();
    for f in BACKUP_FILES {
        let from = src.join(f);
        if from.exists() {
            std::fs::copy(&from, final_dir.join(f)).map_err(|e| e.to_string())?;
            copied.push(*f);
        }
    }
    let manifest = json!({
        "app": "desktop-ai-pet",
        "version": 1,
        "created": stamp,
        "files": copied,
    });
    std::fs::write(
        final_dir.join(MANIFEST),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    Ok(final_dir)
}

/// 列出已有备份（新的在前）；无清单或名字不合法的目录直接跳过
fn do_list(root: &Path) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !valid_backup_name(&name) {
            continue;
        }
        let Ok(s) = std::fs::read_to_string(entry.path().join(MANIFEST)) else {
            continue;
        };
        let Ok(m) = serde_json::from_str::<Value>(&s) else {
            continue;
        };
        let files: Vec<String> = m
            .get("files")
            .and_then(|f| f.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        out.push(json!({
            "name": name,
            "created": m.get("created").and_then(|v| v.as_str()).unwrap_or(&name),
            "files": files,
        }));
    }
    out.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    Ok(out)
}

/// 从备份目录恢复：当前存档先备份为 *.pre-restore.bak，再逐文件覆盖
fn do_restore(dir: &Path, dst: &Path) -> Result<Value, String> {
    let manifest_path = dir.join(MANIFEST);
    if !manifest_path.exists() {
        return Err("备份不存在或缺少清单文件".into());
    }
    let manifest = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .ok_or("备份清单损坏")?;
    let files: Vec<String> = manifest
        .get("files")
        .and_then(|f| f.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .ok_or("备份清单缺少文件列表")?;

    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut restored = Vec::new();
    for f in &files {
        // 清单里的文件名也必须是允许列表内的固定项，不让旧备份塞入奇怪文件
        if !BACKUP_FILES.contains(&f.as_str()) {
            continue;
        }
        let from = dir.join(f);
        if !from.exists() {
            continue;
        }
        let target = dst.join(f);
        if target.exists() {
            std::fs::copy(&target, dst.join(format!("{f}.pre-restore.bak")))
                .map_err(|e| e.to_string())?;
        }
        std::fs::copy(&from, &target).map_err(|e| e.to_string())?;
        restored.push(f.clone());
    }
    if restored.is_empty() {
        return Err("备份里没有可恢复的文件".into());
    }
    Ok(json!({ "restored": restored }))
}

// ---------- Tauri 命令 ----------

/// 导出备份：返回备份目录路径
#[tauri::command]
pub fn backup_export(app: AppHandle) -> Result<String, String> {
    let dir = do_export(&data_dir(&app)?, &backups_root(&app)?, &local_stamp())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 列出已有备份（新的在前）
#[tauri::command]
pub fn backup_list(app: AppHandle) -> Result<Vec<Value>, String> {
    do_list(&backups_root(&app)?)
}

/// 从指定备份恢复：当前存档先备份为 *.pre-restore.bak，再逐文件覆盖
#[tauri::command]
pub fn backup_restore(app: AppHandle, name: String) -> Result<Value, String> {
    if !valid_backup_name(&name) {
        return Err("invalid backup name".into());
    }
    let root = backups_root(&app)?;
    do_restore(&root.join(&name), &data_dir(&app)?)
}

/// 打开备份文件夹（资源管理器）
#[tauri::command]
pub fn backup_open_dir(app: AppHandle) -> Result<(), String> {
    let root = backups_root(&app)?;
    std::process::Command::new("explorer.exe")
        .arg(&root)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dirs(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("ai-pet-backup-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("data");
        let root = base.join("backups");
        std::fs::create_dir_all(&src).unwrap();
        (src, root)
    }

    #[test]
    fn name_format() {
        assert!(valid_backup_name("backup-20261008-162600"));
        assert!(valid_backup_name("backup-20261008-162600-1"));
        assert!(!valid_backup_name("backup-20261008-162600/../settings"));
        assert!(!valid_backup_name("../backup-20261008-162600"));
        assert!(!valid_backup_name("backup-2026-10-08"));
        assert!(!valid_backup_name("backup-20261008-162600 extra"));
        assert!(!valid_backup_name("backup-20261008-162600\\.."));
        assert!(!valid_backup_name("backup-abc"));
        assert!(!valid_backup_name(""));
    }

    #[test]
    fn export_list_restore_roundtrip() {
        let (src, root) = fixture_dirs("roundtrip");
        std::fs::write(src.join("settings.json"), r#"{"petName":"团子"}"#).unwrap();
        std::fs::write(src.join("memory.md"), "# 记忆").unwrap();

        // 导出两次（同 stamp，第二次应带 -1 后缀）
        let d1 = do_export(&src, &root, "20261008-162600").unwrap();
        let d2 = do_export(&src, &root, "20261008-162600").unwrap();
        assert_eq!(d1.file_name().unwrap(), "backup-20261008-162600");
        assert_eq!(d2.file_name().unwrap(), "backup-20261008-162600-1");

        // 列表：新的在前，清单文件齐全
        let list = do_list(&root).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["name"], "backup-20261008-162600-1");
        let files = list[0]["files"].as_array().unwrap();
        assert!(files.iter().any(|f| f == "settings.json"));
        assert!(files.iter().any(|f| f == "memory.md"));
        assert!(!files.iter().any(|f| f == "panic.log"));

        // 改坏当前存档后恢复：内容回来，且当前版本被兜底成 .pre-restore.bak
        std::fs::write(src.join("settings.json"), r#"{"petName":"被改坏"}"#).unwrap();
        let r = do_restore(&d1, &src).unwrap();
        let restored = r["restored"].as_array().unwrap();
        assert!(restored.iter().any(|f| f == "settings.json"));
        let after = std::fs::read_to_string(src.join("settings.json")).unwrap();
        assert!(after.contains("团子"));
        let safeguard = std::fs::read_to_string(src.join("settings.json.pre-restore.bak")).unwrap();
        assert!(safeguard.contains("被改坏"));

        // 恢复不存在的备份 / 无清单目录要报错，不 panic
        assert!(do_restore(&root.join("backup-20990101-000000"), &src).is_err());
        let _ = std::fs::remove_dir_all(&src.parent().unwrap());
    }

    #[test]
    fn restore_rejects_manifest_injection() {
        let (src, root) = fixture_dirs("injection");
        std::fs::write(src.join("settings.json"), "{}").unwrap();
        let d = do_export(&src, &root, "20261008-170000").unwrap();
        // 篡改清单：塞入允许列表外的文件
        let bad = json!({"files": ["settings.json", "..\\..\\evil.json"]});
        std::fs::write(d.join(MANIFEST), bad.to_string()).unwrap();
        let r = do_restore(&d, &src).unwrap();
        let restored = r["restored"].as_array().unwrap();
        assert!(restored.iter().any(|f| f == "settings.json"));
        assert!(!restored.iter().any(|f| f.to_string().contains("evil")));
        let _ = std::fs::remove_dir_all(&src.parent().unwrap());
    }
}
