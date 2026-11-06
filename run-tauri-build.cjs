// Tauri build 打包器：绕过 tauri.js 的 argv 检测，直接调用原生 CLI
const cli = require('@tauri-apps/cli');
cli.run(['build'], 'tauri build').catch((err) => {
  cli.logError(err.message);
  process.exit(1);
});
