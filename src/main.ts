import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

// 浏览器预览模式给个底色（Tauri 里保持透明）
if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
  document.body.classList.add('preview')
} else {
  // Tauri 环境：前端异常转发到 Rust stdout，便于排查
  const log = (level: string, msg: string) => {
    void import('./lib/tauri').then(({ invoke }) =>
      invoke('frontend_log', { level, message: msg.slice(0, 500) }).catch(() => {}),
    )
  }
  ;(window as unknown as { __petLog: (msg: string) => void }).__petLog = (msg: string) =>
    log('info', msg)
  if (import.meta.env.DEV) {
    void import('./lib/tauri').then(({ getLabel }) => log('info', `window label=${getLabel()}`))
  }
  window.addEventListener('error', (e) => log('error', `${e.message} @ ${e.filename}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) =>
    log('rejection', String((e as PromiseRejectionEvent).reason)),
  )
  const origError = console.error.bind(console)
  console.error = (...a: unknown[]) => {
    log('console.error', a.map((x) => String(x)).join(' '))
    origError(...a)
  }
}

createApp(App).mount('#app')

