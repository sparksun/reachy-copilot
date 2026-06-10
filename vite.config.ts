import { defineConfig, type Plugin } from 'vite';
import type http from 'http';

/**
 * Vite plugin: Gemini Live WebSocket Proxy
 *
 * Runs a tiny WebSocket server on port 9099 that proxies to Cloudflare
 * AI Gateway. Vite's server.proxy forwards /gemini-live to it.
 *
 * Key design decisions:
 * - Separate port avoids conflicts with Vite's HMR WebSocket
 * - Messages from client are queued until upstream is ready
 * - Server is properly cleaned up on Vite restart (EADDRINUSE fix)
 */
function geminiLiveProxy(): Plugin {
  let httpServer: http.Server | null = null;

  return {
    name: 'gemini-live-proxy',

    async configureServer(server) {
      // Clean up old server if Vite restarts
      if (httpServer) {
        httpServer.close();
        httpServer = null;
      }

      const { WebSocket: WS, WebSocketServer } = await import('ws');
      const { loadEnv } = await import('vite');
      const { createServer } = await import('http');

      const env = loadEnv('development', process.cwd(), ['CF_', 'HERMES_']);
      const accountId = env.CF_ACCOUNT_ID;
      const gatewayId = env.CF_GATEWAY_ID;
      const cfToken   = env.CF_AI_TOKEN;
      const googleKey = env.HERMES_GOOGLE_API_KEY;

      if (!accountId || !gatewayId || !cfToken || !googleKey) {
        console.warn('[gemini-live-proxy] ⚠ Missing env vars — proxy disabled');
        return;
      }

      const targetUrl = `wss://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google?api_key=${googleKey}`;

      httpServer = createServer((_req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('WebSocket upgrade required');
      });

      const wss = new WebSocketServer({ server: httpServer });

      wss.on('connection', (clientWs) => {
        console.log('[gemini-live-proxy] ✅ Client connected');

        // Queue messages while upstream is connecting
        const pendingMessages: string[] = [];
        let upstreamReady = false;

        const upstream = new WS(targetUrl, {
          headers: { 'cf-aig-authorization': cfToken },
        });

        upstream.on('open', () => {
          console.log('[gemini-live-proxy] ✅ Upstream connected');
          upstreamReady = true;

          // Flush queued messages
          for (const msg of pendingMessages) {
            console.log('[gemini-live-proxy] C→S (queued):', msg.slice(0, 100));
            upstream.send(msg);
          }
          pendingMessages.length = 0;
        });

        // Client → Upstream
        clientWs.on('message', (data: Buffer) => {
          const msg = data.toString();
          if (upstreamReady && upstream.readyState === WS.OPEN) {
            console.log('[gemini-live-proxy] C→S:', msg.slice(0, 100));
            upstream.send(msg);
          } else {
            console.log('[gemini-live-proxy] C→S (queuing, upstream state:', upstream.readyState, ')');
            pendingMessages.push(msg);
          }
        });

        // Upstream → Client
        upstream.on('message', (data: Buffer) => {
          if (clientWs.readyState === WS.OPEN) {
            const msg = data.toString();
            console.log('[gemini-live-proxy] S→C:', msg.slice(0, 100));
            clientWs.send(msg);
          }
        });

        clientWs.on('close', () => {
          console.log('[gemini-live-proxy] Client disconnected');
          upstream.close();
        });

        upstream.on('close', (code: number, reason: Buffer) => {
          console.log(`[gemini-live-proxy] Upstream closed (${code}) ${reason?.toString() || ''}`);
          if (clientWs.readyState === WS.OPEN) {
            clientWs.close(code, reason?.toString());
          }
        });

        upstream.on('error', (err: Error) => {
          console.error('[gemini-live-proxy] Upstream error:', err.message);
          if (clientWs.readyState === WS.OPEN) {
            clientWs.close(1011, 'upstream error');
          }
        });

        clientWs.on('error', (err: Error) => {
          console.error('[gemini-live-proxy] Client error:', err.message);
          upstream.close();
        });
      });

      httpServer.listen(9099, () => {
        console.log('[gemini-live-proxy] ✅ WebSocket proxy listening on port 9099');
      });

      // Ensure cleanup when Vite server closes
      server.httpServer?.on('close', () => {
        httpServer?.close();
        httpServer = null;
      });
    },
  };
}

export default defineConfig({
  base: './',
  envPrefix: ['VITE_', 'HF_', 'HERMES_', 'CF_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [geminiLiveProxy()],
  server: {
    proxy: {
      '/hermes-api': {
        target: 'https://hermes-api.aiforce.dev',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hermes-api/, ''),
        proxyTimeout: 125_000,
        timeout: 125_000,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        },
      },
      '/gemini-live': {
        target: 'ws://localhost:9099',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
