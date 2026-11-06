// Tauri dev 启动器：绕过 tauri.js 的 argv 检测，直接调用原生 CLI
const cli = require('@tauri-apps/cli');
cli.run(['dev'], 'tauri dev').catch((err) => {
  cli.logError(err.message);
  process.exit(1);
});
