// Petdex 宠物包扫描（整改 §5）：读取 %USERPROFILE%\.petdex\pets\*\pet.json
// 精灵图经 asset protocol（scope 限定 ~/.petdex/**）由前端 convertFileSrc 访问
use serde::Serialize;

#[derive(Serialize)]
pub struct PetPack {
    pub slug: String,
    pub name: String,
    /// 包目录绝对路径（写入 settings.petPack）
    pub dir: String,
    /// spritesheet 绝对路径（写入 settings.petPackSheet）
    pub sheet: String,
}

#[tauri::command]
pub fn petdex_list() -> Result<Vec<PetPack>, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let root = std::path::Path::new(&home).join(".petdex").join("pets");
    let mut out: Vec<PetPack> = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        // 目录不存在 = 没装过 petdex 宠物，返回空列表即可
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let pj = dir.join("pet.json");
        let Ok(txt) = std::fs::read_to_string(&pj) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            eprintln!("[petdex] {} pet.json 解析失败，跳过", dir.display());
            continue;
        };
        // 实测 petdex 包字段：id/displayName（boba 包），slug/name 为兼容回退
        let fallback_slug = dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let slug = v
            .get("id")
            .or_else(|| v.get("slug"))
            .and_then(|x| x.as_str())
            .unwrap_or(&fallback_slug)
            .to_string();
        let name = v
            .get("displayName")
            .or_else(|| v.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or(&slug)
            .to_string();
        let sheet = ["spritesheet.webp", "spritesheet.png"]
            .iter()
            .map(|f| dir.join(f))
            .find(|p| p.exists());
        let Some(sheet) = sheet else {
            continue;
        };
        out.push(PetPack {
            slug,
            name,
            dir: dir.to_string_lossy().into_owned(),
            sheet: sheet.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}
