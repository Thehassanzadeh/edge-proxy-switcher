import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Extension build: popup (index.html), options page (options.html),
// first-run onboarding (welcome.html),
// and MV3 service worker (src/background/background.ts -> background.js).
// dist/ is the unpacked extension directory to load in Edge.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: 'index.html',
        options: 'options.html',
        welcome: 'welcome.html',
        background: 'src/background/background.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
})
