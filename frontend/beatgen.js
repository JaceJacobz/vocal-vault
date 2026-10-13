const SR = 44100;
function rng(seed) { let a = seed; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const BPM = 92.37, OFF = 0.137, BAR = 4 * 60 / BPM, BEAT = 60 / BPM;
const PROG = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]];          // Am F C G (triads)
const PCS = PROG.map(c => c.map(m => m % 12));
const BASS = [45, 41, 36, 43];

// opts: bars, grooveBar, break:[a,b), outroSilentFrom, drums:{kick,snare,hat}, pad, bass
function makeBeat(o) {
  const n = Math.round((o.bars * BAR + OFF) * SR), L = new Float32Array(n), R = new Float32Array(n), r = rng(5);
  const add = (t, f) => { const i0 = Math.round(t * SR); f(i0); };
  for (let j = 0; j < o.bars; j++) {
    const t0 = OFF + j * BAR, ch = j % 4;
    const silent = o.silentFrom != null && j >= o.silentFrom;
    if (silent) continue;
    if (o.pad) for (const m of PROG[ch]) for (let i = Math.round(t0 * SR); i < Math.min(n, Math.round((t0 + BAR) * SR)); i++) {
      const t = i / SR - t0, e = Math.min(1, t / 0.05, (BAR - t) / 0.05), v = 0.05 * e * (Math.sin(2 * Math.PI * hz(m) * t) + 0.3 * Math.sin(2 * Math.PI * hz(m) * 2 * t));
      L[i] += v; R[i] += v;
    }
    const grooveOn = j >= o.grooveBar && !(o.brk && j >= o.brk[0] && j < o.brk[1]);
    if (!grooveOn) continue;
    if (o.bass) for (const st of [0, 10]) {
      const a = Math.round((t0 + st * BAR / 16) * SR), len = Math.round(0.4 * SR);
      for (let i = 0; i < len && a + i < n; i++) { const t = i / SR, v = 0.22 * Math.exp(-t * 3) * (Math.sin(2 * Math.PI * hz(BASS[ch]) * t) + 0.2 * Math.sin(4 * Math.PI * hz(BASS[ch]) * t)); L[a + i] += v; R[a + i] += v; }
    }
    for (let s = 0; s < 16; s++) {
      const a = Math.round((t0 + s * BAR / 16) * SR);
      if (o.kick && (s === 0 || s === 6 || s === 10)) for (let i = 0; i < 0.3 * SR && a + i < n; i++) { const t = i / SR, v = 0.5 * Math.exp(-t * 10) * Math.sin(2 * Math.PI * (48 + 110 * Math.exp(-t * 25)) * t); L[a + i] += v; R[a + i] += v; }
      if (o.snare && (s === 4 || s === 12)) for (let i = 0; i < 0.2 * SR && a + i < n; i++) { const t = i / SR, v = 0.3 * Math.exp(-t * 18) * ((r() - .5) * 2 * 0.7 + 0.3 * Math.sin(2 * Math.PI * 200 * t)); L[a + i] += v; R[a + i] += v; }
      if (o.hat && s % 2 === 0) for (let i = 0; i < 0.05 * SR && a + i < n; i++) { const t = i / SR, v = 0.12 * Math.exp(-t * 60) * (r() - .5) * 2; L[a + i] += v; R[a + i] += v; }
    }
  }
  return [L, R];
}

module.exports = { makeBeat, SR, BPM, OFF, BAR, BEAT, PROG, PCS, BASS, hz };
