import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Expose HF_ and HERMES_ vars to the browser (in addition to the Vite default VITE_)
  envPrefix: ['VITE_', 'HF_', 'HERMES_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Dev proxy: bypass CORS for Hermes API.
    // Browser fetches /hermes-api/v1/... → proxy → https://hermes-api.aiforce.dev/v1/...
    // In production (HF Spaces), embed.ts uses the real HERMES_URL directly.
    proxy: {
      '/hermes-api': {
        target: 'https://hermes-api.aiforce.dev',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hermes-api/, ''),
        // Keep SSE streams alive for tool-calling queries (e.g. web search)
        // Set 5 s above the client-side AbortSignal timeout so the proxy
        // never drops before the browser can handle the timeout itself.
        proxyTimeout: 125_000,
        timeout: 125_000,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Cloudflare on Hermes blocks streaming from localhost Origin.
            // Remove Origin/Referer so the request appears origin-less.
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        },
      },
    },
  },
});
