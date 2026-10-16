// Run: node test_studio.js    (needs studiolevels.js, levelmatch.js, studio.js beside it)
const SLv = require("./studiolevels.js");
const { createLevelEngine } = require("./levelmatch.js");
const { createStudioEngine } = require("./studio.js");
const L = createLevelEngine(), SR = 44100;
let pass = 0, fail = 0;
const check = (l, ok, x = "") => { ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + l + (x ? "   " + x : "")); };
const dbOf = (v) => 20 * Math.log10(Math.max(v, 1e-12));
function rng(s) { let a = s; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// a sung-like tone (harmonics + gentle vibrato) written into arr between a and b seconds
function sing(arr, a, b, amp, f0) {
  let ph = 0;
  for (let i = Math.round(a * SR); i < Math.min(arr.length, Math.round(b * SR)); i++) {
    const t = i / SR, env = Math.min(1, (i - a * SR) / 900, (b * SR - i) / 900);
    ph += f0 * (1 + 0.008 * Math.sin(2 * Math.PI * 5.5 * t)) / SR; ph -= Math.floor(ph);
    let s = 0; for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.3);
    arr[i] += amp * env * s * 0.5;
  }
}
const noise = (arr, seed) => { const r = rng(seed); for (let i = 0; i < arr.length; i++) arr[i] += 0.0004 * (r() - 0.5); };
const level = (x) => SLv.activeLevel([{ data: x, sr: SR }]);

console.log("1) lane maths");
{
  const a = new Float32Array(SR * 3); sing(a, 0, 3, 0.1, 220);
  const b = new Float32Array(SR * 12); sing(b, 0, 3, 0.1, 220); noise(b, 1);
  check("measured while sounding: 9 s of silence added around the same singing changes nothing (< 0.3 dB)", Math.abs(level(a).db - level(b).db) < 0.3, level(a).db.toFixed(2) + " vs " + level(b).db.toFixed(2));

  const lead = new Float32Array(SR * 30); for (let t = 1; t < 28; t += 6) sing(lead, t, t + 3, 0.1, 200 + t * 3); noise(lead, 2);   // 50% silence
  const adlib = new Float32Array(SR * 4); sing(adlib, 0.2, 1.4, 0.03, 330); sing(adlib, 2, 3.5, 0.03, 300);                            // short, dense, quiet
  const ld = level(lead).db, ad = level(adlib);
  const gain = (mode, o) => SLv.resolveGain(Object.assign({ mode, type: "adlib", laneDb: ad.db, laneActiveSec: ad.activeSec, leadDb: ld }, o || {}));
  const landed = (g) => ad.db + g.db - ld;
  console.log(`   lead sounds at ${ld.toFixed(1)} dB, the adlib at ${ad.db.toFixed(1)} dB (recorded ${(ad.db - ld).toFixed(1)} dB vs lead)`);
  check("Relatively lower lands 3.5 dB under the lead", Math.abs(landed(gain("lower")) + 3.5) < 0.3, landed(gain("lower")).toFixed(2));
  check("Relatively higher lands 3 dB over the lead", Math.abs(landed(gain("higher")) - 3) < 0.3, landed(gain("higher")).toFixed(2));
  check("Same as the lead lands level with it", Math.abs(landed(gain("match"))) < 0.3, landed(gain("match")).toFixed(2));
  check("Auto puts an adlib 6 dB under, a tag 7.5 dB under", Math.abs(landed(gain("auto")) + 6) < 0.3 && Math.abs(landed(gain("auto", { type: "tag" })) + 7.5) < 0.3);
  const k = gain("keep");
  check("Keep as recorded: exactly 0 dB, whatever the lead is", k.db === 0 && k.lin === 1);
  check("the lead lane itself is never moved", gain("higher", { isLead: true }).db === 0);
  check("Mute skips the lane", gain("mute").db === null && gain("mute").lin === 0);
  check("names from the first version still work (quieter -> lower, louder -> higher, same/lead -> keep)", SLv.normalizeMode("quieter") === "lower" && SLv.normalizeMode("louder") === "higher" && SLv.normalizeMode("same") === "keep" && SLv.normalizeMode("lead") === "keep" && SLv.normalizeMode("zzz") === "auto");
  check("no lead, or a lane with nothing in it: left as recorded, not guessed", gain("lower", { leadDb: null }).db === 0 && gain("lower", { laneActiveSec: 0.05 }).db === 0);
  const tiny = new Float32Array(SR * 3); sing(tiny, 0, 3, 0.0005, 330);
  const gt = SLv.resolveGain({ mode: "match", type: "adlib", laneDb: level(tiny).db, laneActiveSec: level(tiny).activeSec, leadDb: ld });
  check("a very quiet lane is limited to +18 dB (no blasting its noise) and says so", gt.db <= 18.001 && gt.clamped, gt.db.toFixed(1) + " dB");
  console.log(`   the FIRST version: "Quieter" = a fixed -6.5 dB on the recorded level -> this adlib would have ended ${(ad.db - 6.5 - ld).toFixed(1)} dB vs the lead, not -3.5`);
}

