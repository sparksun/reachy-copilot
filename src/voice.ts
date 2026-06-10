/**
 * voice.ts — VoiceController
 *
 * Encapsulates all STT (Speech-to-Text) and TTS (Text-to-Speech) logic.
 * Designed for noisy environments via Push-to-Talk (PTT):
 *   - Recording ONLY happens while the user holds the mic button.
 *   - Auto-stops after MAX_RECORD_MS to prevent runaway sessions.
 *
 * STT: Web Speech API (webkitSpeechRecognition / SpeechRecognition)
 * TTS: Web Speech Synthesis API
 *
 * Language strategy:
 *   - STT uses navigator.language (OS locale → what the user speaks)
 *   - TTS auto-detects the response language by scanning for CJK characters,
 *     then picks the best matching voice from the synthesis engine.
 */

/** Maximum recording duration in milliseconds (PTT safety cap). */
const MAX_RECORD_MS = 60_000;

/** TTS rate — slightly faster than default to reduce wait time. */
const TTS_RATE = 1.1;

// ─── SpeechRecognition type shim ─────────────────────────────────────────────

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: Event) => void) | null;
}

declare const webkitSpeechRecognition: new () => SpeechRecognition;

// ─── VoiceController ─────────────────────────────────────────────────────────

export class VoiceController {
  /** Called continuously during recording with interim transcript. */
  onTranscriptInterim: (text: string) => void = () => {};

  /** Called when PTT is released and a final transcript is available. */
  onTranscriptFinal: (text: string) => void = () => {};

  private recognition: SpeechRecognition | null = null;
  private _isListening = false;
  private _isSpeaking = false;
  private _interimText = '';
  private _finalText = '';
  private _timeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Set by stopListening() so onend knows to commit when results arrive. */
  private _pendingCommit = false;

  get isListening(): boolean { return this._isListening; }
  get isSpeaking(): boolean { return this._isSpeaking; }

  /** True if STT is available in this browser. */
  get sttSupported(): boolean {
    return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  }

  /** True if TTS is available in this browser. */
  get ttsSupported(): boolean {
    return 'speechSynthesis' in window;
  }

  constructor() {
    this._initRecognition();
  }

  // ─── STT ─────────────────────────────────────────────────────────────────

