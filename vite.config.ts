import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5199,
    strictPort: true,
    watch: {
      // cargo build 重写 exe 时 watcher 会因 EBUSY 整个崩掉，排除构建产物
      ignored: ['**/src-tauri/target/**'],
    },
  },
  build: {
    target: 'chrome105',
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
})
