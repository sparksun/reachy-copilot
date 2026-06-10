/**
 * chat.ts — Chat UI renderer
 *
 * Handles all DOM construction and mutation.
 * embed.ts calls these functions and keeps state.
 *
 * Mic button uses Push-to-Talk (PTT):
 *   mousedown/touchstart → onMicDown (start recording)
 *   mouseup/touchend/mouseleave → onMicUp (stop recording & send)
 */

import './style.css';

/** Root app element */
let appEl: HTMLElement;
let headerStatusDot: HTMLElement;
let headerStatusText: HTMLElement;
let actionChip: HTMLElement;
let messageList: HTMLElement;
let inputTextarea: HTMLTextAreaElement;
let btnMic: HTMLButtonElement;
let btnSend: HTMLButtonElement;
let pttHint: HTMLElement;

/** Callbacks set by embed.ts */
let onSend: (text: string) => void = () => {};
let onMicDown: () => void = () => {};
let onMicUp: () => void = () => {};
let onModeChange: (mode: AppMode) => void = () => {};

export type Status = 'connected' | 'thinking' | 'offline';
export type MicMode = 'idle' | 'listening' | 'speaking';
export type AppMode = 'text' | 'realtime';

/**
 * Build and mount the entire app UI into #root.
 */
export function mountChatUI(callbacks: {
  onSend: (text: string) => void;
  /** PTT press — start recording */
  onMicDown: () => void;
  /** PTT release — stop recording and send */
  onMicUp: () => void;
  /** Mode switch: text ↔ realtime */
  onModeChange: (mode: AppMode) => void;
}): void {
  onSend = callbacks.onSend;
  onMicDown = callbacks.onMicDown;
  onMicUp = callbacks.onMicUp;
  onModeChange = callbacks.onModeChange;

  const root = document.getElementById('root')!;
  root.innerHTML = '';

  appEl = document.createElement('div');
  appEl.id = 'copilot-app';
  appEl.innerHTML = `
    <header class="app-header">
      <div class="header-icon">🤖</div>
      <div class="header-info">
        <div class="header-title">Reachy Copilot</div>
        <div class="header-status">
          <span class="status-dot online" id="status-dot"></span>
          <span id="status-text">Robot connected</span>
        </div>
      </div>
      <div class="action-chip" id="action-chip"></div>
      <button class="mode-toggle" id="mode-toggle" title="Switch to Realtime voice mode">
        <span class="mode-label" id="mode-label">💬 Text</span>
      </button>
    </header>

    <!-- Realtime overlay (hidden by default) -->
    <div class="realtime-panel hidden" id="realtime-panel">
      <div class="realtime-status" id="realtime-status">Connecting…</div>
      <button class="realtime-mic-btn" id="realtime-mic-btn">
        <span class="realtime-mic-icon">🎙</span>
        <span class="realtime-pulse"></span>
      </button>
      <div class="realtime-transcript" id="realtime-transcript"></div>
    </div>

    <div class="message-list" id="message-list">
      <div class="empty-state" id="empty-state">
        <div class="empty-state-icon">🤖</div>
        <div class="empty-state-title">Hi, I'm Reachy!</div>
        <div class="empty-state-hint">
          Say hello or ask me anything — I'll react with my whole body.
        </div>
      </div>
    </div>

    <div class="ptt-hint" id="ptt-hint" aria-live="polite"></div>

    <div class="input-bar">
      <button
        class="icon-btn btn-mic"
        id="btn-mic"
        title="Hold to speak"
        aria-label="Hold to speak"
      >🎤</button>
      <textarea
        class="input-textarea"
        id="input-textarea"
        rows="1"
        placeholder="Type a message or hold 🎤 to speak…"
        autocomplete="off"
        spellcheck="true"
      ></textarea>
      <button class="icon-btn btn-send" id="btn-send" aria-label="Send message">
        ➤
      </button>
    </div>
  `;

  root.appendChild(appEl);

  // Cache refs
  headerStatusDot = appEl.querySelector('#status-dot')!;
  headerStatusText = appEl.querySelector('#status-text')!;
  actionChip = appEl.querySelector('#action-chip')!;
  messageList = appEl.querySelector('#message-list')!;
  inputTextarea = appEl.querySelector('#input-textarea') as HTMLTextAreaElement;
  btnMic = appEl.querySelector('#btn-mic') as HTMLButtonElement;
  btnSend = appEl.querySelector('#btn-send') as HTMLButtonElement;
  pttHint = appEl.querySelector('#ptt-hint')!;

  // Mode toggle refs
  const modeToggle = appEl.querySelector('#mode-toggle') as HTMLButtonElement;
  const modeLabel = appEl.querySelector('#mode-label')!;

  // Auto-resize textarea
  inputTextarea.addEventListener('input', () => {
    inputTextarea.style.height = 'auto';
    inputTextarea.style.height = `${Math.min(inputTextarea.scrollHeight, 120)}px`;
  });

  // Send on Enter (not Shift+Enter)
  inputTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });

  btnSend.addEventListener('click', sendCurrent);

  // ── Push-to-Talk bindings ──────────────────────────────────────────────────
  // Use Pointer Events + setPointerCapture so the release event is always
  // delivered to this element even if the pointer moves outside the button.
  // This works for mouse, touch, and stylus with a single code path.
  btnMic.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btnMic.setPointerCapture(e.pointerId); // capture → pointerup always fires here
    onMicDown();
  });
  btnMic.addEventListener('pointerup', (e) => {
    e.preventDefault();
    btnMic.releasePointerCapture(e.pointerId);
    onMicUp();
  });
  btnMic.addEventListener('pointercancel', () => {
    onMicUp();
  });

  // ── Mode toggle ──────────────────────────────────────────────────────────
  let currentMode: AppMode = 'text';
  modeToggle.addEventListener('click', () => {
    currentMode = currentMode === 'text' ? 'realtime' : 'text';
    modeLabel.textContent = currentMode === 'text' ? '💬 Text' : '🎙 Realtime';
    modeToggle.title = currentMode === 'text'
      ? 'Switch to Realtime voice mode'
      : 'Switch to Text mode';
    onModeChange(currentMode);
  });
}

