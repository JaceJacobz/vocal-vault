const { createStudioEngine } = require("./studio.js");
const { createFillEngine } = require("./fill.js");
const studio = createStudioEngine(), F = createFillEngine(studio);
let pass = 0, fail = 0;
const check = (l, ok, x = "") => { ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + l + (x ? "   " + x : "")); };
const { makeBeat, SR, BPM, OFF, BAR, BEAT, PROG, PCS, BASS, hz } = require("./beatgen.js");
const rmsRange = (x, a, b) => { let s = 0, c = 0; for (let i = Math.max(0, Math.round(a * SR)); i < Math.min(x.length, Math.round(b * SR)); i++) { s += x[i] * x[i]; c++; } return Math.sqrt(s / Math.max(1, c)); };
const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));
const barT = (j) => OFF + j * BAR;

// ---------- A. hats missing, 6-bar pad-only intro, break, silent outro ----------
console.log("A) beat with a pad-only intro, a drum break and a silent outro; hats are missing");
{
  const beat = makeBeat({ bars: 22, grooveBar: 6, brk: [14, 16], silentFrom: 20, pad: true, bass: true, kick: true, snare: true, hat: false });
  const t0 = Date.now();
  const res = F.fillMissing(beat, SR, { bpm: 92.0, rootPc: 9, scale: "minor", style: "rap" });
  console.log("   time", Date.now() - t0, "ms");
  res.report.forEach(l => console.log("   > " + l));
  const g = res.detection.grid;
  check("tempo refined to the real one (given 92.0)", Math.abs(g.bpm - BPM) / BPM < 0.0003, g.bpm.toFixed(3));
  const dbErr = ((((g.firstDownbeatSec - OFF) % BAR) + BAR) % BAR); const e = Math.min(dbErr, BAR - dbErr);
  check("first bar line lands on the real bar line (<10 ms)", e < 0.010, (e * 1000).toFixed(1) + " ms");
  check("groove start found at bar 6", Math.abs(res.detection.grooveStartSec - barT(6)) < 0.03, res.detection.grooveStartSec.toFixed(2) + " vs " + barT(6).toFixed(2));
  check("hats were added", res.added.some(a => /hats/.test(a)), res.added.join(", "));
  check("kick and snare (already there) were not added", !res.added.some(a => /kick|snare/.test(a)));
  const fl = res.fillChannels[0];
  check("NOTHING added in the 6-bar intro", rmsRange(fl, 0, barT(6) - 0.05) < 1e-6, db(rmsRange(fl, 0, barT(6) - 0.05)).toFixed(0) + " dB");
  check("nothing added in the drum break (bars 14-15)", rmsRange(fl, barT(14) + 0.02, barT(16) - 0.05) < 1e-6);
  check("nothing added in the silent outro", rmsRange(fl, barT(20) + 0.05, barT(22)) < 1e-6);
  check("something IS added in the groove", rmsRange(fl, barT(7), barT(9)) > 1e-4);
  // timing: every closed-hat onset in the fill (a hit that starts after >= 5 ms of exact silence) sits on the real 16th grid
  {
    let worst = 0, cnt = 0, zeros = 0;
    const from = Math.round(barT(8) * SR), to = Math.round(barT(10) * SR);
    for (let i = from; i < to; i++) {
      if (fl[i] === 0) zeros++; else { if (zeros >= Math.round(0.005 * SR)) { const t = i / SR, pos = (t - OFF) / (BAR / 16), d = Math.abs(pos - Math.round(pos)) * (BAR / 16); worst = Math.max(worst, d); cnt++; } zeros = 0; }
    }
    check("added hats land on the beat's grid (within 8 ms)", cnt > 6 && worst < 0.008, cnt + " hits, worst " + (worst * 1000).toFixed(1) + " ms");
  }
  const beatRms = rmsRange(beat[0], barT(7), barT(13)), fillRms = rmsRange(fl, barT(7), barT(13));
  check("fill sits well under the beat (>= 12 dB)", db(beatRms) - db(fillRms) >= 12, (db(beatRms) - db(fillRms)).toFixed(1) + " dB under");
}

