'use client';

import { wsService } from './ws-service';

// === Types ===

export interface SoundSettings {
  enabled: boolean;
  volume: number; // 0-100
}

// === Constants ===

const STORAGE_KEY = 'antigravity-sound-settings';
const DEFAULT_SETTINGS: SoundSettings = { enabled: false, volume: 70 };
const SETTINGS_CHANGED_EVENT = 'sound-settings-changed';

const SOUND_FILES: Record<string, string> = {
  'cascade-complete': '/sounds/cascade-complete.mp3',
  'waiting-for-user': '/sounds/waiting-for-user.mp3',
  'error': '/sounds/error.mp3',
  'auto-accepted': '/sounds/auto-accepted.mp3',
};

const COMPLETE_STATUSES = [
  'CASCADE_RUN_STATUS_IDLE',
  'CASCADE_RUN_STATUS_DONE',
  'CASCADE_RUN_STATUS_COMPLETED',
];
const ACTIVE_STATUSES = [
  'CASCADE_RUN_STATUS_RUNNING',
  'CASCADE_RUN_STATUS_WAITING_FOR_USER',
];
const ERROR_STATUSES = [
  'CASCADE_RUN_STATUS_ERROR',
  'CASCADE_RUN_STATUS_FAILED',
];

const DEBOUNCE_MS = 3000;

// Events suppressed by default in Phase 1 (spec: auto-accepted defaults to OFF)
// Phase 2 will add per-event UI toggle; for now just skip these in playInternal
const SUPPRESSED_BY_DEFAULT = new Set(['auto-accepted']);

// === Service ===

class SoundNotificationService {
  private audioContext: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private _unlocked = false;
  private _initialized = false;
  private _settings: SoundSettings = DEFAULT_SETTINGS;
  private unsubscribers: Array<() => void> = [];

  // Status tracker — keyed per conversationId
  private statuses = new Map<string, string>();
  private initSeeded = new Set<string>();
  private lastPlayTime = new Map<string, number>();

  constructor() {
    this._settings = this.loadSettings();
  }

  // --- Settings ---

  getSettings(): SoundSettings {
    return { ...this._settings };
  }

  setEnabled(enabled: boolean): void {
    this._settings.enabled = enabled;
    this.saveSettings();
  }

  setVolume(volume: number): void {
    this._settings.volume = Math.max(0, Math.min(100, volume));
    this.saveSettings();
  }

  isUnlocked(): boolean {
    return this._unlocked;
  }

  private loadSettings(): SoundSettings {
    if (typeof window === 'undefined') return DEFAULT_SETTINGS;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(stored);
      return {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
        volume: typeof parsed.volume === 'number' ? parsed.volume : DEFAULT_SETTINGS.volume,
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private saveSettings(): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings));
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }

  // --- Lifecycle (init/unlock/destroy in Task 4) ---

  init(): void {
    if (this._initialized) return;
    this._initialized = true;

    // Create AudioContext
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      this.audioContext = new AC();
    }

    // Pre-load sound buffers
    for (const [eventId, path] of Object.entries(SOUND_FILES)) {
      this.loadBuffer(eventId, path);
    }

    // Subscribe to WS events (all cascades — no convId filter)
    if (wsService) {
      this.unsubscribers.push(
        wsService.on('cascade_status', (data) => {
          const convId = data.conversationId as string;
          const newStatus = data.status as string;
          if (!convId || !newStatus) return;
          this.handleCascadeStatus(convId, newStatus);
        })
      );
      this.unsubscribers.push(
        wsService.on('auto_accepted', (data) => {
          const convId = data.conversationId as string;
          if (!convId) return;
          this.playInternal('auto-accepted', convId);
        })
      );
    }
  }

  private handleCascadeStatus(convId: string, newStatus: string): void {
    const prev = this.statuses.get(convId);
    this.statuses.set(convId, newStatus);

    // Smart init: first event for this conv is seed — skip if status unchanged
    if (this.initSeeded.has(convId)) {
      this.initSeeded.delete(convId);
      if (prev === newStatus) return; // duplicate baseline, no sound
      // Status actually changed — fall through to play
    }

    // First time seeing this conv (no prev) — seed it, no sound
    if (prev === undefined) {
      this.initSeeded.add(convId);
      return;
    }

    // Cascade complete: prev was active, now terminal success
    if (ACTIVE_STATUSES.includes(prev) && COMPLETE_STATUSES.includes(newStatus)) {
      this.playInternal('cascade-complete', convId);
      return;
    }

    // Waiting for user
    if (newStatus === 'CASCADE_RUN_STATUS_WAITING_FOR_USER' && prev !== 'CASCADE_RUN_STATUS_WAITING_FOR_USER') {
      this.playInternal('waiting-for-user', convId);
      return;
    }

    // Error
    if (ERROR_STATUSES.includes(newStatus) && !ERROR_STATUSES.includes(prev)) {
      this.playInternal('error', convId);
      return;
    }
  }

  private async playInternal(eventId: string, convId: string): Promise<void> {
    if (!this._settings.enabled) return;
    if (SUPPRESSED_BY_DEFAULT.has(eventId)) return; // Phase 1: auto-accepted OFF by default

    // Debounce: same event + same conv within 3s
    const key = `${eventId}:${convId}`;
    const now = Date.now();
    if (now - (this.lastPlayTime.get(key) || 0) < DEBOUNCE_MS) return;
    this.lastPlayTime.set(key, now);

    const volume = this._settings.volume / 100;

    // Try Web Audio API first
    if (this.audioContext) {
      try {
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
        const buffer = this.buffers.get(eventId);
        if (buffer) {
          const source = this.audioContext.createBufferSource();
          const gain = this.audioContext.createGain();
          source.buffer = buffer;
          gain.gain.value = volume;
          source.connect(gain);
          gain.connect(this.audioContext.destination);
          source.start(0);
          return;
        }
      } catch {
        // Fall through to HTML5 Audio
      }
    }

    // Fallback: HTML5 Audio
    try {
      const path = SOUND_FILES[eventId];
      if (path) {
        const audio = new Audio(path);
        audio.volume = volume;
        await audio.play();
      }
    } catch {
      console.warn(`[Sound] Could not play sound for ${eventId}`);
    }
  }

  private async loadBuffer(eventId: string, path: string): Promise<void> {
    if (!this.audioContext) return;
    try {
      const response = await fetch(path);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      this.buffers.set(eventId, audioBuffer);
    } catch {
      console.warn(`[Sound] Failed to preload ${path}`);
    }
  }

  unlock(): void {
    if (this._unlocked) return;
    if (!this.audioContext) return;
    this._unlocked = true;

    // Resume AudioContext (required by iOS Safari autoplay policy)
    this.audioContext.resume().catch(() => {});

    // Play a silent buffer to fully "unlock" the audio pipeline
    try {
      const buffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start(0);
    } catch {
      // Ignore — unlock is best-effort
    }
  }

  testSound(): void {
    if (!this._settings.enabled) return;
    // Bypass debounce for test — use a unique convId
    this.playInternal('cascade-complete', `__test__${Date.now()}`);
  }

  destroy(): void {
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.buffers.clear();
    this.statuses.clear();
    this.initSeeded.clear();
    this.lastPlayTime.clear();
    this._initialized = false;
    this._unlocked = false;
  }
}

export const soundService = typeof window !== 'undefined'
  ? new SoundNotificationService()
  : null;

export { SETTINGS_CHANGED_EVENT };