  private _initRecognition(): void {
    const Ctor: (new () => SpeechRecognition) | null =
      'SpeechRecognition' in window
        ? (window as unknown as { SpeechRecognition: new () => SpeechRecognition }).SpeechRecognition
        : 'webkitSpeechRecognition' in window
          ? webkitSpeechRecognition
          : null;

    if (!Ctor) return;

    this.recognition = new Ctor();
    this.recognition.continuous = true;   // PTT: we control stop, not auto-silence
    this.recognition.interimResults = true;
    // Use the OS locale — matches what the user actually speaks.
    this.recognition.lang = navigator.language || 'zh-CN';

    this.recognition.onresult = (e: SpeechRecognitionEvent) => {
      // In continuous mode, e.results accumulates across the whole session.
      // Build the full transcript from all results so far.
      let interim = '';
      let final = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          final += r[0].transcript;
        } else {
          interim += r[0].transcript;
        }
      }
      const combined = final + interim;
      if (final) {
        this._finalText = final;
        console.debug('[voice] onresult FINAL:', final);
      } else {
        console.debug('[voice] onresult interim:', interim);
      }
      this._interimText = combined;
      this.onTranscriptInterim(combined);
    };

    this.recognition.onend = () => {
      console.debug('[voice] onend — pendingCommit:', this._pendingCommit,
        'final:', JSON.stringify(this._finalText),
        'interim:', JSON.stringify(this._interimText));
      this._isListening = false;
      this._clearTimeout();
      if (this._pendingCommit) {
        this._pendingCommit = false;
        this._commitTranscript();
      }
    };

    this.recognition.onerror = (e) => {
      console.warn('[voice] onerror:', (e as ErrorEvent).message ?? e);
      this._isListening = false;
      this._pendingCommit = false;
      this._clearTimeout();
    };
  }

  /**
   * Start recording (called on mousedown / touchstart).
   * Enforces MAX_RECORD_MS safety timeout.
   */
  startListening(): void {
    if (!this.recognition || this._isListening) return;
    console.debug('[voice] startListening — lang:', this.recognition.lang);

    // Interrupt any ongoing TTS so the mic can hear the user.
    this.cancelSpeech();

    this._interimText = '';
    this._finalText = '';
    this._isListening = true;

    try {
      this.recognition.start();
      console.debug('[voice] recognition.start() called');
    } catch (err) {
      console.warn('[voice] recognition.start() threw:', err);
      this._isListening = false;
      return;
    }

    // Safety cap — auto-stop after MAX_RECORD_MS
    this._timeoutId = setTimeout(() => {
      this._commitTranscript();
    }, MAX_RECORD_MS);
  }

  /**
   * Stop recording (called on mouseup / touchend via document-level listener).
   * Commit is deferred to onend so that onresult has time to fire first.
   */
  stopListening(): void {
    if (!this.recognition || !this._isListening) {
      console.debug('[voice] stopListening skipped — isListening:', this._isListening);
      return;
    }
    console.debug('[voice] stopListening — setting pendingCommit');
    this._clearTimeout();
    this._isListening = false;
    this._pendingCommit = true;

    try {
      this.recognition.stop();
    } catch { /* ignore */ }
  }

  private _commitTranscript(): void {
    const text = (this._finalText || this._interimText).trim();
    console.debug('[voice] _commitTranscript — text:', JSON.stringify(text));
    if (text) {
      this.onTranscriptFinal(text);
    } else {
      console.warn('[voice] _commitTranscript — nothing to send (both final and interim are empty)');
    }
    this._finalText = '';
    this._interimText = '';
  }

  private _clearTimeout(): void {
    if (this._timeoutId !== null) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
  }

  // ─── TTS ─────────────────────────────────────────────────────────────────

  /**
   * Speak the given text.
   *
   * Language detection:
   *   - If text contains CJK characters → use a Chinese voice (zh)
   *   - Otherwise → use the OS locale voice
   *
   * @param text - The plain text to speak (action tags must already be stripped)
   * @param onEnd - Optional callback when speech finishes or is cancelled
   */
  speak(text: string, onEnd?: () => void): void {
    if (!this.ttsSupported || !text.trim()) {
      onEnd?.();
      return;
    }

    // Cancel any in-progress speech first
    this.cancelSpeech();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = TTS_RATE;
    utterance.pitch = 1.0;

    // Auto-detect language from content
    const lang = detectLang(text);
    utterance.lang = lang;

    // Pick the best matching voice for the detected language
    const voice = pickVoice(lang);
    if (voice) utterance.voice = voice;

    this._isSpeaking = true;

    utterance.onend = () => {
      this._isSpeaking = false;
      onEnd?.();
    };

    utterance.onerror = () => {
      this._isSpeaking = false;
      onEnd?.();
    };

    window.speechSynthesis.speak(utterance);
  }

  /**
   * Cancel any ongoing TTS immediately.
   */
  cancelSpeech(): void {
    if (!this.ttsSupported) return;
    window.speechSynthesis.cancel();
    this._isSpeaking = false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Detect the primary language of the text.
 * Simple heuristic: if CJK characters make up ≥ 20% of non-whitespace chars,
 * treat as Chinese; otherwise fall back to OS locale.
 */
function detectLang(text: string): string {
  const nonWs = text.replace(/\s/g, '');
  if (!nonWs.length) return navigator.language || 'en-US';

  // CJK Unified Ideographs + common punctuation ranges
  const cjkCount = (nonWs.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const ratio = cjkCount / nonWs.length;

  if (ratio >= 0.2) return 'zh-CN';
  return navigator.language || 'en-US';
}

/**
 * Pick the best SpeechSynthesisVoice for the given BCP 47 language tag.
 * Prefers an exact match, then a prefix match (e.g. 'zh' for 'zh-CN').
 */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  const langLower = lang.toLowerCase();
  const prefix = langLower.split('-')[0];

  return (
    voices.find((v) => v.lang.toLowerCase() === langLower) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ??
    null
  );
}