console.log("2) through the pipeline's level ride");
{
  const N = SR * 40, lead = new Float32Array(N), intro = new Float32Array(N), adlib = new Float32Array(N), r = rng(9);
  sing(intro, 1, 7, 0.03, 200);                                                          // recorded 10 dB under the lead
  for (let t = 9; t < 38; t += 6) sing(lead, t, t + 4, 0.1, 230);
  for (let t = 13.3; t < 38; t += 6) sing(adlib, t, t + 1.2, 0.05, 330);                // recorded 6 dB under the lead
  noise(lead, 3);
  const mkBeat = (loud) => { const L_ = new Float32Array(N), R_ = new Float32Array(N), q = rng(11); for (let i = 0; i < N; i++) { const sec = i / SR, amp = sec > 15 && sec < 28 ? loud : 0.12, b = amp * (0.6 * Math.sin(2 * Math.PI * 110 * sec) + 0.3 * Math.sin(2 * Math.PI * 440 * sec) + 0.2 * (q() - .5)); L_[i] = b; R_[i] = b * 0.9; } return [L_, R_]; };
  const lv = level(lead), iv = level(intro), av = level(adlib);
  const gIntro = SLv.resolveGain({ mode: "match", type: "other", laneDb: iv.db, laneActiveSec: iv.activeSec, leadDb: lv.db });
  const gAd = SLv.resolveGain({ mode: "lower", type: "adlib", laneDb: av.db, laneActiveSec: av.activeSec, leadDb: lv.db });
  const comp = new Float32Array(N);
  for (let i = 0; i < N; i++) comp[i] = lead[i] + intro[i] * gIntro.lin + adlib[i] * gAd.lin;
  console.log(`   lane gains: intro ${gIntro.db.toFixed(1)} dB (brought to the lead), adlib ${gAd.db.toFixed(1)} dB (3.5 under)`);
  const at = (p, sec) => p.vocalGainDb[Math.min(p.vocalGainDb.length - 1, Math.max(0, Math.round((sec - p.blockCenterSec) / p.hopSec)))];
  const m = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const adT = [0.1, 0.4, 0.8, 1.1].flatMap(d => [13.3 + d, 19.3 + d, 25.3 + d]), inT = [2, 3.5, 5, 6.5];

  // 2a. a steady beat, so the only thing moving the fader is the singing itself
  const flat = mkBeat(0.12);
  const old = L.plan([comp], flat, SR, 0, { mode: "dynamic" });                                   // before: ride the whole composite
  const neu = L.plan([comp], flat, SR, 0, { mode: "dynamic", measureChannels: [lead] });          // now: ride the lead, apply to all
  const base = L.plan([lead], flat, SR, 0, { mode: "dynamic" });                                  // what a lead-level sound gets at each moment
  const shift = (p, times) => times.map(t => at(p, t) - at(base, t));                              // extra lift/cut vs a lead-level sound (0 = keeps the level you set)
  const oldAd = shift(old, adT), neuAd = shift(neu, adT), oldIn = shift(old, inT), neuIn = shift(neu, inT);
  console.log(`   adlib (set 3.5 dB under) is moved by the ride:  before ${m(oldAd).toFixed(1)} dB (up to ${Math.max(...oldAd.map(Math.abs)).toFixed(1)}),  now ${m(neuAd).toFixed(1)} dB`);
  console.log(`   soft intro (brought to the lead) is moved by:   before ${m(oldIn).toFixed(1)} dB,  now ${m(neuIn).toFixed(1)} dB`);
  check("before: the old ride pulled the adlib off the level you set (> 1 dB)", Math.abs(m(oldAd)) > 1, m(oldAd).toFixed(1) + " dB");
  check("now: the adlib keeps its level (within 0.5 dB, worst 0.8)", Math.abs(m(neuAd)) < 0.5 && Math.max(...neuAd.map(Math.abs)) < 0.8, "worst " + Math.max(...neuAd.map(Math.abs)).toFixed(2));
  check("now: it is at its level from the FIRST 100 ms, not after a ramp", Math.abs(shift(neu, [13.4])[0]) < 0.5, shift(neu, [13.4])[0].toFixed(2) + " dB");
  check("now: the soft intro keeps the lead's level too", Math.abs(m(neuIn)) < 0.5, m(neuIn).toFixed(2) + " dB");
  check("the plan says it measured the lead; no big arrays left in its options", neu.measuredFromLead === true && !old.measuredFromLead && !neu.options.measureChannels);

  // 2b. a beat that gets louder in the middle: the lead must still be ridden with the music
  const dyn = mkBeat(0.2);
  const neuD = L.plan([comp], dyn, SR, 0, { mode: "dynamic", measureChannels: [lead] });
  const leadQuiet = at(neuD, 10), leadLoud = at(neuD, 22);
  check("the lead is still ridden with the music (louder section -> the fader moves)", Math.abs(leadLoud - leadQuiet) > 1.5, `${leadQuiet.toFixed(1)} dB -> ${leadLoud.toFixed(1)} dB`);
  const adD = [13.4, 13.9, 19.4, 25.4].map(t => at(neuD, t) - at(L.plan([lead], dyn, SR, 0, { mode: "dynamic" }), t));
  check("...and the adlib still follows the lead's fader exactly (within 0.8 dB)", Math.max(...adD.map(Math.abs)) < 0.8, "worst " + Math.max(...adD.map(Math.abs)).toFixed(2));
}

