const { createTuneEngine } = require("./pitchcorrect.js");
const OldEngine = require("./pitchcorrect_old.js").createTuneEngine;
const SR = 44100, E = createTuneEngine();
let pass = 0, fail = 0;
const check = (l, ok, x = "") => { ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + l + (x ? "   " + x : "")); };
function rng(seed) { let a = seed; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// A singer in B minor. opts: err (max +- cents off), vib (cents, 0 = straight), scoop (cents), droop (cents), wander (cents)
function makeSinger(seconds, seed, p) {
  const r = rng(seed), n = Math.floor(seconds * SR), x = new Float32Array(n);
  const pool = []; for (let m = 59; m <= 70; m++) if ([11, 1, 2, 4, 6, 7, 9].includes(m % 12)) pool.push(m);
  const notes = []; let t = 0.3, prev = 62;
  while (t < seconds - 1.4) {
    let m; do { m = pool[Math.floor(r() * pool.length)]; } while (Math.abs(m - prev) > 5 && r() < 0.8);
    const dur = r() < 0.45 ? 0.9 + r() * 0.5 : 0.3 + r() * 0.35;          // some held notes, some short
    notes.push({ t0: t, t1: t + dur, midi: m, err: (r() * 2 - 1) * p.err, wph: r() * 6.28 });
    prev = m; t += dur + 0.08 + r() * 0.1;
  }
  const f0 = new Float64Array(n), amp = new Float32Array(n);
  for (const nt of notes) for (let i = Math.floor(nt.t0 * SR); i < Math.floor(nt.t1 * SR) && i < n; i++) {
    const tt = i / SR - nt.t0, dur = nt.t1 - nt.t0, tEnd = dur - tt;
    const scoop = tt < 0.12 ? -p.scoop * (1 - tt / 0.12) : 0, droop = tEnd < 0.12 ? -p.droop * (1 - tEnd / 0.12) : 0;
    const vib = p.vib && tt > 0.2 ? p.vib * Math.sin(2 * Math.PI * 5.6 * (tt - 0.2)) * Math.min(1, (tt - 0.2) / 0.2) : 0;
    const wander = p.wander * Math.sin(2 * Math.PI * 1.3 * tt + nt.wph);
    f0[i] = 440 * Math.pow(2, (nt.midi - 69) / 12) * Math.pow(2, (nt.err + scoop + droop + vib + wander) / 1200);
    amp[i] = Math.min(1, tt / 0.03, tEnd / 0.05);
  }
  const src = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    if (!f0[i]) continue; ph += f0[i] / SR; ph -= Math.floor(ph);
    let s = 0; for (let h = 1; h <= Math.floor(5000 / f0[i]); h++) s += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.6);
    src[i] = s * amp[i];
  }
  let y = src;
  for (const [fc, bw] of [[700, 90], [1150, 100], [2600, 140]]) {
    const rr = Math.exp(-Math.PI * bw / SR), th = 2 * Math.PI * fc / SR, a1 = -2 * rr * Math.cos(th), a2 = rr * rr, g = 1 - rr;
    const o = new Float32Array(n); let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) { const v = g * y[i] - a1 * y1 - a2 * y2; o[i] = v; y2 = y1; y1 = v; } y = o;
  }
  let pk = 0; for (let i = 0; i < n; i++) { y[i] += (r() - .5) * 0.0008; pk = Math.max(pk, Math.abs(y[i])); }
  for (let i = 0; i < n; i++) y[i] *= 0.7 / pk;
  return { x: y, notes };
}

const opt = { rootPc: 11, scale: "minor", refCents: 0 };
const track = (x) => E.trackClean(x, SR);
const hopSec = 64 * Math.max(1, Math.round(SR / 11025)) / SR;

