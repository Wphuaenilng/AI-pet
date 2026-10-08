// TTS：使用 Windows 内置 SAPI（System.Speech），无需联网与第三方服务
use std::process::Command;

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// 当前正在播报的子进程。保留句柄避免每次语音泄漏进程/线程句柄，
// 同时实现单飞：新话语到来时打断上一句，避免多个 PowerShell 并发叠音
static SPEAKING: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

// async 命令在运行时线程池执行，不再占主线程/事件循环（附录 B2）
// M4：style 绑定人格——温柔型语速放慢选第一个中文语音，务实型加快选最后一个
#[tauri::command]
pub async fn tts_speak(text: String, style: Option<String>) -> Result<(), String> {
    let t: String = text.trim().chars().take(200).collect();
    if t.is_empty() {
        return Ok(());
    }
    let safe = t.replace('\'', "''");
    let (rate, pick) = match style.as_deref() {
        Some("practical") => (2, "-Last 1"),
        _ => (0, "-First 1"),
    };
    // 失败要可见：不再 SilentlyContinue 一刀切，出错写 stderr（由下方线程转发到日志）
    let script = format!(
        "try {{ \
         Add-Type -AssemblyName System.Speech; \
         $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $v=$s.GetInstalledVoices() | Where-Object {{$_.VoiceInfo.Culture.Name -like 'zh*'}} | Select-Object {pick}; \
         if($v){{$s.SelectVoice($v.VoiceInfo.Name)}}else{{[Console]::Error.WriteLine('未安装中文语音，已回退默认语音')}}; \
         $s.Rate={rate}; $s.Volume=100; $s.Speak('{}') \
         }} catch {{ [Console]::Error.WriteLine($_.Exception.Message) }}",
        safe
    );

    let mut utf16: Vec<u8> = Vec::with_capacity(script.len() * 2 + 2);
    for u in script.encode_utf16() {
        utf16.extend_from_slice(&u.to_le_bytes());
    }
    let enc = b64(&utf16);

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        &enc,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stderr(std::process::Stdio::piped());
    // 单飞：kill 本身很快，在锁内完成；wait() 要等进程退出，拿到锁外
    // 用独立线程回收，避免阻塞命令线程（曾卡主线程数百 ms，附录 B2）
    let prev = {
        let mut guard = SPEAKING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = guard.as_mut() {
            let _ = prev.kill();
        }
        guard.take()
    };
    if let Some(mut prev) = prev {
        std::thread::spawn(move || {
            let _ = prev.wait();
        });
    }
    match cmd.spawn() {
        Ok(mut child) => {
            // 转发 PowerShell 的错误输出到主进程日志，TTS 失败不再无声
            if let Some(mut err) = child.stderr.take() {
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut buf = String::new();
                    let _ = err.read_to_string(&mut buf);
                    let msg = buf.trim();
                    if !msg.is_empty() {
                        eprintln!("[tts] {msg}");
                    }
                });
            }
            *SPEAKING.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
            Ok(())
        }
        Err(e) => Err(format!("TTS 启动失败: {e}")),
    }
}

/// 应用退出时调用：终止还在播报的子进程，避免孤儿 PowerShell 继续出声（附录 B2）
pub fn kill_speaking() {
    let child = SPEAKING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
}
