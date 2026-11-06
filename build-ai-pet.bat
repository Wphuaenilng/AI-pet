@echo off
set "PATH=C:\Users\dell\.cargo\bin;C:\Users\dell\AppData\Local\Programs\Kimi\resources\resources\runtime;%PATH%"
cd /d F:\workspace\AI-Project\AI-Pet
"C:\Users\dell\AppData\Local\Programs\Kimi\Kimi.exe" run-tauri-build.cjs >> build.log 2>&1