// ---- measurements on a pitch contour ----
function longNotes(contour) { return E.segmentNotes(contour).filter(nt => (nt.end - nt.start) * hopSec >= 0.7); }
function vibratoFrac(contour) {                          // share of held notes with a real 4-7 Hz wobble >= ~9 cents peak
  const ln = longNotes(contour); let has = 0;
  for (const nt of ln) {
    const a = nt.start + Math.round(0.25 / hopSec), b = nt.end - Math.round(0.1 / hopSec); if (b - a < 20) continue;
    const m = Array.from(contour.slice(a, b)); const W = Math.round(0.25 / hopSec) | 1;
    const dev = m.map((v, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - (W >> 1)); j <= Math.min(m.length - 1, i + (W >> 1)); j++) if (!isNaN(m[j])) { s += m[j]; c++; } return (v - s / c) * 100; });
    const std = Math.sqrt(dev.reduce((s, v) => s + v * v, 0) / dev.length) * Math.SQRT2;
    let cr = 0, sg = 0; for (const v of dev) { const q = v > 2.5 ? 1 : (v < -2.5 ? -1 : 0); if (q && q !== sg) { if (sg) cr++; sg = q; } }
    const rate = cr / (2 * dev.length * hopSec);
    if (std >= 9 && rate >= 3.5 && rate <= 8) has++;
  }
  return { has, total: ln.length };
}
function onsetErr(contour, target) {                      // mean |pitch - nearest scale note| in the first 100 ms of notes
  const mask = E.scaleMask(11, "minor"), notes = E.segmentNotes(contour); let s = 0, c = 0;
  for (const nt of notes) {
    if ((nt.end - nt.start) * hopSec < 0.25) continue;
    const tgt = E.nearestNote(nt.center, 11, mask, false);
    for (let k = nt.start + 2; k < nt.start + Math.round(0.1 / hopSec) && k < nt.end; k++) if (!isNaN(contour[k])) { s += Math.abs(contour[k] - tgt) * 100; c++; }
  }
  return s / c;
}
function maxJump(contour) {                               // biggest frame-to-frame pitch step inside voiced runs (cents)
  let mx = 0; for (let k = 1; k < contour.length; k++) if (!isNaN(contour[k]) && !isNaN(contour[k - 1])) mx = Math.max(mx, Math.abs(contour[k] - contour[k - 1]) * 100);
  return mx;
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

// ================= A. a raw singer =================
console.log("A) raw singer: +-45c off, straight tone, scoops up into notes, sags at the ends");
const raw = makeSinger(26, 11, { err: 45, vib: 0, scoop: 80, droop: 25, wander: 10 });
const t0 = Date.now();
const rNat = E.process([raw.x], SR, Object.assign({ strength: 1, flatten: 0.4, retuneMs: 30 }, opt));
console.log("   time", Date.now() - t0, "ms");
const rOff = E.process([raw.x], SR, Object.assign({ strength: 1, flatten: 0.4, retuneMs: 30, natural: false, adaptive: false }, opt));
const a = rNat.adaptive;
console.log(`   rawness ${a.rawness.toFixed(2)} (within 25c: ${a.within25Pct.toFixed(0)}%, in key: ${a.inKeyPct.toFixed(0)}%) -> selective threshold ${a.selectiveCents.toFixed(0)}c, flatten ${(a.flatten * 100).toFixed(0)}%`);
console.log("   feel:", JSON.stringify(rNat.natural));
const fmt = (s) => `within25c ${s.within25Pct.toFixed(0)}%  within50c ${s.within50Pct.toFixed(0)}%  median ${s.medianCents.toFixed(1)}c  inKey ${s.inKeyPct.toFixed(0)}%`;
console.log("   original        :", fmt(rNat.stats.original));
console.log("   old tuner       :", fmt(rOff.stats.tuned));
console.log("   new tuner       :", fmt(rNat.stats.tuned));
check("detected as a raw take", a.rawness > 0.5, a.rawness.toFixed(2));
check("new tuner is at least as accurate as the old one (within 25c)", rNat.stats.tuned.within25Pct >= rOff.stats.tuned.within25Pct - 1, `${rNat.stats.tuned.within25Pct.toFixed(0)} vs ${rOff.stats.tuned.within25Pct.toFixed(0)}`);
check("most of the singing lands within 25 cents of a note (>= 80%)", rNat.stats.tuned.within25Pct >= 80, rNat.stats.tuned.within25Pct.toFixed(0) + "%");
const vOrig = vibratoFrac(rNat.contours.original), vOld = vibratoFrac(rOff.contours.tuned), vNew = vibratoFrac(rNat.contours.tuned);
console.log(`   held notes with vibrato: original ${vOrig.has}/${vOrig.total}, old tuner ${vOld.has}/${vOld.total}, new tuner ${vNew.has}/${vNew.total}`);
check("straight held notes now have vibrato (>= 60%)", vNew.total >= 5 && vNew.has / vNew.total >= 0.6, `${vNew.has}/${vNew.total}`);
const oOrig = onsetErr(rNat.contours.original), oOld = onsetErr(rOff.contours.tuned), oNew = onsetErr(rNat.contours.tuned);
console.log(`   pitch error in the first 100 ms of held notes: original ${oOrig.toFixed(0)}c, old tuner ${oOld.toFixed(0)}c, new tuner ${oNew.toFixed(0)}c`);
check("notes are reached sooner (onset error lower than the old tuner)", oNew < oOld - 3, `${oNew.toFixed(0)} vs ${oOld.toFixed(0)}`);
const jOrig = maxJump(rNat.contours.original), jNew = maxJump(rNat.contours.tuned);
console.log(`   biggest pitch step between frames: original ${jOrig.toFixed(0)}c, new tuner ${jNew.toFixed(0)}c`);
check("no robotic steps: correction adds no abrupt jumps (<= original + 15c)", jNew <= jOrig + 15);
// not flat: pitch inside held notes still moves (a dead-flat line is what sounds robotic)
{
  const stds = longNotes(rNat.contours.tuned).map(nt => { const v = Array.from(rNat.contours.tuned.slice(nt.start + 10, nt.end - 6)).filter(x => !isNaN(x)); const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) * 100; });
  check("held notes are alive, not dead flat (median wobble >= 6 cents)", med(stds) >= 6, med(stds).toFixed(1) + " cents");
}
// audio sanity
{ let e0 = 0, e1 = 0, bad = 0; const y = rNat.audio.tuned[0]; for (let i = 0; i < y.length; i++) { e0 += raw.x[i] ** 2; e1 += y[i] ** 2; if (!(Math.abs(y[i]) < 2)) bad++; }
  check("audio level preserved (within 1.5 dB) and finite", bad === 0 && Math.abs(10 * Math.log10(e1 / e0)) < 1.5, (10 * Math.log10(e1 / e0)).toFixed(2) + " dB"); }

