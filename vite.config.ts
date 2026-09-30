import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    target: 'chrome105',
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
})
