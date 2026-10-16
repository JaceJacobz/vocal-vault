// Run: node test_balance.js     (needs balance.js and studio.js beside it)
const { createStudioEngine } = require("./studio.js");
const { createBalanceEngine } = require("./balance.js");
const studio = createStudioEngine(), B = createBalanceEngine(studio), SR = 44100;
let pass = 0, fail = 0;
const check = (l, ok, x = "") => { ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + l + (x ? "   " + x : "")); };
function rng(s) { let a = s; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dbP = (p) => 10 * Math.log10(Math.max(p, 1e-30));
const band = (x, lo, hi) => studio.runCascade(studio.runCascade(x, [studio.design.highpass(lo, SR), studio.design.highpass(lo, SR)]), [studio.design.lowpass(hi, SR), studio.design.lowpass(hi, SR)]);
const power = (x, a, b) => { let s = 0, c = 0; for (let i = Math.round(a * SR); i < Math.min(x.length, Math.round(b * SR)); i++) { s += x[i] * x[i]; c++; } return s / Math.max(1, c); };

// ---- a beat built from known parts ----
// 0-12 s piano only | 12-24 s drums + bass only | 24-36 s everything. A voice sings throughout.
function build(seconds, pianoAmp, withPiano = true) {
  const n = SR * seconds, r = rng(7);
  const piano = new Float32Array(n), drums = new Float32Array(n), bass = new Float32Array(n), vocal = new Float32Array(n);
  const sections = [[0, 12, 1, 0], [12, 24, 0, 1], [24, 36, 1, 1]];
  const chords = [[262, 330, 392], [220, 262, 330], [196, 247, 294], [175, 220, 262]];
  for (const [a, b, hasP, hasD] of sections) {
    if (hasP && withPiano) for (let t = a, k = 0; t < b; t += 1.5, k++) for (const f0 of chords[k % 4]) for (let i = Math.round(t * SR); i < Math.min(n, Math.round((t + 1.6) * SR)); i++) {
      const tt = i / SR - t; let s = 0; for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * f0 * h * tt) / h;
      piano[i] += pianoAmp * Math.exp(-tt * 1.1) * Math.min(1, tt / 0.004) * s * 0.4;
    }
    if (hasD) {
      const beat = 0.5;
      for (let t = a; t < b; t += beat) {
        for (let i = Math.round(t * SR); i < Math.min(n, Math.round((t + 0.3) * SR)); i++) { const tt = i / SR - t; drums[i] += 0.45 * Math.exp(-tt * 10) * Math.sin(2 * Math.PI * (48 + 110 * Math.exp(-tt * 25)) * tt); }
        if (Math.round((t - a) / beat) % 2 === 1) for (let i = Math.round(t * SR); i < Math.min(n, Math.round((t + 0.2) * SR)); i++) drums[i] += 0.3 * Math.exp(-(i / SR - t) * 18) * (r() * 2 - 1);
        for (const off of [0, 0.25]) for (let i = Math.round((t + off) * SR); i < Math.min(n, Math.round((t + off + 0.05) * SR)); i++) drums[i] += 0.12 * Math.exp(-(i / SR - t - off) * 60) * (r() * 2 - 1);
        for (let i = Math.round(t * SR); i < Math.min(n, Math.round((t + 0.45) * SR)); i++) bass[i] += 0.25 * Math.exp(-(i / SR - t) * 2.5) * Math.sin(2 * Math.PI * 55 * (i / SR - t));
      }
    }
  }
  // the voice: phrases of a voice-like tone, in all three sections
  let ph = 0;
  for (let t = 1; t < seconds - 2; t += 3.2) for (let i = Math.round(t * SR); i < Math.round((t + 2.4) * SR); i++) {
    const tt = i / SR, env = Math.min(1, (i - t * SR) / 900, ((t + 2.4) * SR - i) / 900), f0 = 230 + 40 * Math.sin(tt * 1.7);
    ph += f0 * (1 + 0.008 * Math.sin(2 * Math.PI * 5.5 * tt)) / SR; ph -= Math.floor(ph);
    let s = 0; for (let h = 1; h <= 14; h++) s += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.2);
    vocal[i] += 0.12 * env * s;
  }
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = piano[i] * 1.0 + drums[i] + bass[i]; R[i] = piano[i] * 0.7 + drums[i] * 0.95 + bass[i]; }   // piano a little left of centre
  return { beat: [L, R], vocal, piano, drums };
}

