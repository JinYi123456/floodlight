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
  /** Big moments cut in louder and faster — the commentator raising his voice. */
  urgent?: boolean;
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
  private voice: SpeechSynthesisVoice | null = null;
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
    if (this.voice === null && typeof speechSynthesis !== 'undefined') {
      // Pick the most engaging voice on offer: natural/neural first, then
      // the livelier named voices, English before the rest.
      const score = (candidate: SpeechSynthesisVoice): number => {
        const name = candidate.name.toLowerCase();
        if (!candidate.lang.toLowerCase().startsWith('en')) return -1;
        let value = candidate.lang === 'en-GB' || candidate.lang === 'en-US' ? 6 : 3;
        if (/natural|online|neural/.test(name)) value += 5;
        if (/guy|ryan|george|christopher|daniel|alex|brian/.test(name)) value += 3;
        if (/aria|jenny|sonia|libby/.test(name)) value += 2;
        if (/david|mark|zira/.test(name)) value += 1;
        return value;
      };
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        let best: SpeechSynthesisVoice | null = null;
        let bestScore = 0;
        for (const candidate of voices) {
          const value = score(candidate);
          if (value > bestScore) {
            best = candidate;
            bestScore = value;
          }
        }
        this.voice = best;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
    this.enabled = true;
    this.crowd?.gain.setTargetAtTime(CROWD_BASE, this.ctx.currentTime, 0.8);
    return true;
  }

  disable(): void {
    this.enabled = false;
    this.lastPlaying = false;
    if (this.ctx && this.crowd) {
      this.crowd.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.25);
    }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.speaking = false;
    this.pending = [];
    this.stopClip();
  }

  /** Advance the audio clock: fire the sounds of events crossed since the
   *  last call, decay excitement, and keep the pointer honest on scrubs.
   *  Paused means silent: the bed fades out and the commentary desk stops
   *  mid-sentence — resuming picks the match up where the viewer left it. */
  update(events: HitEvent[], t: number, playing: boolean): void {
    if (!this.ctx || !this.enabled) {
      this.lastPlaying = false;
      return;
    }
    this.lastPlaying = playing;
    const wall = performance.now();
    const dt = this.lastWall > 0 ? Math.min(1, (wall - this.lastWall) / 1000) : 0.1;
    this.lastWall = wall;
    this.excitement *= Math.exp(-dt / 4.2);
    this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    this.whistleCooldown = Math.max(0, this.whistleCooldown - dt);

    if (!playing) {
      if (this.speaking || this.pending.length > 0 || this.clip) {
        if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
        this.speaking = false;
        this.pending = [];
        this.stopClip();
        this.cancelCount++;
      }
      this.crowd?.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.12);
      this.prevT = t;
      return;
    }

    const level = Math.min(CROWD_PEAK, CROWD_BASE + this.excitement * (CROWD_PEAK - CROWD_BASE));
    this.crowd?.gain.setTargetAtTime(level, this.ctx.currentTime, 0.35);

    if (Number.isNaN(this.prevT) || t < this.prevT || t - this.prevT > 2.5) {
      // A scrub or a big jump — resynchronise without firing a burst.
      this.pointer = seek(events, this.pointer, t);
      this.prevT = t;
      return;
    }
    while (this.pointer < events.length && events[this.pointer]!.t <= this.prevT) this.pointer++;
    while (this.pointer < events.length && events[this.pointer]!.t <= t) {
      this.hit(events[this.pointer]!);
      this.pointer++;
    }
    this.prevT = t;
  }

  /** Read a story moment aloud — the recorded commentator clip when one is
   *  available, the platform voice otherwise. Goals and other turning points
   *  interrupt the current line, the way a commentator cuts himself off. */
  moment(id: string, text: string, clipUrl: string | null, interrupt = false): void {
    if (!this.enabled || !text) return;
    if (this.spoken.has(id)) return;
    this.spoken.add(id);
    this.queueCount++;
    if (this.spoken.size > 400) this.spoken.clear();
    const line: VoiceLine =
      clipUrl && !this.clipMisses.has(clipUrl) ? { text, url: clipUrl, urgent: interrupt } : { text, urgent: interrupt };
    if (interrupt) {
      this.pending = [];
      this.cancelSpeech();
      this.stopClip();
      this.play(line);
      return;
    }
    if (this.busy()) {
      if (this.pending.length >= 2) this.pending.shift();
      this.pending.push(line);
      return;
    }
    this.play(line);
  }

  /** Read a line through the platform voice (the play-by-play mic). */
  speak(id: string, text: string, interrupt = false): void {
    if (!this.enabled || typeof speechSynthesis === 'undefined' || !text) return;
    if (this.spoken.has(id)) return;
    this.spoken.add(id);
    this.queueCount++;
    if (this.spoken.size > 400) this.spoken.clear();
    if (interrupt) {
      this.pending = [];
      this.cancelSpeech();
      this.stopClip();
      this.say(text, true);
      return;
    }
    if (this.busy()) {
      if (this.pending.length >= 2) this.pending.shift();
      this.pending.push({ text });
      return;
    }
    this.say(text);
  }

  private busy(): boolean {
    return this.speaking || this.clip !== null;
  }

  private play(line: VoiceLine): void {
    if (line.url) {
      void this.playClip(line.url, line);
      return;
    }
    this.say(line.text, line.urgent ?? false);
  }

  private async playClip(url: string, line: VoiceLine): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    let buffer = this.clipCache.get(url);
    if (!buffer) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(String(response.status));
        buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        this.clipCache.set(url, buffer);
      } catch {
        // Missing or undecodable clip — fall back to the platform voice.
        this.clipMisses.add(url);
        if (this.enabled && this.lastPlaying) this.say(line.text, line.urgent ?? false);
        return;
      }
    }
    if (!this.enabled || !this.lastPlaying) return;
    this.stopClip();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.speechGain ?? this.master!);
    source.onended = () => {
      if (this.clip === source) {
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
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    this.clipStopCount++;
  }

  private cancelSpeech(): void {
    if (typeof speechSynthesis !== 'undefined' && this.speaking) speechSynthesis.cancel();
    this.speaking = false;
  }

  private drainPending(): void {
    const next = this.pending.shift();
    if (next && this.enabled && this.lastPlaying) this.play(next);
  }

  private say(text: string, urgent = false): void {
    if (typeof speechSynthesis === 'undefined') return;
    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) utterance.voice = this.voice;
    utterance.rate = urgent ? 1.22 : 1.07;
    utterance.pitch = urgent ? 1.07 : 0.99;
    utterance.volume = urgent ? 1 : 0.95;
    utterance.onend = () => {
      this.speaking = false;
      this.drainPending();
    };
    utterance.onerror = () => {
      this.speaking = false;
    };
    this.speaking = true;
    this.sayCount++;
    this.lastText = text.slice(0, 80);
    speechSynthesis.speak(utterance);
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
    };
  }
}

/** Nearest event index with `t >= time` — cheap binary search for scrubs. */
function seek(events: HitEvent[], from: number, t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  void from;
  return lo;
}

/** One broadcast bus per studio session. */
export const broadcast = new BroadcastAudio();