console.log("3) the lead as the processed composite will sound");
{
  const N = SR * 30, lead = new Float32Array(N), adlib = new Float32Array(N);
  for (let t = 2; t < 28; t += 6) sing(lead, t, t + 4, 0.2, 230);
  for (let t = 6.3; t < 28; t += 6) sing(adlib, t, t + 1.2, 0.05, 330);
  const raw = lead.map((v, i) => v + adlib[i]);
  // a "chain" that squashes the loud parts by ~4 dB (like the compressors) with a smooth gain
  const fin = new Float32Array(N), hop = Math.round(0.1 * SR); let g = 1;
  for (let f = 0; f * hop < N; f++) { let s = 0; for (let i = f * hop; i < Math.min(N, (f + 1) * hop); i++) s += raw[i] * raw[i]; const d = 10 * Math.log10(s / hop + 1e-14), want = Math.pow(10, -(d > -32 ? (d + 32) * 0.45 : 0) / 20); for (let i = f * hop; i < Math.min(N, (f + 1) * hop); i++) { g += 0.01 * (want - g); fin[i] = raw[i] * g; } }
  const proc = SLv.leadLikeProcessed([lead], [raw], [fin], SR, L.hopPowers)[0];
  // truth: the same chain applied to the lead on its own is roughly the lead's share of the gain; compare loudness while singing
  const trueDb = SLv.activeLevel([{ data: (() => { const y = new Float32Array(N); let g2 = 1; for (let f = 0; f * hop < N; f++) { let s = 0; for (let i = f * hop; i < Math.min(N, (f + 1) * hop); i++) s += raw[i] * raw[i]; const d = 10 * Math.log10(s / hop + 1e-14), want = Math.pow(10, -(d > -32 ? (d + 32) * 0.45 : 0) / 20); for (let i = f * hop; i < Math.min(N, (f + 1) * hop); i++) { g2 += 0.01 * (want - g2); y[i] = lead[i] * g2; } } return y; })(), sr: SR }]).db;
  const rawDb = level(lead).db, estDb = level(proc).db;
  console.log(`   lead as recorded ${rawDb.toFixed(1)} dB | after the chain (truth) ${trueDb.toFixed(1)} dB | estimate from the composite ${estDb.toFixed(1)} dB`);
  check("the chain's effect on the lead is estimated within 1 dB", Math.abs(estDb - trueDb) < 1.0, (estDb - trueDb).toFixed(2) + " dB off");
  check("(using the raw lead would have been further off)", Math.abs(rawDb - trueDb) > Math.abs(estDb - trueDb) + 0.5, (rawDb - trueDb).toFixed(2) + " dB off");
}

console.log("4) phrase evening on a stacked vocal");
{
  const E = createStudioEngine(), N = SR * 40, lead = new Float32Array(N), ad = new Float32Array(N);
  for (let t = 2; t < 38; t += 6) { sing(lead, t, t + 3.2, 0.2, 200 + (t % 5) * 20); sing(ad, t + 4, t + 5.2, 0.05, 330); }   // adlibs 12 dB under the lead
  const comp = lead.map((v, i) => v + ad[i]); noise(comp, 5);
  const rel = (x) => { let a = 0, an = 0, b = 0, bn = 0; for (let t = 2; t < 38; t += 6) { for (let i = Math.round((t + 0.3) * SR); i < Math.round((t + 2.9) * SR); i++) { a += x[i] * x[i]; an++; } for (let i = Math.round((t + 4.2) * SR); i < Math.round((t + 5) * SR); i++) { b += x[i] * x[i]; bn++; } } return 10 * Math.log10((b / bn) / (a / an)); };
  const on = E.prepareVocal([comp], SR, { highPassHz: 85, multiband: false }).channels[0], off = E.prepareVocal([comp], SR, { highPassHz: 85, multiband: false, phraseEven: false }).channels[0];
  console.log(`   adlib vs lead: as recorded ${rel(comp).toFixed(1)} dB | phrase evening on ${rel(on).toFixed(1)} dB | off ${rel(off).toFixed(1)} dB`);
  check("with phrase evening off, the lane offset survives the vocal polish (within 1 dB)", Math.abs(rel(off) - rel(comp)) < 1.0, (rel(off) - rel(comp)).toFixed(2) + " dB");
  check("with it on, the adlib is pulled toward the lead (this is why Studio lanes switch it off)", rel(on) - rel(comp) > 1.0, (rel(on) - rel(comp)).toFixed(2) + " dB");
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
