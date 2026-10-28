import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  // iight dev runs from the site project, so pin the root to this folder
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/admin/',
  plugins: [react()],
  resolve: {
    // The linked core has its own node_modules, and a second copy of React breaks hooks
    dedupe: ['react', 'react-dom', 'react-i18next', 'i18next'],
  },
})