// ================= B. a good singer with natural vibrato is left alone =================
console.log("B) a good singer (+-8c, natural vibrato) must stay natural");
const good = makeSinger(26, 21, { err: 8, vib: 22, scoop: 25, droop: 8, wander: 3 });
const gNat = E.process([good.x], SR, Object.assign({ strength: 1, flatten: 0.4 }, opt));
console.log(`   rawness ${gNat.adaptive.rawness.toFixed(2)}; feel: ${JSON.stringify(gNat.natural)}`);
check("recognised as NOT raw", gNat.adaptive.rawness < 0.35, gNat.adaptive.rawness.toFixed(2));
check("no vibrato added on top of the singer's own", gNat.natural.vibratoAdded === 0, "added " + gNat.natural.vibratoAdded + ", kept " + gNat.natural.vibratoKept);
{
  const oc = gNat.contours.original, tc = gNat.contours.tuned; const d = [];
  for (const nt of E.segmentNotes(oc)) { const v1 = [], v2 = []; for (let k = nt.start + 6; k < nt.end - 4; k++) if (!isNaN(oc[k]) && !isNaN(tc[k])) { v1.push(oc[k]); v2.push(tc[k]); } if (v1.length > 8) d.push(Math.abs(med(v2) - med(v1)) * 100); }
  check("good notes barely move (median change <= 12 cents)", med(d) <= 12, med(d).toFixed(1) + " cents");
}

// ================= C. switches =================
console.log("C) switches");
{
  const o1 = new OldEngine().process([raw.x], SR, Object.assign({ strength: 1, flatten: 0.4, retuneMs: 30 }, opt));
  const o2 = rOff;
  let same = o1.audio.tuned[0].length === o2.audio.tuned[0].length;
  for (let i = 0; same && i < o1.audio.tuned[0].length; i++) if (o1.audio.tuned[0][i] !== o2.audio.tuned[0][i]) same = false;
  check("natural:false + adaptive:false reproduces the old tuner exactly", same);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