const t = build(36, 0.05);
console.log("1) the piano is buried; Balanced lifts it, and only it");
{
  const t0 = Date.now();
  const res = B.balanceBeat(t.beat, t.vocal, SR, { preset: "balanced" });
  console.log("   " + res.report[0]); console.log("   time " + (Date.now() - t0) + " ms for 36 s");
  const i = res.info;
  console.log(`   measured: tonal instruments sit ${i.melodicGapDb.toFixed(1)} dB under the voice -> lift ${i.melodicBoostDb.toFixed(1)} dB (target gap ${i.targetGapDb} dB, limit 4.5)`);
  check("it found the piano buried and lifted it", res.applied && i.melodicBoostDb > 2, i.melodicBoostDb.toFixed(1) + " dB");
  const out = res.channels, L0 = t.beat[0];
  const mid = (x, a, b) => dbP(power(band(x, 300, 4000), a, b));
  // piano-only section, while the voice is on (voice phrases at 1-3.4, 4.2-6.6 ...)
  const pA = [1.2, 3.2], dA = mid(out[0], 1.2, 3.2) - mid(L0, 1.2, 3.2);
  console.log(`   piano-only + voice: beat's 300 Hz-4 kHz changed by ${dA.toFixed(1)} dB`);
  check("the piano section is lifted by about the measured amount (within 1.2 dB)", Math.abs(dA - i.melodicBoostDb) < 1.2, dA.toFixed(1) + " vs " + i.melodicBoostDb.toFixed(1));
  // distance under the voice, in a window where only the piano plays: before and after (ground truth)
  const ev = dbP(power(band(t.vocal, 300, 4000), 1.2, 3.2));
  const gapBefore = ev - mid(L0, 1.2, 3.2), gapAfter = ev - mid(out[0], 1.2, 3.2);
  console.log(`   piano-vs-voice gap in that window: ${gapBefore.toFixed(1)} dB before, ${gapAfter.toFixed(1)} dB after`);
  check("the piano now sits closer under the voice (gap shrinks by about the lift)", gapBefore - gapAfter > 2 && Math.abs((gapBefore - gapAfter) - i.melodicBoostDb) < 1.2);
  check("it is not pushed past the voice (still at least 3 dB under)", gapAfter > 3, gapAfter.toFixed(1) + " dB under");
  // drums-and-bass-only section: unchanged where the piano would be
  const dB_ = mid(out[0], 13, 22) - mid(L0, 13, 22);
  check("drums-only section: the 300 Hz-4 kHz range barely changes (< 1.3 dB)", Math.abs(dB_) < 1.3, dB_.toFixed(2) + " dB");
  // kick and bass untouched everywhere
  const low = (x, a, b) => dbP(power(band(x, 30, 110), a, b));
  const lowChange = [[13, 22], [25, 34]].map(([a, b]) => low(out[0], a, b) - low(L0, a, b));   // the sections that have a kick and bass (the piano-only one has none: only filter leakage there)
  check("kick and bass untouched (< 0.2 dB) in the sections that have them", lowChange.every(v => Math.abs(v) < 0.2), lowChange.map(v => v.toFixed(2)).join(" / "));
  // highs above 8k untouched
  const hi = [[13, 22], [25, 34]].map(([a, b]) => dbP(power(band(out[0], 12000, 18000), a, b)) - dbP(power(band(L0, 12000, 18000), a, b)));
  check("the top end (12-18 kHz) is untouched (< 0.2 dB) where there is content up there", hi.every(v => Math.abs(v) < 0.2), hi.map(v => v.toFixed(2)).join(" / "));
  // gaps (no voice): the lift is smaller than during the voice, never zero (follow = 50%)
  const gapWin = [3.5, 4.1], gapChange = mid(out[0], gapWin[0], gapWin[1]) - mid(L0, gapWin[0], gapWin[1]);
  console.log(`   in a gap between phrases (no voice): +${gapChange.toFixed(1)} dB (during the voice +${dA.toFixed(1)} dB)`);
  check("in the gaps the lift is smaller than under the voice (no pumping)", gapChange < dA - 0.4 && gapChange > -0.3, gapChange.toFixed(1) + " dB");
  // stereo image preserved
  const sd = (ch, a, b) => { const m = new Float32Array(ch[0].length); for (let i = 0; i < m.length; i++) m[i] = (ch[0][i] - ch[1][i]) * 0.5; return dbP(power(band(m, 300, 4000), a, b)) - dbP(power(band([0].length ? new Float32Array(ch[0].map((v, i) => (v + ch[1][i]) * 0.5)) : ch[0], 300, 4000), a, b)); };
  const bal0 = sd(t.beat, 1.2, 11), bal1 = sd(out, 1.2, 11);
  check("stereo image preserved (side-to-mid ratio within 0.6 dB)", Math.abs(bal1 - bal0) < 0.6, (bal1 - bal0).toFixed(2) + " dB");
  let pk0 = 0, pk1 = 0, bad = 0; for (let k = 0; k < L0.length; k++) { pk0 = Math.max(pk0, Math.abs(L0[k])); pk1 = Math.max(pk1, Math.abs(out[0][k])); if (!Number.isFinite(out[0][k])) bad++; }
  check("finite, and the peak grows by less than the lift", bad === 0 && pk1 <= pk0 * Math.pow(10, 5 / 20), `${(20 * Math.log10(pk1 / pk0)).toFixed(1)} dB`);
}

