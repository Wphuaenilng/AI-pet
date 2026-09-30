// AI 对话：OpenAI Compatible API（不绑定服务商）
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn normalize_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") {
        b.to_string()
    } else if b.ends_with("/v1") {
        format!("{b}/chat/completions")
    } else {
        format!("{b}/v1/chat/completions")
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut end = n;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &s[..end])
    }
}

// 全局复用的 HTTP 客户端：避免每次请求重建 TLS 会话与连接池
static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn client() -> &'static reqwest::Client {
    // get_or_try_init 尚未稳定；builder 参数固定，失败即 panic（与项目其他 .expect 一致）
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("reqwest client build failed")
    })
}

#[tauri::command]
pub async fn ai_chat(
    config: AiConfig,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
) -> Result<String, String> {
    let base = config.base_url.trim().to_string();
    if base.is_empty() {
        return Err("API Base URL 未配置".into());
    }
    let url = normalize_url(&base);
    let model = config.model.trim().to_string();
    if model.is_empty() {
        return Err("Model 未配置".into());
    }

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.8),
        // 宠物回复都是短句，限长防止失控消耗；个别不支持该字段的端点会忽略它
        "max_tokens": 1024,
    });

    let mut req = client().post(&url).json(&body);
    let key = config.api_key.trim();
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", truncate(&text, 300)));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {e}"))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| format!("响应格式异常: {}", truncate(&text, 200)))?;
    Ok(content.to_string())
}