// ---------- B. complete beat -> nothing added ----------
console.log("B) a complete beat is left alone");
{
  const beat = makeBeat({ bars: 20, grooveBar: 2, pad: true, bass: true, kick: true, snare: true, hat: true });
  const res = F.fillMissing(beat, SR, { bpm: 92.37, rootPc: 9, scale: "minor" });
  console.log("   " + res.report[res.report.length - 1]);
  check("nothing added", res.added.length === 0, res.added.join(", "));
  check("beat returned untouched", res.channels === beat);
}

// ---------- C. no drums at all: drums start with the music's full level; harmony follows the bass+pad ----------
console.log("C) melodic beat with no drums: drums start at the groove, not at 0:00");
{
  const beat = makeBeat({ bars: 20, grooveBar: 4, pad: true, bass: true, kick: false, snare: false, hat: false });
  const res = F.fillMissing(beat, SR, { bpm: 92.37, rootPc: 9, scale: "minor", style: "universal" });
  res.report.forEach(l => console.log("   > " + l));
  const fl = res.fillChannels[0];
  check("kick, snare and hats added", ["kick", "snare", "hats"].every(k => res.added.some(a => a.includes(k))), res.added.join(", "));
  const gs = res.detection.grooveStartSec;
  check("nothing before the groove start", rmsRange(fl, 0, gs - 0.05) < 1e-6, "groove " + gs.toFixed(2) + "s (bass enters at " + barT(4).toFixed(2) + ")");
  check("groove start is where the bass+music is at full level (bar 4)", Math.abs(gs - barT(4)) < 0.1);
}

// ---------- D. chords missing: fill follows the beat's own bass line ----------
console.log("D) harmony: bass line Am F C G, no chords -> added chords follow it");
{
  const beat = makeBeat({ bars: 20, grooveBar: 0, pad: false, bass: true, kick: true, snare: true, hat: true });
  const res = F.fillMissing(beat, SR, { bpm: 92.37, rootPc: 0, scale: "major", keyKnown: false, style: "universal" });
  res.report.forEach(l => console.log("   > " + l));
  const k = res.detection.key;
  check("key estimated from the audio (A minor or its relative C major)", (k.rootPc === 9 && k.scale === "minor") || (k.rootPc === 0 && k.scale === "major"), NOTE(k));
  let ok = 0, tot = 0;
  const A = res.analysis, P = res.plan;
  for (const b of A.bars) if (b.on && P.chords && P.chords[b.j] && b.j >= 2) {
    const ch = (Math.round((barT(b.j) - OFF) / BAR)) % 4;       // true chord of this bar (grid is bar-aligned with OFF)
    const want = new Set(PCS[(b.j - 1 + 4 - 0) % 4]); // bar j covers true bar (j-1) mod
    const got = new Set(P.chords[b.j].pcs);
    tot++; if ([...want].filter(x => got.has(x)).length >= 2) ok++;
  }
  check("chosen chords match the real progression in >= 80% of bars", tot > 8 && ok / tot >= 0.8, ok + "/" + tot);
  check("chords were added", res.added.some(a => /chords/.test(a)), res.added.join(", "));
}
function NOTE(k) { return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][k.rootPc] + " " + k.scale + " (" + k.source + ")"; }

// ---------- E. speed ----------
console.log("E) speed");
{
  const beat = makeBeat({ bars: 70, grooveBar: 4, pad: true, bass: true, kick: true, snare: true, hat: false });
  const t0 = Date.now(); const res = F.fillMissing(beat, SR, { bpm: 92.0, rootPc: 9, scale: "minor" }); const ms = Date.now() - t0;
  check(`a ${(beat[0].length / SR / 60).toFixed(1)}-minute beat is filled in under 15 s`, ms < 15000, ms + " ms");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
