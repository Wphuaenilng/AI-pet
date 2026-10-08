// 本地 HTTP 桥 + 审批状态（附录 A.4，M5）：
// MCP stdio 二进制（pet-mcp）与外部脚本通过 127.0.0.1:7788 与宠物通信。
// 仅绑定回环地址，无鉴权——不暴露到局域网。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub struct BridgeState {
    /// PetBrain 每 2s 上报的状态快照（GET /status 返回）
    pub status: Mutex<Value>,
    /// 进行中的审批：Some((id, title))
    pub approval: Mutex<Option<(String, String)>>,
    /// 已决策的审批 id → allowed|denied
    pub decisions: Mutex<HashMap<String, String>>,
}

fn ok(extra: Value) -> String {
    let mut v = json!({ "ok": true });
    if let (Value::Object(base), Value::Object(add)) = (&mut v, &extra) {
        for (k, val) in add {
            base.insert(k.clone(), val.clone());
        }
    }
    v.to_string()
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

/// 取 body 里的 JSON 对象（空 body 视为 {}）
fn parse_body(body: &str) -> Value {
    serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!({}))
}

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("bridge-server".into())
        .spawn(move || {
            let server = match tiny_http::Server::http("127.0.0.1:7788") {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[bridge] 7788 端口不可用，桥接未启动：{e}");
                    return;
                }
            };
            eprintln!("[bridge] listening on http://127.0.0.1:7788");
            for mut request in server.incoming_requests() {
                let method = request.method().as_str().to_ascii_uppercase();
                let url = request.url().to_string();
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let (resp, status_code) = handle(&app, &method, &url, &body);
                let header = tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"application/json"[..],
                )
                .unwrap();
                let response =
                    tiny_http::Response::from_string(resp).with_header(header).with_status_code(status_code);
                let _ = request.respond(response);
            }
        })
        .ok();
}

fn handle(app: &AppHandle, method: &str, url: &str, body: &str) -> (String, u16) {
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p, q.to_string()),
        None => (url, String::new()),
    };
    let state = app.state::<BridgeState>();
    match (method, path) {
        ("POST", "/say") => {
            let v = parse_body(body);
            let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if text.is_empty() {
                return (json!({"ok": false, "error": "text required"}).to_string(), 400);
            }
            emit(app, "pet://say", json!({ "text": text }));
            (ok(json!({})), 200)
        }
        ("POST", "/react") => {
            let v = parse_body(body);
            let action = v.get("action").and_then(|x| x.as_str()).unwrap_or("").to_string();
            emit(app, "pet://intent", json!({ "action": action }));
            (ok(json!({})), 200)
        }
        ("POST", "/event") => {
            let v = parse_body(body);
            let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let message = v.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string();
            emit(app, "pet://external-event", json!({ "kind": kind, "message": message }));
            (ok(json!({})), 200)
        }
        ("GET", "/status") => {
            let status = state.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let approval = state.approval.lock().unwrap_or_else(|e| e.into_inner()).clone();
            (
                json!({
                    "pet": status,
                    "approval": approval.map(|(id, title)| json!({"id": id, "title": title})),
                })
                .to_string(),
                200,
            )
        }
        ("POST", "/approval") => {
            let v = parse_body(body);
            let title = v
                .get("title")
                .and_then(|x| x.as_str())
                .unwrap_or("外部请求")
                .to_string();
            let detail = v.get("detail").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let id = format!(
                "ap-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            *state.approval.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((id.clone(), title.clone()));
            emit(app, "pet://approval", json!({ "id": id, "title": title, "detail": detail }));
            (json!({ "ok": true, "id": id }).to_string(), 200)
        }
        ("POST", "/approval/decide") => {
            let v = parse_body(body);
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let decision = v.get("decision").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if !matches!(decision.as_str(), "allowed" | "denied") {
                return (json!({"ok": false, "error": "decision must be allowed|denied"}).to_string(), 400);
            }
            resolve(app, &id, &decision);
            (ok(json!({ "id": id, "decision": decision })), 200)
        }
        ("GET", "/approval/poll") => {
            // 简单轮询：id 在 decisions 里就返回结果，否则 pending
            let id = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("id="))
                .unwrap_or("")
                .to_string();
            let decisions = state.decisions.lock().unwrap_or_else(|e| e.into_inner());
            match decisions.get(&id) {
                Some(d) => (json!({ "id": id, "status": d }).to_string(), 200),
                None => (json!({ "id": id, "status": "pending" }).to_string(), 200),
            }
        }
        _ => (json!({"ok": false, "error": "not found"}).to_string(), 404),
    }
}

/// 决策落地：记录结果、清掉当前审批、通知前端隐藏横幅。
/// HTTP 决策与全局快捷键 Y/N 都走这里。
pub fn resolve(app: &AppHandle, id: &str, decision: &str) {
    let state = app.state::<BridgeState>();
    state
        .decisions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.to_string(), decision.to_string());
    *state.approval.lock().unwrap_or_else(|e| e.into_inner()) = None;
    emit(app, "pet://approval", Value::Null);
}

/// 全局快捷键 Y/N / 前端按钮：决策"当前进行中的审批"
pub fn resolve_current(app: &AppHandle, decision: &str) {
    let current = app
        .state::<BridgeState>()
        .approval
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some((id, _)) = current {
        resolve(app, &id, decision);
    }
}

/// PetBrain 每 2s 上报状态快照（GET /status 的数据源）
#[tauri::command]
pub fn report_status(app: AppHandle, status: Value) {
    let state = app.state::<BridgeState>();
    *state.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
}

/// 前端审批横幅按钮
#[tauri::command]
pub fn approval_decide(app: AppHandle, id: String, decision: String) {
    if matches!(decision.as_str(), "allowed" | "denied") {
        resolve(&app, &id, &decision);
    }
}