console.log("2) the presets, and doing nothing when nothing is needed");
{
  const a = B.balanceBeat(t.beat, t.vocal, SR, { preset: "subtle" }), b = B.balanceBeat(t.beat, t.vocal, SR, { preset: "balanced" }), c = B.balanceBeat(t.beat, t.vocal, SR, { preset: "full" });
  console.log(`   lift: Subtle ${a.info.melodicBoostDb.toFixed(1)} dB, Balanced ${b.info.melodicBoostDb.toFixed(1)} dB, Full ${c.info.melodicBoostDb.toFixed(1)} dB`);
  check("Subtle < Balanced < Full", a.info.melodicBoostDb < b.info.melodicBoostDb && b.info.melodicBoostDb < c.info.melodicBoostDb);
  check("each stays within its limit (3 / 4.5 / 6 dB)", a.info.melodicBoostDb <= 3.001 && b.info.melodicBoostDb <= 4.501 && c.info.melodicBoostDb <= 6.001);
  const off = B.balanceBeat(t.beat, t.vocal, SR, { preset: "off" });
  check("Off returns the beat untouched", !off.applied && off.channels === t.beat);
  const loud = build(36, 0.35), l = B.balanceBeat(loud.beat, loud.vocal, SR, { preset: "balanced" });
  console.log("   a beat whose piano is already loud:", l.report[0].slice(0, 120));
  check("a beat whose instruments are already audible is left alone", !l.applied && l.channels === loud.beat, l.info.melodicGapDb.toFixed(1) + " dB under the voice");
  const noP = build(36, 0.05, false), n2 = B.balanceBeat(noP.beat, noP.vocal, SR, { preset: "balanced" });
  console.log("   a beat with drums and bass only:", n2.report.length ? n2.report[0].slice(0, 130) : "(none)");
  const noV = B.balanceBeat(t.beat, new Float32Array(SR * 5), SR, { preset: "balanced" });
  check("no singing -> nothing done, says why", !noV.applied && /not enough singing|skipped/.test(noV.report[0]));
}

console.log("3) the transform itself adds no artifacts");
{
  const res = B.balanceBeat(t.beat, t.vocal, SR, { custom: { gapDb: 8, maxDb: 0.0005 }, minLiftDb: 0 });   // tiny lift: the output must be the input within a whisker
  let e = 0, s = 0; for (let i = 0; i < t.beat[0].length; i++) { e += (res.channels[0][i] - t.beat[0][i]) ** 2; s += t.beat[0][i] ** 2; }
  const snr = 10 * Math.log10(s / Math.max(e, 1e-30));
  console.log(`   applied: ${res.applied}; a 0.0005 dB lift changes the audio by ${(-snr).toFixed(0)} dB relative to the signal (a perfect transform would show about -84 dB)`);
  check("the transform really ran, and adds nothing beyond the tiny lift itself (error <= -75 dB)", res.applied && snr > 75, snr.toFixed(0) + " dB");
}

console.log("4) speed");
{
  const big = build(36, 0.05); const stretch = (x) => { const o = new Float32Array(x.length * 5); for (let k = 0; k < 5; k++) o.set(x, k * x.length); return o; };
  const beat = big.beat.map(stretch), voc = stretch(big.vocal);                 // 3 minutes
  const t0 = Date.now(); B.balanceBeat(beat, voc, SR, { preset: "balanced" }); const ms = Date.now() - t0;
  check(`a 3-minute stereo beat is balanced in under 15 s`, ms < 15000, ms + " ms");
}
console.log("5) together with the existing dip of the beat's mids while you sing");
{
  const { createFxPlusEngine } = require("./fxplus.js"), Fx = createFxPlusEngine(studio);
  const dip = Fx.duckBeatMid(t.beat, t.vocal, SR, { depthDb: 2.3 });                 // what the chain already does
  const res = B.balanceBeat(dip.channels, t.vocal, SR, { preset: "balanced" });      // measured on the dipped beat, as in the chain
  const mid = (x, a, b) => dbP(power(band(x, 300, 4000), a, b)), ev = dbP(power(band(t.vocal, 300, 4000), 1.2, 3.2));
  const g0 = ev - mid(t.beat[0], 1.2, 3.2), g1 = ev - mid(dip.channels[0], 1.2, 3.2), g2 = ev - mid(res.channels[0], 1.2, 3.2);
  console.log(`   piano under the voice: untouched beat ${g0.toFixed(1)} dB, after the mid dip ${g1.toFixed(1)} dB, after the balance ${g2.toFixed(1)} dB`);
  check("the dip buries the piano a little more; the balance more than wins it back", g1 > g0 && g2 < g0 - 2, `${g0.toFixed(1)} -> ${g1.toFixed(1)} -> ${g2.toFixed(1)}`);
  check("the balance measured the dipped beat (so it compensates for the dip)", res.info.melodicGapDb > 12);
}

console.log("6) registers itself on the page");
{
  const vm = require("vm"), fs = require("fs"), win = { VocalVaultStudio: { engine: studio } };
  win.window = win; vm.runInContext(fs.readFileSync(__dirname + "/balance.js", "utf8"), vm.createContext({ window: win, Math, Float32Array, Float64Array, Uint8Array, Object, module: undefined, console }));
  check("window.VocalVaultBalance.balanceBeat exists with the three presets", typeof win.VocalVaultBalance.balanceBeat === "function" && Object.keys(win.VocalVaultBalance.PRESETS).join() === "subtle,balanced,full");
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
