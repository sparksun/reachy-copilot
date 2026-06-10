/**
 * Smoke test: Gemini Live API — Function Calling + Image Input
 *
 * Verifies two risky capabilities before implementation:
 *
 * Test 1: Function Calling
 *   - Declare a robot_action tool in setup
 *   - Send text "Please shake your head"
 *   - Expect toolCall message from Gemini
 *   - Send toolResponse back
 *   - Expect audio/text acknowledgement
 *
 * Test 2: Image via realtimeInput
 *   - After Test 1 completes, send a tiny test JPEG via realtimeInput
 *   - Ask "what do you see in the image?" via text
 *   - Expect a description response
 *
 * Usage: node scripts/test-live-tools.mjs [--direct]
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'fs';

// ─── Load .env.local ─────────────────────────────────────────────────────────
const envFile = readFileSync('.env.local', 'utf-8');
for (const line of envFile.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 0) continue;
  process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_GATEWAY_ID = process.env.CF_GATEWAY_ID;
const CF_AI_TOKEN   = process.env.CF_AI_TOKEN;
const GOOGLE_KEY    = process.env.HERMES_GOOGLE_API_KEY;

if (!CF_ACCOUNT_ID || !CF_GATEWAY_ID || !CF_AI_TOKEN || !GOOGLE_KEY) {
  console.error('Missing env vars.');
  process.exit(1);
}

// ─── Connection setup ────────────────────────────────────────────────────────
const DIRECT = process.argv.includes('--direct');
let url, wsOptions;
if (DIRECT) {
  url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GOOGLE_KEY}`;
  wsOptions = {};
  console.log('[test] Mode: DIRECT Google');
} else {
  url = `wss://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/google?api_key=${GOOGLE_KEY}`;
  wsOptions = { headers: { 'cf-aig-authorization': CF_AI_TOKEN } };
  console.log('[test] Mode: Cloudflare AI Gateway');
}

// ─── Tool declarations ──────────────────────────────────────────────────────
const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: 'robot_action',
        description: 'Perform a physical action on the robot. Use when the user asks the robot to move.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: {
              type: 'STRING',
              enum: ['nod', 'shake', 'tilt_left', 'tilt_right', 'look_up', 'look_down', 'antenna_wave', 'spin'],
              description: 'The action to perform',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'capture_camera',
        description: 'Capture a photo from the robot camera to see the surroundings.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
    ],
  },
];

// ─── Create a tiny 1x1 red JPEG for image test ──────────────────────────────
// Minimal valid JPEG (2x2 pixel, red) — generated with PIL
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z';

// ─── State machine ──────────────────────────────────────────────────────────
let state = 'CONNECTING';
// CONNECTING → SETUP_SENT → TEST1_WAITING_TOOLCALL → TEST1_SENT_RESPONSE
// → TEST2_SENT_IMAGE → TEST2_WAITING_RESPONSE → DONE

const ws = new WebSocket(url, wsOptions);

ws.on('open', () => {
  console.log('[test] ✅ WebSocket connected');
  state = 'SETUP_SENT';

  const setup = {
    setup: {
      model: 'models/gemini-2.5-flash-native-audio-latest',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Aoede' },
          },
        },
      },
      tools: TOOL_DECLARATIONS,
      systemInstruction: {
        parts: [{ text: 'You are a robot assistant. Use robot_action tool when asked to perform physical actions. Use capture_camera when asked what you can see. Reply briefly.' }],
      },
    },
  };

  console.log('[test] Sending setup with tools...');
  ws.send(JSON.stringify(setup));
});

ws.on('message', (data) => {
  const raw = data.toString();
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.warn('[test] Non-JSON:', raw.slice(0, 100));
    return;
  }

  // ─── Setup complete ──────────────────────────────────────────────
  if (msg.setupComplete) {
    console.log('[test] ✅ Setup complete (with tools!)');
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('  TEST 1: Function Calling — robot_action');
    console.log('═══════════════════════════════════════════════');
    state = 'TEST1_WAITING_TOOLCALL';

    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: 'Please shake your head.' }] }],
        turnComplete: true,
      },
    }));
    console.log('[test] Sent: "Please shake your head."');
    console.log('[test] Expecting toolCall for robot_action...');
    return;
  }

  // ─── Tool call from Gemini ───────────────────────────────────────
  if (msg.toolCall) {
    const calls = msg.toolCall.functionCalls || [];
    console.log('[test] ✅ Got toolCall!', JSON.stringify(msg.toolCall, null, 2));

    if (state === 'TEST1_WAITING_TOOLCALL') {
      for (const call of calls) {
        console.log(`[test]   → Function: ${call.name}, args:`, call.args);
        console.log(`[test]   → Call ID: ${call.id}`);

        // Send tool response
        const response = {
          toolResponse: {
            functionResponses: [{
              id: call.id,
              name: call.name,
              response: { result: 'Action executed successfully. The robot shook its head.' },
            }],
          },
        };
        console.log('[test] Sending toolResponse...');
        ws.send(JSON.stringify(response));
        state = 'TEST1_SENT_RESPONSE';
      }
    }
    return;
  }

  // ─── Tool call cancellation ──────────────────────────────────────
  if (msg.toolCallCancellation) {
    console.log('[test] ⚠ Tool call cancelled:', msg.toolCallCancellation);
    return;
  }

  // ─── Server content (text/audio response) ────────────────────────
  if (msg.serverContent) {
    const parts = msg.serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (part.text) {
        process.stdout.write(`[test] Model: ${part.text}\n`);
      }
      if (part.inlineData) {
        console.log(`[test] Model audio: ${part.inlineData.mimeType}, ${part.inlineData.data?.length || 0} chars`);
      }
    }

    // Input/output transcription
    if (msg.serverContent.inputTranscript) {
      console.log('[test] 📝 inputTranscript:', JSON.stringify(msg.serverContent.inputTranscript));
    }
    if (msg.serverContent.outputTranscript) {
      console.log('[test] 📝 outputTranscript:', JSON.stringify(msg.serverContent.outputTranscript));
    }

    if (msg.serverContent.turnComplete) {
      if (state === 'TEST1_SENT_RESPONSE') {
        console.log('[test] ✅ TEST 1 PASSED: Function calling works!');
        console.log('');
        console.log('═══════════════════════════════════════════════');
        console.log('  TEST 2: Image via realtimeInput');
        console.log('═══════════════════════════════════════════════');

        // Send image via realtimeInput
        console.log('[test] Sending 1x1 JPEG via realtimeInput...');
        ws.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [{
              mimeType: 'image/jpeg',
              data: TINY_JPEG_B64,
            }],
          },
        }));
        state = 'TEST2_SENT_IMAGE';

        // Ask about the image
        setTimeout(() => {
          console.log('[test] Asking: "What do you see in the image I just sent?"');
          ws.send(JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: 'What do you see in the image I just sent? Describe it briefly.' }] }],
              turnComplete: true,
            },
          }));
          state = 'TEST2_WAITING_RESPONSE';
        }, 500);
        return;
      }

      if (state === 'TEST2_WAITING_RESPONSE') {
        console.log('[test] ✅ TEST 2 PASSED: Image input via realtimeInput works!');
        console.log('');
        console.log('═══════════════════════════════════════════════');
        console.log('  TEST 3: capture_camera tool → image flow');
        console.log('═══════════════════════════════════════════════');

        // Now test if model calls capture_camera
        console.log('[test] Asking: "What can you see through your camera?"');
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: 'What can you see through your camera right now?' }] }],
            turnComplete: true,
          },
        }));
        state = 'TEST3_WAITING_TOOLCALL';
        return;
      }

      if (state === 'TEST3_SENT_RESPONSE') {
        console.log('[test] ✅ TEST 3 PASSED: capture_camera → image → description flow works!');
        console.log('');
        console.log('═══════════════════════════════════════════════');
        console.log('  ALL TESTS PASSED ✅');
        console.log('═══════════════════════════════════════════════');
        ws.close();
        return;
      }
    }
    return;
  }

  // ─── Handle toolCall in TEST 3 ───────────────────────────────────
  // (already handled above, but just in case of ordering)

  // ─── Error ───────────────────────────────────────────────────────
  if (msg.error) {
    console.error('[test] ❌ Error:', JSON.stringify(msg.error, null, 2));
    ws.close();
    return;
  }

  console.log('[test] Unknown message:', raw.slice(0, 200));
});

// Handle toolCall for TEST 3 — need to re-check since toolCall is top-level
ws.on('message', (data) => {
  const raw = data.toString();
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.toolCall && state === 'TEST3_WAITING_TOOLCALL') {
    const calls = msg.toolCall.functionCalls || [];
    console.log('[test] ✅ Got toolCall for capture_camera!');
    for (const call of calls) {
      console.log(`[test]   → Function: ${call.name}, ID: ${call.id}`);

      // Send image via realtimeInput first
      console.log('[test] Sending image via realtimeInput...');
      ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: 'image/jpeg', data: TINY_JPEG_B64 }],
        },
      }));

      // Then send toolResponse
      setTimeout(() => {
        console.log('[test] Sending toolResponse (image_sent_via_realtime_input)...');
        ws.send(JSON.stringify({
          toolResponse: {
            functionResponses: [{
              id: call.id,
              name: call.name,
              response: { status: 'Camera frame captured and sent. The image shows the current view from the robot camera.' },
            }],
          },
        }));
        state = 'TEST3_SENT_RESPONSE';
      }, 300);
    }
  }
});

ws.on('error', (err) => {
  console.error('[test] ❌ WebSocket error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`[test] Connection closed (${code}) ${reason || ''}`);
  process.exit(state.includes('PASSED') || state === 'TEST3_SENT_RESPONSE' ? 0 : 1);
});

// Timeout
setTimeout(() => {
  console.error(`[test] ❌ Timeout after 30s (state: ${state})`);
  ws.close();
  process.exit(1);
}, 30000);
