import { defineConfig } from 'vite';

// Relative base so the build works both at the GitHub Pages
// sub-path (https://<user>.github.io/<repo>/) and at a custom domain root.
export default defineConfig({
  base: './',
  define: {
    // Cesium resolves its workers/assets from this global (copied by scripts/copy-cesium.mjs).
    CESIUM_BASE_URL: JSON.stringify('./cesium/'),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
  },
  server: { port: 5173, open: false },
});
