/**
 * Broadcast audio — the sound of the programme, synthesised in the browser.
 *
 * A low crowd bed breathes with the match and swells when something nearly
 * happens, kicks and whistles punctuate the event stream as the clock
 * crosses each one, goals get the roar, and the commentary desk reads cue
 * headlines aloud through the platform's speech synthesis. No assets, no
 * network — every sound is generated from oscillators and shaped noise.
 */

interface HitEvent {
  t: number;
  type: string;
  outcome?: string | null;
  ballSpeedKph?: number;
}

const MASTER_GAIN = 0.9;
const CROWD_BASE = 0.075;
const CROWD_PEAK = 0.34;

export class BroadcastAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private pointer = 0;
  private prevT = Number.NaN;
  private excitement = 0;
  private lastWall = 0;
  private kickCooldown = 0;
  private whistleCooldown = 0;
  private spoken = new Set<string>();
  private pending: string[] = [];
  private speaking = false;
  private voice: SpeechSynthesisVoice | null = null;
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
      lowpass.frequency.value = 720;
      this.crowd = ctx.createGain();
      this.crowd.gain.value = 0.0001;
      source.connect(lowpass);
      lowpass.connect(this.crowd);
      this.crowd.connect(this.master);
      source.start();
    }
    void this.ctx.resume().catch(() => undefined);
    if (this.voice === null && typeof speechSynthesis !== 'undefined') {
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        this.voice =
          voices.find((v) => v.lang === 'en-GB' && /male|daniel|george/i.test(v.name)) ??
          voices.find((v) => v.lang === 'en-GB') ??
          voices.find((v) => v.lang.startsWith('en')) ??
          voices[0] ??
          null;
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
    if (this.ctx && this.crowd) {
      this.crowd.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.25);
    }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.speaking = false;
    this.pending = [];
  }

  /** Advance the audio clock: fire the sounds of events crossed since the
   *  last call, decay excitement, and keep the pointer honest on scrubs. */
  update(events: HitEvent[], t: number, playing: boolean): void {
    if (!this.ctx || !this.enabled) return;
    const wall = performance.now();
    const dt = this.lastWall > 0 ? Math.min(1, (wall - this.lastWall) / 1000) : 0.1;
    this.lastWall = wall;
    this.excitement *= Math.exp(-dt / 5.5);
    if (this.crowd && this.ctx) {
      const level = Math.min(CROWD_PEAK, CROWD_BASE + this.excitement * (CROWD_PEAK - CROWD_BASE));
      this.crowd.gain.setTargetAtTime(level, this.ctx.currentTime, 0.35);
    }
    this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    this.whistleCooldown = Math.max(0, this.whistleCooldown - dt);

    if (Number.isNaN(this.prevT) || t < this.prevT || t - this.prevT > 2.5) {
      // A scrub or a big jump — resynchronise without firing a burst.
      this.pointer = seek(events, this.pointer, t);
      this.prevT = t;
      return;
    }
    if (!playing) {
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

  /** Read a new cue headline aloud (deduplicated by cue id). */
  speak(id: string, text: string): void {
    if (!this.enabled || typeof speechSynthesis === 'undefined' || !text) return;
    if (this.spoken.has(id)) return;
    this.spoken.add(id);
    if (this.spoken.size > 400) this.spoken.clear();
    if (this.speaking) {
      if (this.pending.length >= 2) this.pending.shift();
      this.pending.push(text);
      return;
    }
    this.say(text);
  }

  private say(text: string): void {
    if (typeof speechSynthesis === 'undefined') return;
    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) utterance.voice = this.voice;
    utterance.rate = 1.04;
    utterance.pitch = 0.98;
    utterance.onend = () => {
      this.speaking = false;
      const next = this.pending.shift();
      if (next) this.say(next);
    };
    utterance.onerror = () => {
      this.speaking = false;
    };
    this.speaking = true;
    speechSynthesis.speak(utterance);
  }

  private hit(event: HitEvent): void {
    switch (event.type) {
      case 'pass':
        this.kick(Math.min(1, (event.ballSpeedKph ?? 30) / 80) * 0.35);
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
    filter.frequency.value = 900 + strength * 900;
    filter.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.4 * strength, now + 0.006);
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
      osc.frequency.value = 2350;
      const warble = ctx.createOscillator();
      warble.frequency.value = 24;
      const warbleGain = ctx.createGain();
      warbleGain.gain.value = 60;
      warble.connect(warbleGain);
      warbleGain.connect(osc.frequency);
      const gain = ctx.createGain();
      const duration = count === 3 ? 0.5 : 0.16;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.14, at + 0.02);
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
    filter.frequency.value = 480;
    filter.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 4.2);
    swell.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    swell.start(now, 0, 4.4);
  }

  /** Development probe for the running page. */
  debugState(): { enabled: boolean; state: string | null; excitement: number; voices: number } {
    return {
      enabled: this.enabled,
      state: this.ctx ? this.ctx.state : null,
      excitement: Math.round(this.excitement * 100) / 100,
      voices: typeof speechSynthesis === 'undefined' ? 0 : speechSynthesis.getVoices().length,
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
