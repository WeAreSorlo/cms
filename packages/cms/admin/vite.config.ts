import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The admin as a library, @sorlo/cms/admin, which a site's sorlo build bundles with its plugins. Its styles are
// compiled in, so sites need no Sass.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    lib: { entry: 'main.tsx', formats: ['es'], fileName: 'index', cssFileName: 'admin' },
    rolldownOptions: {
      // Left for the site's build, so the admin and every plugin share one React and one Sorlo Forms
      external: [/^react(-dom)?(\/|$)/, '@sorlo/forms'],
      // The entry brings its styles, so the site's build bundles them
      output: { banner: (chunk) => (chunk.isEntry ? "import './admin.css'" : '') },
    },
  },
})