function sendCurrent() {
  const text = inputTextarea.value.trim();
  if (!text) return;
  inputTextarea.value = '';
  inputTextarea.style.height = 'auto';
  onSend(text);
}

/** Remove the empty-state placeholder on first message */
function removeEmptyState() {
  const es = document.getElementById('empty-state');
  if (es) es.remove();
}

/** Auto-scroll to bottom of message list */
function scrollToBottom() {
  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
}

/**
 * Append a user message bubble.
 */
export function addUserMessage(text: string): void {
  removeEmptyState();
  const el = document.createElement('div');
  el.className = 'message user';
  el.innerHTML = `
    <div class="bubble-avatar">👤</div>
    <div class="bubble-content">${escapeHtml(text)}</div>
  `;
  messageList.appendChild(el);
  scrollToBottom();
}

/**
 * Start a new streaming assistant message.
 * Returns a writer object to append text chunks and finalize.
 */
export function startAssistantMessage(): {
  appendText: (text: string) => void;
  finalize: () => void;
  appendError: (msg: string) => void;
} {
  removeEmptyState();
  const el = document.createElement('div');
  el.className = 'message assistant';
  el.innerHTML = `
    <div class="bubble-avatar">🤖</div>
    <div class="bubble-content" id="streaming-bubble">
      <span class="cursor"></span>
    </div>
  `;
  messageList.appendChild(el);
  scrollToBottom();

  const bubble = el.querySelector('#streaming-bubble')!;
  const cursor = bubble.querySelector('.cursor')!;
  let accumulated = '';

  return {
    appendText(chunk: string) {
      accumulated += chunk;
      // Re-render text before cursor
      bubble.textContent = '';
      bubble.appendChild(document.createTextNode(accumulated));
      bubble.appendChild(cursor);
      scrollToBottom();
    },
    finalize() {
      // Remove cursor, set final text
      cursor.remove();
      bubble.textContent = accumulated;
      bubble.removeAttribute('id');
    },
    appendError(msg: string) {
      cursor.remove();
      bubble.textContent = `⚠️ ${msg}`;
      el.classList.add('error');
      bubble.removeAttribute('id');
    },
  };
}

/**
 * Update header status indicator.
 */
export function setStatus(status: Status, label?: string): void {
  headerStatusDot.className = `status-dot ${status}`;
  headerStatusText.textContent =
    label ??
    (status === 'connected'
      ? 'Robot connected'
      : status === 'thinking'
        ? 'Thinking…'
        : 'Offline');
}

/**
 * Show action chip briefly in the header.
 */
export function showActionChip(label: string): void {
  actionChip.textContent = label;
  actionChip.classList.add('visible');
  setTimeout(() => actionChip.classList.remove('visible'), 2500);
}

/**
 * Enable or disable the input controls.
 */
export function setInputEnabled(enabled: boolean): void {
  inputTextarea.disabled = !enabled;
  btnSend.disabled = !enabled;
  if (enabled) {
    btnSend.classList.remove('loading');
    inputTextarea.focus();
  } else {
    btnSend.classList.add('loading');
  }
}

