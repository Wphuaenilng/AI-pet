// pet-mcp：MCP stdio 桥（M5，附录 A.4）
//
// 用法：
//   pet-mcp        # MCP stdio server —— claude mcp add desktop-pet -- <本 exe 路径>
//   pet-mcp hook   # Claude Code hooks 子命令：stdin 收 hook JSON，发起桌面审批并轮询决策
//
// 工具调用转发到正在运行的宠物应用（127.0.0.1:7788 HTTP 桥，附录 server.rs）。
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};

const BRIDGE: &str = "http://127.0.0.1:7788";

fn http(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let url = format!("{BRIDGE}{path}");
    let resp = match method {
        "GET" => ureq::get(&url).call(),
        _ => ureq::post(&url).send_json(body.unwrap_or_else(|| json!({}))),
    }
    .map_err(|e| format!("{e}"))?;
    resp.into_json::<Value>().map_err(|e| format!("{e}"))
}

fn tool_defs() -> Value {
    json!({
        "tools": [
            {
                "name": "pet_say",
                "description": "让桌面宠物说一句话（气泡 + 语音）",
                "inputSchema": {
                    "type": "object",
                    "properties": { "text": { "type": "string", "description": "要说的话" } },
                    "required": ["text"]
                }
            },
            {
                "name": "pet_status",
                "description": "查询宠物当前状态（五维情绪 + 饱食度 + 行为状态机状态）",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "pet_react",
                "description": "让宠物做一个动作",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["approach_user", "jump_on_window", "sit", "sleep", "play", "dance"] }
                    },
                    "required": ["action"]
                }
            },
            {
                "name": "pet_event",
                "description": "向宠物发送外部事件（构建结果/通知等），映射为它的表情与台词",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "enum": ["build-ok", "build-fail", "notify"] },
                        "message": { "type": "string" }
                    },
                    "required": ["kind"]
                }
            },
            {
                "name": "approval_request",
                "description": "发起一次桌面审批：宠物弹出横幅，用户按 Y/N 或点按钮决策；最长等待 120 秒",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "detail": { "type": "string" }
                    },
                    "required": ["title"]
                }
            }
        ]
    })
}

fn call_tool(params: &Value) -> Value {
    let name = params.get("name").and_then(|x| x.as_str()).unwrap_or("");
    let a = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let res: Result<Value, String> = match name {
        "pet_say" => http("POST", "/say", Some(json!({ "text": a.get("text") }))),
        "pet_status" => http("GET", "/status", None),
        "pet_react" => http("POST", "/react", Some(json!({ "action": a.get("action") }))),
        "pet_event" => http(
            "POST",
            "/event",
            Some(json!({ "kind": a.get("kind"), "message": a.get("message") })),
        ),
        "approval_request" => {
            match http(
                "POST",
                "/approval",
                Some(json!({ "title": a.get("title"), "detail": a.get("detail") })),
            ) {
                Err(e) => Err(e),
                Ok(v) => {
                    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let deadline =
                        std::time::Instant::now() + std::time::Duration::from_secs(120);
                    loop {
                        if std::time::Instant::now() > deadline {
                            break Ok(json!({ "id": id, "status": "timeout" }));
                        }
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        match http("GET", &format!("/approval/poll?id={id}"), None) {
                            Ok(s)
                                if s.get("status").and_then(|x| x.as_str()) == Some("pending") =>
                            {
                                continue
                            }
                            Ok(s) => break Ok(s),
                            Err(e) => break Err(e),
                        }
                    }
                }
            }
        }
        _ => Err(format!("unknown tool: {name}")),
    };
    match res {
        Ok(v) => json!({ "content": [{ "type": "text", "text": v.to_string() }] }),
        Err(e) => json!({
            "content": [{ "type": "text", "text": format!("error: {e}") }],
            "isError": true
        }),
    }
}

/// Claude Code hooks 子命令：stdin 收 PreToolUse hook JSON，
/// 在桌面宠物上发起审批并轮询决策，输出 permissionDecision JSON（超时按拒绝）。
fn hook_subcommand() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let v: Value = serde_json::from_str(&input).unwrap_or_else(|_| json!({}));
    let tool = v
        .get("tool_name")
        .and_then(|x| x.as_str())
        .unwrap_or("未知工具");
    let detail = v
        .get("tool_input")
        .map(|t| t.to_string())
        .unwrap_or_default();
    let decision = match http(
        "POST",
        "/approval",
        Some(json!({ "title": format!("允许 {tool}？"), "detail": detail })),
    ) {
        Err(e) => {
            eprintln!("bridge error: {e}");
            "deny".to_string()
        }
        Ok(r) => {
            let id = r.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_secs(120);
            loop {
                if std::time::Instant::now() > deadline {
                    break "deny".to_string();
                }
                std::thread::sleep(std::time::Duration::from_millis(400));
                match http("GET", &format!("/approval/poll?id={id}"), None) {
                    Ok(s) => match s.get("status").and_then(|x| x.as_str()) {
                        Some("allowed") => break "allow".to_string(),
                        Some("denied") => break "deny".to_string(),
                        _ => continue,
                    },
                    Err(_) => break "deny".to_string(),
                }
            }
        }
    };
    let out = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": "桌面宠物决策"
        }
    });
    println!("{out}");
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("hook") {
        hook_subcommand();
        return;
    }

    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = v.get("id").cloned();
        let method = v
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        // 通知（无 id）不回包；notifications/* 同理
        if id.is_none() || method.starts_with("notifications/") {
            continue;
        }
        let result = match method.as_str() {
            "initialize" => Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "desktop-ai-pet", "version": "0.1.0" }
            })),
            "ping" => Some(json!({})),
            "tools/list" => Some(tool_defs()),
            "tools/call" => Some(call_tool(v.get("params").unwrap_or(&json!({})))),
            _ => None,
        };
        let resp = match result {
            Some(r) => json!({ "jsonrpc": "2.0", "id": id.unwrap(), "result": r }),
            None => json!({
                "jsonrpc": "2.0",
                "id": id.unwrap(),
                "error": { "code": -32601, "message": "method not found" }
            }),
        };
        writeln!(out, "{resp}").ok();
        out.flush().ok();
    }
}
