/**
 * Broadcast audio — the sound of the programme, synthesised in the browser.
 *
 * A low crowd bed breathes with the match and swells when something nearly
 * happens, kicks and whistles punctuate the event stream as the clock
 * crosses each one, goals get the roar. The commentary desk has two voices:
 * story moments play pre-rendered commentator clips (a real neural voice,
 * delivered with pace), while the play-by-play mic reads the live event
 * stream through the platform's speech synthesis. No keys, no services in
 * the browser — clips are static assets, everything else is oscillators and
 * shaped noise.
 */

interface HitEvent {
  t: number;
  type: string;
  outcome?: string | null;
  ballSpeedKph?: number;
}

interface VoiceLine {
  text: string;
  url?: string;
  expiresAt: number;
  /** Big moments cut in louder and faster — the commentator raising his voice. */
  urgent?: boolean;
}

export interface AudioPlayback {
  /** Match object identity also separates regenerated matches with the same id. */
  sessionId?: unknown;
  epoch?: number;
  lang?: string;
  persona?: string;
  preferenceKey?: string;
  rate?: number;
}

const MASTER_GAIN = 0.9;
const CROWD_BASE = 0.03;
const CROWD_PEAK = 0.12;

export class BroadcastAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private speechGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private pointer = 0;
  private prevT = Number.NaN;
  private excitement = 0;
  private lastWall = 0;
  private kickCooldown = 0;
  private whistleCooldown = 0;
  private spoken = new Set<string>();
  private pending: VoiceLine[] = [];
  private speaking = false;
  private clip: AudioBufferSourceNode | null = null;
  private clipCache = new Map<string, AudioBuffer>();
  private clipMisses = new Set<string>();
  private lastPlaying = false;
  private sessionId: unknown;
  private epoch: number | undefined;
  private lang = 'en';
  private persona = 'analyst';
  private preferenceKey = '';
  private rate = 1;
  private generation = 0;
  private loading: AbortController | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private queueCount = 0;
  private sayCount = 0;
  private cancelCount = 0;
  private clipCount = 0;
  private clipStopCount = 0;
  private lastText = '';
  enabled = false;

  /** Create the graph (needs a user gesture) and fade the crowd in. */
  enable(): boolean {
    if (!this.ctx) {
      const Ctor = window.AudioContext;
      if (!Ctor) return false;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = MASTER_GAIN;
      this.master.connect(ctx.destination);

      // Two seconds of brown-ish noise, looped, behind a soft low-pass.
      const length = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.2;
      }
      this.noise = buffer;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 640;
      this.crowd = ctx.createGain();
      this.crowd.gain.value = 0.0001;
      source.connect(lowpass);
      lowpass.connect(this.crowd);
      this.crowd.connect(this.master);
      source.start();

      this.speechGain = ctx.createGain();
      this.speechGain.gain.value = 0.95;
      this.speechGain.connect(this.master);
    }
    void this.ctx.resume().catch(() => undefined);
    this.enabled = true;
    this.crowd?.gain.setTargetAtTime(this.lastPlaying ? CROWD_BASE : 0.0001, this.ctx.currentTime, 0.8);
    return true;
  }

  disable(): void {
    this.enabled = false;
    this.lastPlaying = false;
    if (this.ctx && this.crowd) {
      this.crowd.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.25);
    }
    this.cancelCommentary();
  }

  /** Advance even while muted: seeks/preferences must invalidate async work
   *  before a previously requested fetch or decode can reach the speaker. */
  update(events: HitEvent[], t: number, playing: boolean, playback: AudioPlayback = {}): void {
    const sessionId = playback.sessionId ?? events;
    const lang = (playback.lang ?? 'en').toLowerCase();
    const persona = playback.persona ?? 'analyst';
    const preferenceKey = playback.preferenceKey ?? '';
    const requestedRate = playback.rate ?? 1;
    const rate = Number.isFinite(requestedRate) ? Math.max(0.25, Math.min(4, requestedRate)) : 1;
    const newSession = sessionId !== this.sessionId;
    // Epoch catches even a seek to the exact same timestamp. The detector is
    // a fallback for callers without an explicit clock lifecycle.
    const jumped = Number.isFinite(this.prevT) &&
      (t < this.prevT || (playback.epoch === undefined && t - this.prevT > 2.5));
    const reset = newSession || playback.epoch !== this.epoch || jumped ||
      lang !== this.lang || persona !== this.persona || preferenceKey !== this.preferenceKey;
    if (reset || rate !== this.rate || (!playing && this.lastPlaying)) this.cancelCommentary();
    if (reset) {
      this.spoken.clear();
      this.pointer = seek(events, t);
      this.prevT = t;
      this.excitement = 0;
      this.kickCooldown = 0;
      this.whistleCooldown = 0;
    }
    if (newSession) {
      this.clipCache.clear();
      this.clipMisses.clear();
    }
    this.sessionId = sessionId;
    this.epoch = playback.epoch;
    this.lang = lang;
    this.persona = persona;
    this.preferenceKey = preferenceKey;
    this.rate = rate;
    this.lastPlaying = playing;
    if (!this.ctx || !this.enabled) {
      this.prevT = t;
      return;
    }
    const wall = performance.now();
    const dt = this.lastWall > 0 ? Math.min(1, (wall - this.lastWall) / 1000) : 0.1;
    this.lastWall = wall;
    this.excitement *= Math.exp(-dt / 4.2);
    this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    this.whistleCooldown = Math.max(0, this.whistleCooldown - dt);

    if (!playing) {
      this.crowd?.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.12);
      this.prevT = t;
      return;
    }

    const level = Math.min(CROWD_PEAK, CROWD_BASE + this.excitement * (CROWD_PEAK - CROWD_BASE));
    this.crowd?.gain.setTargetAtTime(level, this.ctx.currentTime, 0.35);

    while (this.pointer < events.length && events[this.pointer]!.t <= this.prevT) this.pointer++;
    while (this.pointer < events.length && events[this.pointer]!.t <= t) {
      this.hit(events[this.pointer]!);
      this.pointer++;
    }
    this.prevT = t;
  }

  /** clipUrl must already be bound to this exact text/locale by the caller. */
  moment(id: string, text: string, clipUrl: string | null, interrupt = false): void {
    if (!this.enabled || !this.lastPlaying || !text || this.spoken.has(id)) return;
    this.spoken.add(id);
    // At 4× even short narration falls behind. Keep effects, explicitly mute
    // commentary rather than accumulating a queue or speaking stale stories.
    if (this.rate > 2) return;
    this.queueCount++;
    const line: VoiceLine = {
      text,
      url: clipUrl && !this.clipMisses.has(clipUrl) ? clipUrl : undefined,
      urgent: interrupt,
      expiresAt: this.prevT + 5,
    };
    if (interrupt) {
      this.cancelCommentary();
      this.play(line);
    } else if (this.busy()) {
      // One fresh line at normal speed, none when the match is accelerated.
      if (this.rate <= 1) this.pending = [line];
    } else {
      this.play(line);
    }
  }

  /** Read a line through the platform voice (the play-by-play mic). */
  speak(id: string, text: string, interrupt = false): void {
    this.moment(id, text, null, interrupt);
  }

  private busy(): boolean {
    return this.speaking || this.clip !== null || this.loading !== null;
  }

  private current(generation: number): boolean {
    return generation === this.generation && this.enabled && this.lastPlaying && this.rate <= 2;
  }

  private play(line: VoiceLine): void {
    const generation = ++this.generation;
    if (line.url) {
      void this.playClip(line.url, line, generation);
    } else {
      this.say(line.text, line.urgent ?? false, generation);
    }
  }

  private async playClip(url: string, line: VoiceLine, generation: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.current(generation)) return;
    let buffer = this.clipCache.get(url);
    if (!buffer) {
      const controller = new AbortController();
      this.loading = controller;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!this.current(generation)) return;
        if (!response.ok) throw new Error(String(response.status));
        const bytes = await response.arrayBuffer();
        if (!this.current(generation)) return;
        buffer = await ctx.decodeAudioData(bytes);
        // decodeAudioData is not abortable; never trust completion alone.
        if (!this.current(generation)) return;
        this.clipCache.set(url, buffer);
      } catch {
        if (!this.current(generation)) return;
        this.clipMisses.add(url);
        this.loading = null;
        if (this.prevT <= line.expiresAt) this.say(line.text, line.urgent ?? false, generation);
        else this.drainPending();
        return;
      } finally {
        if (this.loading === controller) this.loading = null;
      }
    }
    if (!this.current(generation)) return;
    if (this.prevT > line.expiresAt) {
      this.drainPending();
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.speechGain ?? this.master!);
    source.onended = () => {
      source.disconnect();
      if (this.current(generation) && this.clip === source) {
        this.clip = null;
        this.drainPending();
      }
    };
    this.clip = source;
    this.clipCount++;
    this.lastText = line.text.slice(0, 80);
    source.start();
  }

  private stopClip(): void {
    if (!this.clip) return;
    const source = this.clip;
    this.clip = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
    this.clipStopCount++;
  }

  private cancelCommentary(): void {
    // Invalidate callbacks before stop/cancel, which can fire synchronously.
    this.generation++;
    this.loading?.abort();
    this.loading = null;
    this.pending = [];
    this.utterance = null;
    if (typeof speechSynthesis !== 'undefined' && this.speaking) speechSynthesis.cancel();
    this.speaking = false;
    this.stopClip();
    this.cancelCount++;
  }

  private drainPending(): void {
    const next = this.pending.shift();
    if (next && next.expiresAt >= this.prevT && this.enabled && this.lastPlaying && this.rate <= 2) this.play(next);
  }

  private say(text: string, urgent: boolean, generation: number): void {
    if (!this.current(generation) || typeof speechSynthesis === 'undefined' ||
      typeof SpeechSynthesisUtterance === 'undefined') return;
    const utterance = new SpeechSynthesisUtterance(text);
    const locale = ({ en: 'en-GB', es: 'es-ES', fr: 'fr-FR' } as Record<string, string>)[this.lang] ?? this.lang;
    // Resolve per line: voice lists often arrive after enable(), and a
    // language switch must never retain the previously selected English mic.
    const voices = speechSynthesis.getVoices().filter((voice) =>
      voice.lang.toLowerCase().split('-')[0] === this.lang.split('-')[0]);
    const score = (voice: SpeechSynthesisVoice) =>
      (voice.lang.toLowerCase() === locale.toLowerCase() ? 4 : 0) +
      (/natural|neural/i.test(voice.name) ? 2 : 0);
    voices.sort((a, b) => score(b) - score(a));
    if (voices[0]) utterance.voice = voices[0];
    utterance.lang = locale;
    utterance.rate = Math.min(2, (urgent ? 1.22 : 1.07) * this.rate);
    utterance.pitch = urgent ? 1.07 : 0.99;
    utterance.volume = urgent ? 1 : 0.95;
    const finished = () => {
      if (!this.current(generation) || this.utterance !== utterance) return;
      this.utterance = null;
      this.speaking = false;
      this.drainPending();
    };
    utterance.onend = finished;
    utterance.onerror = finished;
    this.utterance = utterance;
    this.speaking = true;
    this.sayCount++;
    this.lastText = text.slice(0, 80);
    try {
      speechSynthesis.speak(utterance);
    } catch {
      finished();
    }
  }

  private hit(event: HitEvent): void {
    switch (event.type) {
      case 'pass':
        this.kick(Math.min(1, (event.ballSpeedKph ?? 30) / 80) * 0.22);
        break;
      case 'clearance':
        this.kick(0.7);
        break;
      case 'carry':
        break;
      case 'shot':
        this.kick(0.95);
        this.excite(event.outcome === 'goal' ? 1 : 0.45);
        if (event.outcome === 'goal') this.goalRoar();
        break;
      case 'save':
      case 'block':
        this.kick(0.55);
        this.excite(0.3);
        break;
      case 'kickoff':
        this.whistle(1);
        this.excite(0.25);
        break;
      case 'half_time':
        this.whistle(2);
        break;
      case 'full_time':
        this.whistle(3);
        break;
      case 'foul':
        this.whistle(1);
        break;
      default:
        break;
    }
  }

  private excite(level: number): void {
    this.excitement = Math.max(this.excitement, level);
  }

  private kick(strength: number): void {
    if (!this.ctx || !this.master || !this.noise || this.kickCooldown > 0) return;
    this.kickCooldown = 0.12;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const burst = ctx.createBufferSource();
    burst.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 650 + strength * 550;
    filter.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3 * strength, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    burst.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    burst.start(now, Math.random() * 1.5, 0.14);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, now);
    thump.frequency.exponentialRampToValueAtTime(55, now + 0.07);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.28 * strength, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    thump.connect(thumpGain);
    thumpGain.connect(this.master);
    thump.start(now);
    thump.stop(now + 0.12);
  }

  private whistle(count: number): void {
    if (!this.ctx || !this.master || this.whistleCooldown > 0) return;
    this.whistleCooldown = 2.2;
    const ctx = this.ctx;
    const start = ctx.currentTime;
    for (let i = 0; i < count; i++) {
      const at = start + i * 0.28;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 2150;
      const warble = ctx.createOscillator();
      warble.frequency.value = 24;
      const warbleGain = ctx.createGain();
      warbleGain.gain.value = 60;
      warble.connect(warbleGain);
      warbleGain.connect(osc.frequency);
      const gain = ctx.createGain();
      const duration = count === 3 ? 0.5 : 0.16;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.095, at + 0.02);
      gain.gain.setTargetAtTime(0.0001, at + duration, 0.03);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(at);
      warble.start(at);
      osc.stop(at + duration + 0.15);
      warble.stop(at + duration + 0.15);
    }
  }

  private goalRoar(): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const swell = ctx.createBufferSource();
    swell.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 430;
    filter.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.42, now + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.8);
    swell.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    swell.start(now, 0, 4.0);
  }

  /** Development probe for the running page. */
  debugState(): {
    enabled: boolean;
    state: string | null;
    excitement: number;
    voices: number;
    spoken: number;
    queued: number;
    said: number;
    cancels: number;
    speaking: boolean;
    lastText: string;
    bed: number | null;
    clips: number;
    clipStops: number;
    clipCache: number;
    pending: number;
    loading: boolean;
    lang: string;
    rate: number;
    commentary: string;
  } {
    return {
      enabled: this.enabled,
      state: this.ctx ? this.ctx.state : null,
      excitement: Math.round(this.excitement * 100) / 100,
      voices: typeof speechSynthesis === 'undefined' ? 0 : speechSynthesis.getVoices().length,
      spoken: this.spoken.size,
      queued: this.queueCount,
      said: this.sayCount,
      cancels: this.cancelCount,
      speaking: this.speaking,
      lastText: this.lastText,
      bed: this.crowd ? Math.round(this.crowd.gain.value * 10000) / 10000 : null,
      clips: this.clipCount,
      clipStops: this.clipStopCount,
      clipCache: this.clipCache.size,
      pending: this.pending.length,
      loading: this.loading !== null,
      lang: this.lang,
      rate: this.rate,
      commentary: !this.enabled ? 'muted' : !this.lastPlaying ? 'paused' : this.rate > 2 ? 'fast-playback-muted' : 'ready',
    };
  }
}

/** Nearest event index with `t >= time` — cheap binary search for scrubs. */
function seek(events: HitEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One broadcast bus per studio session. */
export const broadcast = new BroadcastAudio();
