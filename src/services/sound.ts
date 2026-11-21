// Synthesized Web Audio API sound effects (zero external assets, works offline)

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

export function playMessageArriveSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;

  // Two-tone crisp notification chime (C6 -> G6)
  const notes = [
    { freq: 1046.5, start: 0, duration: 0.14, peak: 0.14 },
    { freq: 1567.98, start: 0.085, duration: 0.22, peak: 0.12 },
  ];

  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(n.freq, now + n.start);

    gain.gain.setValueAtTime(0.0001, now + n.start);
    gain.gain.exponentialRampToValueAtTime(n.peak, now + n.start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + n.start);
    osc.stop(now + n.start + n.duration + 0.02);
  }
}

export function playCallEndTone(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(480, now);
  osc.frequency.exponentialRampToValueAtTime(280, now + 0.22);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.11, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.28);
}

export function startRingtoneLoop(mode: 'incoming' | 'outgoing'): () => void {
  let stopped = false;

  const playPulse = () => {
    if (stopped) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;

    if (mode === 'incoming') {
      // Pleasant dual-chord ring pulse
      const tones = [
        { freq: 659.25, start: 0, dur: 0.25 },
        { freq: 880, start: 0.28, dur: 0.35 },
      ];
      for (const t of tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(t.freq, now + t.start);
        gain.gain.setValueAtTime(0.0001, now + t.start);
        gain.gain.exponentialRampToValueAtTime(0.12, now + t.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + t.start);
        osc.stop(now + t.start + t.dur + 0.02);
      }
    } else {
      // Subtle outgoing ringback tone
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.05, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.68);
    }
  };

  playPulse();
  const intervalId = window.setInterval(playPulse, mode === 'incoming' ? 2200 : 2800);

  return () => {
    stopped = true;
    window.clearInterval(intervalId);
  };
}
