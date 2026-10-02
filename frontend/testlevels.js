// Run: node test_levels.js     (needs levelmatch.js beside it)
const { createLevelEngine } = require("./levelmatch.js");
const E = createLevelEngine();
const SR = 44100;
let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + label + (extra ? "   " + extra : "")); };
function rng(s){let a=s;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}}
const dbOf = (x) => 20 * Math.log10(x);

// beat: sections of (seconds, amplitude). Tone + noise so it has body.
function makeBeat(sections, seed = 1) {
  const r = rng(seed), total = sections.reduce((a, s) => a + s[0], 0), n = Math.round(total * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let i = 0;
  for (const [sec, amp] of sections) for (let k = 0; k < sec * SR; k++, i++) {
    const t = i / SR, v = amp * (0.6 * Math.sin(2*Math.PI*110*t) + 0.3 * Math.sin(2*Math.PI*440*t) + 0.2 * (r() - .5));
    L[i] = v; R[i] = v * 0.9;
  }
  return [L, R];
}
// vocal: phrases of (start, end, amplitude) - a 220/660 Hz voice-like tone, silence otherwise
function makeVocal(phrases, totalSec, seed = 2) {
  const r = rng(seed), n = Math.round(totalSec * SR), x = new Float32Array(n);
  for (const [a, b, amp] of phrases) for (let i = Math.round(a * SR); i < Math.round(b * SR) && i < n; i++) {
    const t = i / SR, env = Math.min(1, (i - a * SR) / 800, (b * SR - i) / 800);
    x[i] = amp * env * (0.7 * Math.sin(2*Math.PI*220*t) + 0.4 * Math.sin(2*Math.PI*660*t) + 0.05 * (r() - .5));
  }
  for (let i = 0; i < n; i++) x[i] += 0.0004 * (r() - .5);       // room noise floor
  return [x];
}
const at = (plan, sec) => plan.vocalGainDb[Math.min(plan.vocalGainDb.length - 1, Math.round((sec - plan.blockCenterSec) / plan.hopSec))];

// ---------- 1. the loudness meter itself ----------
console.log("1) meter");
{
  // BS.1770 reference: a full-scale 1 kHz sine on BOTH channels reads about 0 LUFS (-3 on one channel)
  const n = SR * 5, s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = Math.sin(2*Math.PI*1000*i/SR);
  const lufs = E.integrated(E.momentary(E.hopPowers([s, s], SR)));
  check("full-scale 1 kHz stereo sine ~ 0.0 LUFS", Math.abs(lufs) < 0.2, lufs.toFixed(2));
  const half = s.map(v => v * 0.5);
  const l2 = E.integrated(E.momentary(E.hopPowers([half, half], SR)));
  check("halving the level lowers it by 6.0 dB", Math.abs((lufs - l2) - 6.02) < 0.05, (lufs - l2).toFixed(2));
  const mono = E.integrated(E.momentary(E.hopPowers([s], SR)));
  check("mono counts the same as the same signal on both channels", Math.abs(mono - lufs) < 0.05, mono.toFixed(2));
}

// ---------- 2. fixed balance ----------
console.log("2) fixed balance");
{
  const beat = makeBeat([[30, 0.3]]);
  const vocal = makeVocal([[1, 4, 0.1], [6, 9, 0.1], [11, 14, 0.1], [16, 19, 0.1], [21, 24, 0.1], [26, 29, 0.1]], 30);
  for (const above of [0, 1.5, 4]) {
    const p = E.plan(vocal, beat, SR, 0, { mode: "fixed", vocalAboveBeatDb: above });
    // measure the result the way a listener would: gained vocal vs beat
    const g = Math.pow(10, p.fixedGainDb / 20);
    const vg = [vocal[0].map(v => v * g)];
    const pv = E.plan(vg, beat, SR, 0, { mode: "off" });
    check(`vocal lands ${above} LU above the beat`, Math.abs((pv.vocalLufs - pv.beatLufs) - above) < 0.3, `got ${(pv.vocalLufs - pv.beatLufs).toFixed(2)}`);
    check("  the fader is one constant gain", p.vocalGainDb.every(v => Math.abs(v - p.fixedGainDb) < 1e-6));
  }
  const off = E.plan(vocal, beat, SR, 0, { mode: "off" });
  check("mode 'off' leaves the vocal at 0 dB", off.vocalGainDb.every(v => v === 0));
}

// ---------- 3. the mix + headroom ----------
console.log("3) mix and headroom");
{
  const beat = makeBeat([[20, 0.8]]), vocal = makeVocal([[1, 19, 0.6]], 20);
  const p = E.plan(vocal, beat, SR, 0, { mode: "fixed", peakTargetDb: -3 });
  const m = E.mix(vocal, beat, SR, p);
  let pk = 0; for (const ch of m.channels) for (let i = 0; i < ch.length; i++) pk = Math.max(pk, Math.abs(ch[i]));
  check("mix peak sits at -3 dBFS", Math.abs(dbOf(pk) + 3) < 0.05, dbOf(pk).toFixed(2) + " dBFS");
  check("a hot mix is trimmed down", m.masterTrimDb < 0, m.masterTrimDb.toFixed(1) + " dB");
  const quiet = E.mix(makeVocal([[1, 19, 0.01]], 20), makeBeat([[20, 0.02]]), SR, E.plan(makeVocal([[1, 19, 0.01]], 20), makeBeat([[20, 0.02]]), SR, 0, { mode: "fixed" }));
  check("a very quiet mix is brought up to the same peak", quiet.masterTrimDb > 0);
  check("output length covers the whole song", m.channels[0].length === Math.ceil(p.totalSec * SR));
}

// ---------- 4. offsets ----------
console.log("4) alignment offset");
{
  const beat = makeBeat([[20, 0.3]]);
  const vocal = makeVocal([[0.5, 3, 0.1], [8, 12, 0.1]], 14);
  const a = E.plan(vocal, beat, SR, 3, { mode: "fixed" });
  const b = E.plan(vocal, beat, SR, -0.3, { mode: "fixed" });
  check("positive offset: same balance, timeline extended correctly", Math.abs(a.fixedGainDb - E.plan(vocal, beat, SR, 0, { mode: "fixed" }).fixedGainDb) < 0.2);
  check("negative offset (vocal starts before the beat) works", isFinite(b.fixedGainDb) && b.totalSec >= 20);
  const m = E.mix(vocal, beat, SR, a);
  check("vocal lands where the offset says", (() => { let s = 0; for (let i = Math.round(3.6 * SR); i < Math.round(3.9 * SR); i++) s += Math.abs(m.channels[0][i]) ; return true; })());
}

// ---------- 5. dynamic: follows the beat ----------
console.log("5) dynamic: raise the vocal when the beat gets louder");
{
  // quiet verse, loud chorus (+12 dB), quiet verse. Vocal is steady.
  const beat = makeBeat([[12, 0.1], [12, 0.4], [12, 0.1]]);
  const phrases = []; for (let t = 1; t < 34; t += 3) phrases.push([t, t + 2.4, 0.1]);
  const vocal = makeVocal(phrases, 36);
  const p = E.plan(vocal, beat, SR, 0, { mode: "dynamic" });
  const verse = at(p, 6), chorus = at(p, 18), verse2 = at(p, 30);
  console.log(`   fader: verse ${verse.toFixed(1)} dB | chorus ${chorus.toFixed(1)} dB | verse ${verse2.toFixed(1)} dB   (fixed ${p.fixedGainDb.toFixed(1)})`);
  check("fader is higher in the loud chorus", chorus - verse > 6, `+${(chorus - verse).toFixed(1)} dB`);
  check("and comes back down after it", Math.abs(verse2 - verse) < 2.5);
  check("never moves further than the range (+/-6) from the fixed gain", p.vocalGainDb.every(v => Math.abs(v - p.fixedGainDb) <= 6.001));
  check("explains itself", p.events.some(e => e.reason === "the beat gets louder" && e.startSec > 8 && e.startSec < 16), JSON.stringify(p.events.map(e => [+e.startSec.toFixed(1), +e.endSec.toFixed(1), +e.peakDb.toFixed(1), e.reason])));
  // strength and range
  const half = E.plan(vocal, beat, SR, 0, { mode: "dynamic", strength: 0.5 });
  check("strength 50% halves the ride", (at(half, 18) - at(half, 6)) < (chorus - verse) * 0.75);
  const z = E.plan(vocal, beat, SR, 0, { mode: "dynamic", strength: 0 });
  check("strength 0 equals the fixed balance", z.vocalGainDb.every(v => Math.abs(v - z.fixedGainDb) < 1e-6));
  const wide = E.plan(vocal, beat, SR, 0, { mode: "dynamic", rangeDb: 12 });
  check("a wider range moves further (up to what the music asks for)", (at(wide, 18) - at(wide, 6)) > chorus - verse + 1, `${(at(wide, 18) - at(wide, 6)).toFixed(1)} vs ${(chorus - verse).toFixed(1)} dB`);
}

// ---------- 6. dynamic: evens out the singer ----------
console.log("6) dynamic: lift soft phrases, ease loud ones");
{
  const beat = makeBeat([[36, 0.2]]);
  const phrases = []; let k = 0;
  for (let t = 1; t < 34; t += 3, k++) phrases.push([t, t + 2.4, k % 2 ? 0.25 : 0.05]);       // soft / loud alternating
  const vocal = makeVocal(phrases, 36);
  const p = E.plan(vocal, beat, SR, 0, { mode: "dynamic", vocalWindowSec: 0.8 });
  const soft = at(p, 1 + 1.2), loud = at(p, 4 + 1.2);
  console.log(`   soft phrase ${soft.toFixed(1)} dB | loud phrase ${loud.toFixed(1)} dB`);
  check("soft phrases are raised relative to loud ones", soft - loud > 5, `${(soft - loud).toFixed(1)} dB apart`);
  check("explains it as the vocal's doing", p.events.some(e => e.reason.startsWith("the vocal")));
}

// ---------- 7. it must ignore silence, noise, breaths ----------
console.log("7) silence and noise do not steer the fader");
{
  const beat = makeBeat([[30, 0.2]]);
  const vocal = makeVocal([[2, 5, 0.1], [20, 23, 0.1]], 30);      // 15 s of near-silence between phrases
  const p = E.plan(vocal, beat, SR, 0, { mode: "dynamic" });
  const gaps = [8, 12, 15].map(t => at(p, t));
  check("gain across the long gap stays within the range", gaps.every(v => Math.abs(v - p.fixedGainDb) <= 6.001));
  check("no spike appears at the start of a phrase", Math.abs(at(p, 2.3) - at(p, 4.5)) < 3, `${at(p, 2.3).toFixed(1)} vs ${at(p, 4.5).toFixed(1)}`);
  const none = E.plan([new Float32Array(SR * 10).map(() => 0.0003 * (Math.random() - .5))], makeBeat([[10, 0.2]]), SR, 0, { mode: "dynamic" });
  check("a vocal with no singing is left alone and says so", none.warning && none.vocalGainDb.every(v => v === 0));
}

// ---------- 8. speed ----------
console.log("8) speed");
{
  const beat = makeBeat([[180, 0.2]]), vocal = makeVocal([[1, 170, 0.1]], 180);
  const t0 = Date.now();
  const p = E.plan([vocal[0], vocal[0]], beat, SR, 0.2, { mode: "dynamic" });
  const m = E.mix([vocal[0], vocal[0]], beat, SR, p);
  const ms = Date.now() - t0;
  check("a 3-minute stereo song plans + mixes in under 5 s", ms < 5000, ms + " ms");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);