/**
 * Set the microphone button visual mode.
 *
 * - 'idle'      : 🎤 default grey
 * - 'listening' : 🎤 red pulse (PTT active — recording)
 * - 'speaking'  : 🔊 blue pulse (TTS playing — click to interrupt)
 */
export function setMicMode(mode: MicMode): void {
  btnMic.classList.remove('listening', 'speaking');

  switch (mode) {
    case 'listening':
      btnMic.classList.add('listening');
      btnMic.textContent = '🎤';
      btnMic.title = 'Release to send';
      btnMic.setAttribute('aria-label', 'Release to send voice message');
      pttHint.textContent = '🎙 Listening… release to send';
      pttHint.classList.add('visible');
      break;

    case 'speaking':
      btnMic.classList.add('speaking');
      btnMic.textContent = '🔊';
      btnMic.title = 'Hold mic to interrupt';
      btnMic.setAttribute('aria-label', 'Speaking — hold mic to interrupt');
      pttHint.textContent = '🔊 Speaking… hold mic to interrupt';
      pttHint.classList.add('visible');
      break;

    default: // idle
      btnMic.textContent = '🎤';
      btnMic.title = 'Hold to speak';
      btnMic.setAttribute('aria-label', 'Hold to speak');
      pttHint.textContent = '';
      pttHint.classList.remove('visible');
      break;
  }
}

/**
 * Set textarea value (used by STT interim results).
 */
export function setInputText(text: string): void {
  inputTextarea.value = text;
  inputTextarea.style.height = 'auto';
  inputTextarea.style.height = `${Math.min(inputTextarea.scrollHeight, 120)}px`;
}

/** HTML escape for safe text insertion */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------------------------------------------------------------------------
// Realtime mode UI helpers
// ---------------------------------------------------------------------------

/**
 * Switch the visible UI between text and realtime mode.
 * Called by embed.ts when mode changes.
 */
export function setMode(mode: AppMode): void {
  const realtimePanel = document.getElementById('realtime-panel')!;
  const inputBar = appEl.querySelector('.input-bar') as HTMLElement;
  const msgList = document.getElementById('message-list')!;
  const ptt = document.getElementById('ptt-hint')!;

  if (mode === 'realtime') {
    realtimePanel.classList.remove('hidden');
    inputBar.classList.add('hidden');
    ptt.classList.add('hidden');
    // Keep message list visible behind the panel for context
    msgList.style.opacity = '0.3';
  } else {
    realtimePanel.classList.add('hidden');
    inputBar.classList.remove('hidden');
    ptt.classList.remove('hidden');
    msgList.style.opacity = '1';
  }
}

/** Update the realtime status text and mic button state */
export function setRealtimeStatus(
  status: 'connecting' | 'connected' | 'listening' | 'ai-speaking' | 'ai-thinking' | 'error' | 'disconnected',
): void {
  const statusEl = document.getElementById('realtime-status')!;
  const micBtn = document.getElementById('realtime-mic-btn') as HTMLButtonElement;

  micBtn.className = 'realtime-mic-btn'; // reset classes

  switch (status) {
    case 'connecting':
      statusEl.textContent = '⏳ Connecting…';
      micBtn.classList.add('connecting');
      break;
    case 'connected':
      statusEl.textContent = '✅ Connected — start speaking!';
      micBtn.classList.add('idle');
      break;
    case 'listening':
      statusEl.textContent = '🎙 Listening…';
      micBtn.classList.add('listening');
      break;
    case 'ai-speaking':
      statusEl.textContent = '🔊 Reachy is speaking…';
      micBtn.classList.add('speaking');
      break;
    case 'ai-thinking':
      statusEl.textContent = '🤖 Reachy is acting…';
      micBtn.classList.add('speaking');
      break;
    case 'error':
      statusEl.textContent = '❌ Connection error';
      micBtn.classList.add('error');
      break;
    case 'disconnected':
      statusEl.textContent = 'Disconnected';
      micBtn.classList.add('idle');
      break;
  }
}

/** Append text to the realtime transcript area */
export function appendRealtimeTranscript(text: string, role: 'user' | 'assistant'): void {
  const el = document.getElementById('realtime-transcript')!;
  const span = document.createElement('span');
  span.className = `rt-${role}`;
  span.textContent = text;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

/** Clear the realtime transcript */
export function clearRealtimeTranscript(): void {
  const el = document.getElementById('realtime-transcript')!;
  el.innerHTML = '';
}
