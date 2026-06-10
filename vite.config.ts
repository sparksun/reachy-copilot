import { defineConfig, loadEnv } from 'vite';
import { WebSocket as WS } from 'ws';

export default defineConfig(({ mode }) => {
  // Load env vars so we can read CF_* and HERMES_* in server config
  const env = loadEnv(mode, process.cwd(), ['CF_', 'HERMES_', 'HF_', 'VITE_']);

  return {
    base: './',
    // Expose HF_ and HERMES_ and CF_ vars to the browser (in addition to the Vite default VITE_)
    envPrefix: ['VITE_', 'HF_', 'HERMES_', 'CF_'],
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

      // ── Gemini Live WebSocket Proxy ──────────────────────────────────
      // Browser connects to ws://localhost:5173/gemini-live
      // Vite dev server upgrades the connection and proxies to Cloudflare
      // AI Gateway, injecting auth credentials so they never leak to the
      // browser.
      setupMiddlewares(middlewares, { httpServer }) {
        if (!httpServer) return middlewares;

        httpServer.on('upgrade', (req, socket, head) => {
          if (req.url !== '/gemini-live') return;

          const accountId = env.CF_ACCOUNT_ID;
          const gatewayId = env.CF_GATEWAY_ID;
          const cfToken   = env.CF_AI_TOKEN;
          const googleKey = env.HERMES_GOOGLE_API_KEY;

          if (!accountId || !gatewayId || !cfToken || !googleKey) {
            console.error('[gemini-live-proxy] Missing env vars: CF_ACCOUNT_ID, CF_GATEWAY_ID, CF_AI_TOKEN, HERMES_GOOGLE_API_KEY');
            socket.destroy();
            return;
          }

          const targetUrl = `wss://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google?api_key=${googleKey}`;

          // Connect to Cloudflare AI Gateway
          const upstream = new WS(targetUrl, {
            headers: { 'cf-aig-authorization': cfToken },
          });

          upstream.on('open', () => {
            console.log('[gemini-live-proxy] ✅ Upstream connected');

            // Manually upgrade the incoming socket to a WebSocket
            // We use the `ws` library to handle the upgrade
            const server = new WS.Server({ noServer: true });
            server.handleUpgrade(req, socket, head, (clientWs) => {
              console.log('[gemini-live-proxy] ✅ Client connected');

              // Bi-directional proxy
              clientWs.on('message', (data) => {
                if (upstream.readyState === WS.OPEN) {
                  upstream.send(data);
                }
              });

              upstream.on('message', (data) => {
                if (clientWs.readyState === WS.OPEN) {
                  clientWs.send(data);
                }
              });

              clientWs.on('close', () => {
                console.log('[gemini-live-proxy] Client disconnected');
                upstream.close();
              });

              upstream.on('close', (code, reason) => {
                console.log(`[gemini-live-proxy] Upstream closed (${code}) ${reason || ''}`);
                if (clientWs.readyState === WS.OPEN) {
                  clientWs.close(code, reason.toString());
                }
              });

              upstream.on('error', (err) => {
                console.error('[gemini-live-proxy] Upstream error:', err.message);
                clientWs.close(1011, 'upstream error');
              });

              clientWs.on('error', (err) => {
                console.error('[gemini-live-proxy] Client error:', err.message);
                upstream.close();
              });
            });
          });

          upstream.on('error', (err) => {
            console.error('[gemini-live-proxy] Failed to connect upstream:', err.message);
            socket.destroy();
          });
        });

        return middlewares;
      },
    },
  };
});
