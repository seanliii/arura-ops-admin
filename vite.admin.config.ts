import { defineConfig, normalizePath } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('./admin', import.meta.url)),
  base: '/admin/',
  plugins: [
    {
      name: 'shared-aurora-favicon',
      apply: 'serve',
      transformIndexHtml: {
        order: 'pre',
        // admin是独立开发根目录；只在开发时使用Vite文件URL，构建仍由HTML资产管线处理。
        handler: html => html.replace('href="../shared/aurora-mark.svg?no-inline"',
          `href="/@fs/${normalizePath(fileURLToPath(new URL('./shared/aurora-mark.svg', import.meta.url)))}?no-inline"`),
      },
    },
    vue(),
  ],
  resolve: { alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  build: { outDir: '../dist-admin', emptyOutDir: true, target: 'es2018' },
  server: { host: '127.0.0.1', port: 5174, proxy: { '/api': 'http://127.0.0.1:5310' } },
})
