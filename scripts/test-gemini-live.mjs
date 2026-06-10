/**
 * Smoke test: Cloudflare AI Gateway → Gemini Live API
 *
 * Usage: node scripts/test-gemini-live.mjs
 *
 * Sends a text prompt via the Gemini Live WebSocket (text-only mode)
 * and prints the response. Exits after first complete turn.
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'fs';

// Load .env.local manually
const envFile = readFileSync('.env.local', 'utf-8');
for (const line of envFile.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq);
  const val = trimmed.slice(eq + 1);
  process.env[key] = val;
}

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_GATEWAY_ID = process.env.CF_GATEWAY_ID;
const CF_AI_TOKEN   = process.env.CF_AI_TOKEN;
const GOOGLE_KEY    = process.env.HERMES_GOOGLE_API_KEY;

if (!CF_ACCOUNT_ID || !CF_GATEWAY_ID || !CF_AI_TOKEN || !GOOGLE_KEY) {
  console.error('Missing env vars. Need: CF_ACCOUNT_ID, CF_GATEWAY_ID, CF_AI_TOKEN, HERMES_GOOGLE_API_KEY');
  process.exit(1);
}

// Try direct Google first to verify protocol, then Cloudflare
const DIRECT_GOOGLE = process.argv.includes('--direct');

let url, wsOptions;
if (DIRECT_GOOGLE) {
  url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GOOGLE_KEY}`;
  wsOptions = {};
  console.log('[smoke] Mode: DIRECT Google');
} else {
  url = `wss://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/google?api_key=${GOOGLE_KEY}`;
  wsOptions = {
    headers: {
      'cf-aig-authorization': CF_AI_TOKEN,
    },
  };
  console.log('[smoke] Mode: Cloudflare AI Gateway');
}
console.log('[smoke] Connecting to:', url.replace(GOOGLE_KEY, '***'));

const ws = new WebSocket(url, wsOptions);

ws.on('open', () => {
  console.log('[smoke] ✅ WebSocket connected');

  // Step 1: Send setup
  const setup = {
    setup: {
      model: "models/gemini-2.5-flash-native-audio-latest",
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Aoede" }
          }
        }
      },
      systemInstruction: {
        parts: [{ text: "You are a helpful assistant. Reply in 1-2 sentences." }]
      }
    }
  };
  console.log('[smoke] Sending setup:', JSON.stringify(setup).slice(0, 200));
  ws.send(JSON.stringify(setup));
});

ws.on('message', (data) => {
  const raw = data.toString();
  console.log('[smoke] RAW message:', raw.slice(0, 500));

  try {
    const msg = JSON.parse(raw);

    if (msg.setupComplete) {
      console.log('[smoke] ✅ Setup complete! Sending text prompt...');

      // Step 2: Send a text message
      ws.send(JSON.stringify({
        clientContent: {
          turns: [
            { role: "user", parts: [{ text: "Hello! What's 2+2? Reply briefly." }] }
          ],
          turnComplete: true
        }
      }));
    }

    if (msg.serverContent) {
      const parts = msg.serverContent.modelTurn?.parts ?? [];
      for (const part of parts) {
        if (part.text) {
          process.stdout.write(part.text);
        }
      }
      if (msg.serverContent.turnComplete) {
        console.log('\n[smoke] ✅ Turn complete! Closing...');
        ws.close();
      }
    }

    if (msg.error) {
      console.error('[smoke] ❌ Error:', JSON.stringify(msg.error));
      ws.close();
    }
  } catch (e) {
    console.error('[smoke] Parse error:', e.message);
  }
});

ws.on('error', (err) => {
  console.error('[smoke] ❌ WebSocket error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`[smoke] Connection closed (${code}) ${reason || ''}`);
  process.exit(0);
});

// Timeout safety
setTimeout(() => {
  console.error('[smoke] ❌ Timeout after 15s');
  ws.close();
  process.exit(1);
}, 15000);
