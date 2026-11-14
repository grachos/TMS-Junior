import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Identifier of THIS build. It is baked into the code (__BUILD_ID__) and also
// written to /version.json, so a tab opened before a release can tell the
// server now has a newer build (see src/lib/versionCheck.ts).
const buildId = process.env.BUILD_ID || Date.now().toString(36);

// Dev server proxies /api to the Express backend so the SPA and API share an
// origin in development (no CORS surprises) and match the production reverse-proxy.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: buildId }) });
      },
    },
  ],
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy visual libs so the initial bundle stays lean.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          maps: ['leaflet', 'react-leaflet'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
