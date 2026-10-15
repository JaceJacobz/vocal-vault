// Run: node test_gate.js     (needs studio.js beside it)
// The phrase gate must never chop a quiet vocal. "Break points" in a smooth vocal = a gate flickering open and shut on SUNG material.
const { createStudioEngine } = require("./studio.js");
const E = createStudioEngine(), SR = 44100;
let pass = 0, fail = 0;
const check = (l, ok, x = "") => { ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + l + (x ? "   " + x : "")); };
const dbOf = (v) => 20 * Math.log10(Math.max(v, 1e-12));
function rng(seed) { let a = seed; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// A sung vocal with real phrasing: notes, vibrato, tremolo, fade-outs at phrase ends, breaths between phrases, a room noise floor.
function makeTake(seconds, seed, peakDb, noiseDb) {
  const r = rng(seed), n = SR * seconds, x = new Float32Array(n), phrases = []; let t = 0.5, ph = 0;
  while (t < seconds - 4) { const d = 2.2 + r() * 2.2; phrases.push([t, t + d]); t += d + 0.7 + r() * 0.5; }
  for (const [a, b] of phrases) {
    let nt = a;
    while (nt < b - 0.2) {
      const nd = Math.min(b - nt, 0.35 + r() * 0.8), f0 = 150 * Math.pow(2, Math.floor(r() * 8) / 12 * 1.5);
      for (let i = Math.floor(nt * SR); i < Math.floor((nt + nd) * SR); i++) {
        const tt = i / SR - nt, pos = (i / SR - a) / (b - a);
        const phrase = Math.pow(10, (-12 * pos * pos - 2 * Math.sin(pos * Math.PI * 2.3)) / 20), trem = Math.pow(10, 1.5 * Math.sin(2 * Math.PI * 5.5 * tt) / 20);
        const e = Math.min(1, tt / 0.03, (nd - tt) / 0.05) * phrase * trem;
        ph += f0 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * tt)) / SR; ph -= Math.floor(ph);
        let s = 0; for (let h = 1; h <= 30 && h * f0 < 8000; h++) s += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.4);
        x[i] = e * s;
      }
      nt += nd;
    }
  }
  for (let k = 0; k < phrases.length - 1; k++) { const a = Math.floor(phrases[k][1] * SR), b = Math.floor(phrases[k + 1][0] * SR); for (let i = a; i < b; i++) x[i] += 0.05 * Math.sin(Math.PI * (i - a) / (b - a)) * (r() - 0.5) * 2; }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]));
  const g = Math.pow(10, peakDb / 20) / pk, ng = Math.pow(10, noiseDb / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) x[i] = x[i] * g + ng * (r() * 2 - 1);
  return { x, phrases };
}
const hop = Math.round(0.01 * SR);
const lvl = (x, a, b) => { let s = 0, c = 0; for (let i = Math.round(a * SR); i < Math.min(x.length, Math.round(b * SR)); i++) { s += x[i] * x[i]; c++; } return dbOf(Math.sqrt(s / Math.max(1, c))); };
function gateEffect(take) {   // gate on vs off, on SUNG material only
  const on = E.prepareVocal([take.x], SR, { highPassHz: 85 }), off = E.prepareVocal([take.x], SR, { highPassHz: 85, gate: false });
  let sung = 0, ducked = 0, flips = 0, was = false, startWorst = 0;
  for (const [a, b] of take.phrases) {
    was = false;
    for (let f = Math.ceil((a + 0.08) / 0.01); f < Math.floor((b - 0.08) / 0.01); f++) {
      sung++; const g = lvl(on.channels[0], f * 0.01, f * 0.01 + 0.01) - lvl(off.channels[0], f * 0.01, f * 0.01 + 0.01);
      if (g < -1) ducked++; const closed = g < -2.5; if (closed !== was) { flips++; was = closed; }
    }
    startWorst = Math.min(startWorst, lvl(on.channels[0], a, a + 0.03) - lvl(off.channels[0], a, a + 0.03));
  }
  return { duckedPct: 100 * ducked / sung, flipsPerMin: flips / (take.x.length / SR / 60), startWorst, on, off };
}

console.log("1) a gate must never chop singing, at any recording level");
for (const [p, n] of [[-6, -62], [-18, -62], [-30, -62], [-30, -58], [-36, -58], [-40, -58], [-30, -52], [-45, -60]]) {
  const take = makeTake(30, 5, p, n), r = gateEffect(take);
  check(`peak ${p} dBFS / room ${n} dBFS: sung frames ducked <= 0.5%, flips <= 5/min, starts not clipped`, r.duckedPct <= 0.5 && r.flipsPerMin <= 5 && r.startWorst > -0.3,
    `ducked ${r.duckedPct.toFixed(1)}%, ${r.flipsPerMin.toFixed(0)} flips/min, start ${r.startWorst.toFixed(2)} dB`);
}
console.log("2) on a clean take it still cleans the gaps");
{
  const take = makeTake(30, 7, -6, -85), r = gateEffect(take);
  let before = 0, after = 0, c = 0;
  for (let k = 0; k < take.phrases.length - 1; k++) { const a = take.phrases[k][1] + 0.45, b = take.phrases[k + 1][0] - 0.1; if (b - a < 0.15) continue; before += Math.pow(10, lvl(r.off.channels[0], a, b) / 10); after += Math.pow(10, lvl(r.on.channels[0], a, b) / 10); c++; }
  const drop = 10 * Math.log10(before / c) - 10 * Math.log10(after / c);
  check("gaps drop by >= 5 dB (clean recording)", drop >= 5, drop.toFixed(1) + " dB");
  check("report says what it did", r.on.report.some(l => /Quieted gaps/.test(l)));
}
console.log("3) close to the noise it backs off instead of chopping, and says so");
{
  const take = makeTake(30, 5, -40, -58), r = gateEffect(take);
  check("gate skipped on a take only ~18 dB above the room", r.on.report.some(l => /close to the room noise/.test(l)), r.on.report.filter(l => /gap/i.test(l))[0]);
}
console.log("4) edge cases");
{
  const noise = new Float32Array(SR * 6).map(() => 0.001 * (Math.random() - 0.5));
  let ok = true; try { E.prepareVocal([noise], SR, { highPassHz: 85 }); } catch (e) { ok = false; }
  check("a take with no singing at all does not crash", ok);
  let ok2 = true; try { E.prepareVocal([new Float32Array(SR / 2)], SR, { highPassHz: 85 }); } catch (e) { ok2 = false; }
  check("a half-second clip does not crash", ok2);
  const t = makeTake(20, 3, -20, -62), st = E.prepareVocal([t.x, t.x.map(v => v * 0.8)], SR, { highPassHz: 85 });
  let maxDiff = 0; for (let i = 0; i < st.channels[0].length; i += 997) maxDiff = Math.max(maxDiff, Math.abs(st.channels[0][i] / 1 - st.channels[1][i] / 0.8));
  check("stereo: both channels get the same gain (image does not shift)", maxDiff < 0.02 * Math.max(...st.channels[0].map(Math.abs).slice(0, 5000)) + 0.05, "max diff " + maxDiff.toExponential(1));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
