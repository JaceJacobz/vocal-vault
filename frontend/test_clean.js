const { createStudioEngine } = require("./studio.js");
const E = createStudioEngine(), SR = 44100;
let pass = 0, fail = 0;
const check = (l, ok, x = "") => { ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + l + (x ? "   " + x : "")); };
function rng(seed) { let a = seed; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rms = (x, a, b) => { let s = 0, c = 0; for (let i = Math.round(a * SR); i < Math.min(x.length, Math.round(b * SR)); i++) { s += x[i] * x[i]; c++; } return Math.sqrt(s / c); };
const db = (v) => 20 * Math.log10(v + 1e-12);
const band = (x, lo, hi) => E.runCascade(E.runCascade(x, [E.design.highpass(lo, SR), E.design.highpass(lo, SR)]), [E.design.lowpass(hi, SR), E.design.lowpass(hi, SR)]);

// voice-like: gliding pitch (so harmonics average out), formant-ish tilt
function voice(seconds, seed) {
  const r = rng(seed), n = SR * seconds, x = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, note = Math.floor(t / 0.7), tn = t - note * 0.7;
    const f0 = 130 * Math.pow(2, ((note * 7 + 3) % 12) / 12) * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
    const env = Math.min(1, tn / 0.04, (0.66 - tn) / 0.05); if (env <= 0) continue;
    ph += f0 / SR; ph -= Math.floor(ph);
    let s = 0; for (let h = 1; h <= 40 && h * f0 < 9000; h++) s += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.3);
    x[i] = 0.3 * env * s;
  }
  for (let i = 0; i < n; i++) x[i] += 0.0006 * (r() - 0.5);
  return x;
}
// ---- A. resonance control ----
console.log("A) resonance control");
{
  const clean = voice(20, 1);
  const ringing = E.runCascade(clean, [E.design.peaking(3150, 9, 9, SR), E.design.peaking(1750, 7, 8, SR)]);
  const rc = E.deResonate([clean], SR);
  check("clean take: nothing found, untouched", !rc.applied && rc.channels[0] === clean, JSON.stringify(rc.bands));
  const t0 = Date.now(), rr = E.deResonate([ringing], SR);
  console.log("   found:", JSON.stringify(rr.bands), (Date.now() - t0) + " ms");
  check("finds the 3.15 kHz ring", rr.bands.some(b => Math.abs(b.hz - 3150) < 160));
  check("finds the 1.75 kHz ring", rr.bands.some(b => Math.abs(b.hz - 1750) < 90));
  const y = rr.channels[0];
  const d = (lo, hi) => db(rms(band(y, lo, hi), 1, 19)) - db(rms(band(ringing, lo, hi), 1, 19));
  const dRing = d(3050, 3250), dBox = d(1690, 1810), dOther = d(900, 1400), dOther2 = d(5000, 8000), dLow = d(150, 600);
  check("3.15 kHz ring reduced >= 1 dB (gentle by design)", dRing <= -1, dRing.toFixed(1) + " dB");
  check("1.75 kHz ring reduced >= 0.8 dB", dBox <= -0.8, dBox.toFixed(1) + " dB");
  check("rest of the voice barely touched (<= 0.6 dB)", Math.abs(dOther) < 0.6 && Math.abs(dOther2) < 0.6 && Math.abs(dLow) < 0.6, [dOther, dOther2, dLow].map(v => v.toFixed(2)).join(" / "));
  const p = E.prepareVocal([ringing], SR, {});
  check("prepareVocal reports it", p.report.some(l => /ringing/.test(l)), p.report.filter(l => /ringing/.test(l))[0]);
}
// ---- B. low end ----
console.log("B) clean low end");
{
  const n = SR * 6, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const rumble = 0.25 * Math.sin(2 * Math.PI * 12 * t);
    const bassW = 0.3 * Math.sin(2 * Math.PI * 55 * t), bassSide = 0.12 * Math.sin(2 * Math.PI * 70 * t + 0.4);
    const hi = 0.1 * Math.sin(2 * Math.PI * 440 * t), hiSide = 0.08 * Math.sin(2 * Math.PI * 1500 * t);
    L[i] = rumble + bassW + bassSide + hi + hiSide; R[i] = rumble + bassW - bassSide + hi - hiSide;
  }
  const res = E.tidyLowEnd([L, R], SR);
  res.report.forEach(l => console.log("   > " + l));
  const [l2, r2] = res.channels;
  const side = (a, b, lo, hi) => { const s = new Float32Array(a.length); for (let i = 0; i < a.length; i++) s[i] = 0.5 * (a[i] - b[i]); return rms(band(s, lo, hi), 1, 5); };
  const mid = (a, b, lo, hi) => { const s = new Float32Array(a.length); for (let i = 0; i < a.length; i++) s[i] = 0.5 * (a[i] + b[i]); return rms(band(s, lo, hi), 1, 5); };
  check("12 Hz rumble removed (>= 20 dB)", db(rms(band(L, 8, 16), 1, 5)) - db(rms(band(l2, 8, 16), 1, 5)) >= 20);
  check("55 Hz centre bass unchanged (< 0.5 dB)", Math.abs(db(mid(l2, r2, 45, 65)) - db(mid(L, R, 45, 65))) < 0.5);
  check("wide 70 Hz bass pulled to centre (side down >= 12 dB)", db(side(L, R, 60, 80)) - db(side(l2, r2, 60, 80)) >= 12, (db(side(L, R, 60, 80)) - db(side(l2, r2, 60, 80))).toFixed(1) + " dB");
  check("stereo width above 110 Hz untouched (< 0.5 dB)", Math.abs(db(side(l2, r2, 1300, 1700)) - db(side(L, R, 1300, 1700))) < 0.5);
  check("440 Hz centre content unchanged (< 0.3 dB)", Math.abs(db(mid(l2, r2, 400, 480)) - db(mid(L, R, 400, 480))) < 0.3);
  // out-of-phase bass must NOT be folded to mono (it would vanish)
  const L2 = new Float32Array(n), R2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = 0.3 * Math.sin(2 * Math.PI * 60 * i / SR); L2[i] = v; R2[i] = -v; }
  const oop = E.tidyLowEnd([L2, R2], SR);
  check("out-of-phase bass is left alone and reported", oop.report.some(l => /out of phase/.test(l)) && db(rms(band(oop.channels[0], 50, 70), 1, 5)) > db(rms(band(L2, 50, 70), 1, 5)) - 0.5);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
