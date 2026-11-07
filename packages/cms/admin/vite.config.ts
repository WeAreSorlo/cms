import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  // sorlo dev runs from the site project, so pin the root to this folder
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/admin/',
  plugins: [react()],
  resolve: {
    // The linked core has its own node_modules, and a second copy of React breaks hooks
    dedupe: ['react', 'react-dom', 'react-i18next', 'i18next'],
  },
  // Vite serves the files in these folders at /admin/@fs/ to anyone, and by default that's the workspace around the
  // admin, which can hold the site's config and uploads. What the admin imports from elsewhere is still served.
  server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
})
