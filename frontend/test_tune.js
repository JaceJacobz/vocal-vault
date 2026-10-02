const fs = require("fs");
const vm = require("vm");
const { createTuneEngine } = require("./pitchcorrect.js");

const SR = +(process.env.SR || 44100);
const E = createTuneEngine();

// independent detector from analysis.js (different algorithm: autocorrelation)
const ctx = { module: {}, console, Math, Float32Array, Float64Array, Uint16Array, Uint32Array, Worker: undefined, URL: {}, Blob: function () { } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + "/analysis.js", "utf8") + "\nthis.detectVocalPitch = detectVocalPitch;", ctx);
const oldDetect = ctx.detectVocalPitch;

function rng(seed) { let a = seed; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- synthetic vocal in B minor ----
function makeVocal(seconds, seed) {
    const r = rng(seed);
    const n = Math.floor(seconds * SR);
    const x = new Float32Array(n);
    const bMinor = [11, 1, 2, 4, 6, 7, 9];                 // B C# D E F# G A
    const pool = [];
    for (let m = 59; m <= 70; m++) if (bMinor.includes(m % 12)) pool.push(m);   // B3..A#4 range
    const notes = [];
    let t = 0.3, prev = 62;
    while (t < seconds - 1) {
        let m; do { m = pool[Math.floor(r() * pool.length)]; } while (Math.abs(m - prev) > 5 && r() < 0.8);
        const dur = 0.3 + r() * 0.6;
        notes.push({ t0: t, t1: t + dur, midi: m, errCents: (r() - 0.5) * 16, vib: 10 + r() * 20 });
        prev = m;
        t += dur + 0.06 + r() * 0.1;
    }

    // formant filters (vowel "ah")
    const formants = [[700, 90], [1150, 100], [2600, 140]];
    const phase = new Float64Array(1);
    const f0at = new Float64Array(n).fill(0), amp = new Float32Array(n);
    for (const nt of notes) {
        const base = 440 * Math.pow(2, (nt.midi - 69) / 12) * Math.pow(2, (nt.errCents + 1) / 1200);
        for (let i = Math.floor(nt.t0 * SR); i < Math.floor(nt.t1 * SR) && i < n; i++) {
            const tt = i / SR - nt.t0, dur = nt.t1 - nt.t0;
            const scoop = tt < 0.07 ? -60 * (1 - tt / 0.07) : 0;                    // scoop up into note
            const vib = tt > 0.15 ? nt.vib * Math.sin(2 * Math.PI * 5.5 * (tt - 0.15)) * Math.min(1, (tt - 0.15) / 0.2) : 0;
            f0at[i] = base * Math.pow(2, (scoop + vib) / 1200);
            amp[i] = Math.min(1, tt / 0.03, (dur - tt) / 0.05);
        }
    }
    const src = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        if (f0at[i] === 0) continue;
        ph += f0at[i] / SR; ph -= Math.floor(ph);
        // glottal-ish pulse via harmonics
        let s = 0;
        const hmax = Math.floor(5000 / f0at[i]);
        for (let h = 1; h <= hmax; h++) s += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.6);
        src[i] = s * amp[i];
    }
    // resonators
    let y = src;
    for (const [fc, bw] of formants) {
        const rr = Math.exp(-Math.PI * bw / SR), th = 2 * Math.PI * fc / SR;
        const a1 = -2 * rr * Math.cos(th), a2 = rr * rr, g = 1 - rr;
        const o = new Float32Array(n); let y1 = 0, y2 = 0;
        for (let i = 0; i < n; i++) { const v = g * y[i] - a1 * y1 - a2 * y2; o[i] = v; y2 = y1; y1 = v; }
        y = o;
    }
    // breaths / consonants between notes + light noise floor
    for (let k = 0; k < notes.length - 1; k++) {
        const a = Math.floor(notes[k].t1 * SR), b = Math.floor(notes[k + 1].t0 * SR);
        for (let i = a; i < b; i++) y[i] += (r() - 0.5) * 0.04 * Math.sin(Math.PI * (i - a) / (b - a));
    }
    let pk = 0; for (let i = 0; i < n; i++) { y[i] += (r() - 0.5) * 0.0008; pk = Math.max(pk, Math.abs(y[i])); }
    for (let i = 0; i < n; i++) y[i] *= 0.7 / pk;
    return { x: y, notes };
}

const o = { rootPc: 11, scale: "minor", refCents: -4 };
const vocal = makeVocal(24, 3);
const hopSec = 64 * Math.max(1, Math.round(SR / 11025)) / SR;
console.log("synthetic vocal:", (vocal.x.length / SR).toFixed(1) + "s,", vocal.notes.length, "notes");

// ---------- 1. tracker accuracy vs. truth ----------
let t0 = Date.now();
const track = E.trackClean(vocal.x, SR);
console.log("track time", Date.now() - t0, "ms; hop", (hopSec * 1000).toFixed(1), "ms");
let errs = [];
for (const nt of vocal.notes) {
    const a = Math.round((nt.t0 + 0.2) / hopSec), b = Math.round((nt.t1 - 0.1) / hopSec);
    const v = []; for (let k = a; k < b; k++) if (!isNaN(track.midi[k])) v.push(track.midi[k]);
    if (v.length < 5) continue;
    const med = v.sort((p, q) => p - q)[v.length >> 1];
    const truth = nt.midi + (nt.errCents + 1) / 100;
    errs.push((med - truth) * 100);
}
console.log("1) tracker: note-centre error vs truth (cents): median |err| =",
    errs.map(Math.abs).sort((a, b) => a - b)[errs.length >> 1].toFixed(2), " max |err| =", Math.max(...errs.map(Math.abs)).toFixed(2), " n =", errs.length);
const voicedFrac = track.midi.filter(v => !isNaN(v)).length / track.midi.length;
console.log("   voiced frames:", (voicedFrac * 100).toFixed(0) + "%");

// ---------- 2. constant shifts: does PSOLA move pitch by what we asked? ----------
function pitchMedian(sig, from, to) {
    const t = E.trackClean(sig, SR); const v = [];
    for (let k = Math.floor(from / hopSec); k < Math.floor(to / hopSec); k++) if (!isNaN(t.midi[k])) v.push(t.midi[k]);
    v.sort((a, b) => a - b); return v[v.length >> 1];
}
console.log("2) constant shift accuracy (own tracker / old autocorr detector):");
for (const cents of [-100, -60, -25, 25, 60, 100]) {
    const sh = new Float32Array(track.midi.length).fill(cents);
    const y = E.applyShift([vocal.x], vocal.x, SR, track, sh, { force: true })[0];
    // compare per-note medians
    const d1 = [], d2 = [];
    const oldA = oldDetect({ sampleRate: SR, length: vocal.x.length, numberOfChannels: 1, getChannelData: () => vocal.x }).frames;
    const oldB = oldDetect({ sampleRate: SR, length: y.length, numberOfChannels: 1, getChannelData: () => y }).frames;
    const tb = E.trackClean(y, SR);
    for (const nt of vocal.notes) {
        const a = Math.round((nt.t0 + 0.2) / hopSec), b = Math.round((nt.t1 - 0.1) / hopSec);
        const va = [], vb = [];
        for (let k = a; k < b; k++) if (!isNaN(track.midi[k]) && !isNaN(tb.midi[k])) { va.push(track.midi[k]); vb.push(tb.midi[k]); }
        if (va.length < 5) continue;
        const m = (arr) => arr.sort((p, q) => p - q)[arr.length >> 1];
        d1.push((m(vb) - m(va)) * 100);
        const ia = Math.round(nt.t0 * SR / 1024) + 4, ib = Math.round(nt.t1 * SR / 1024) - 3;
        const oa = [], ob = [];
        for (let k = ia; k < ib; k++) if (oldA[k] && oldA[k].midi != null && oldB[k] && oldB[k].midi != null && oldA[k].confidence > 0.6 && oldB[k].confidence > 0.6) { oa.push(oldA[k].midi); ob.push(oldB[k].midi); }
        if (oa.length > 4) d2.push((m(ob) - m(oa)) * 100);
    }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    console.log(`   asked ${String(cents).padStart(4)}c -> own: median ${med(d1).toFixed(1)}c (worst dev ${Math.max(...d1.map(v => Math.abs(v - cents))).toFixed(1)}c)   old detector: median ${d2.length ? med(d2).toFixed(1) : "n/a"}c (n=${d2.length})`);
}

// ---------- 3. identity: PSOLA at ratio 1 should reproduce the input ----------
{
    const sh = new Float32Array(track.midi.length);
    const y = E.applyShift([vocal.x], vocal.x, SR, track, sh, { force: true })[0];
    let sig = 0, err = 0;
    for (let i = 0; i < y.length; i++) { sig += vocal.x[i] ** 2; err += (vocal.x[i] - y[i]) ** 2; }
    console.log("3) PSOLA identity (shift 0, forced): SNR =", (10 * Math.log10(sig / err)).toFixed(1), "dB");
    const y2 = E.applyShift([vocal.x], vocal.x, SR, track, sh)[0];
    let same = true; for (let i = 0; i < y2.length; i++) if (y2[i] !== vocal.x[i]) { same = false; break; }
    console.log("   shift 0, normal mode: bit-identical passthrough =", same);
}

// ---------- 4. spectral / roughness check on a 60-cent shift ----------
{
    const sh = new Float32Array(track.midi.length).fill(60);
    const y = E.applyShift([vocal.x], vocal.x, SR, track, sh, { force: true })[0];
    function nrg(sig) { let s = 0; for (let i = 0; i < sig.length; i++) s += sig[i] ** 2; return Math.sqrt(s / sig.length); }
    function hf(sig) { let s = 0, d = 0; for (let i = 1; i < sig.length; i++) { d = sig[i] - sig[i - 1]; s += d * d; } return Math.sqrt(s / sig.length); }
    console.log("4) 60c shift: RMS ratio", (nrg(y) / nrg(vocal.x)).toFixed(3), "| high-frequency (diff) energy ratio", (hf(y) / hf(vocal.x)).toFixed(3));
}

// ---------- 5. the full detune -> correct test ----------
console.log("5) full pipeline with testDetune (B minor, beat tuning -4c):");
t0 = Date.now();
const res = createTuneEngine().process([vocal.x], SR, Object.assign({ testDetune: true }, o));
console.log("   job time", Date.now() - t0, "ms for", (vocal.x.length / SR).toFixed(0), "s of audio");
const fmt = (s) => `inKey ${s.inKeyPct.toFixed(1)}%  median ${s.medianCents.toFixed(1)}c  <=25c ${s.within25Pct.toFixed(1)}%  <=50c ${s.within50Pct.toFixed(1)}%  notes ${s.notes} (out of key ${s.notesOutOfKey})`;
console.log("   original:", fmt(res.stats.original));
console.log("   detuned :", fmt(res.stats.detuned));
console.log("   tuned   :", fmt(res.stats.tuned));
console.log("   events:", res.detuneEvents.length, "(" + res.detuneEvents.filter(e => e.kind === "wrong-note").length + " wrong-note)", "corrected notes:", res.corrected, "/", res.notes);

// per-event recovery against the ORIGINAL pitch
{
    const orig = res.contours.original, tun = res.contours.tuned;
    const notes = E.segmentNotes(orig);
    const hopS = res.hop / SR;
    const errsEv = [];
    for (const nt of notes) {
        const v1 = [], v2 = [];
        for (let k = nt.start + Math.floor((nt.end - nt.start) * 0.2); k < nt.end - Math.floor((nt.end - nt.start) * 0.2); k++) if (!isNaN(orig[k]) && !isNaN(tun[k])) { v1.push(orig[k]); v2.push(tun[k]); }
        if (v1.length < 8) continue;
        const m = (a) => a.sort((p, q) => p - q)[a.length >> 1];
        errsEv.push(Math.abs(m(v2) - m(v1)) * 100);
    }
    errsEv.sort((a, b) => a - b);
    console.log("   tuned vs ORIGINAL note centres: median", errsEv[errsEv.length >> 1].toFixed(1) + "c, 90th pct", errsEv[Math.floor(errsEv.length * 0.9)].toFixed(1) + "c, max", errsEv[errsEv.length - 1].toFixed(1) + "c (n=" + errsEv.length + ")");
}

// ---------- 6. old detector's opinion of the tuned vocal ----------
{
    const buf = (s) => ({ sampleRate: SR, length: s.length, numberOfChannels: 1, getChannelData: () => s });
    const sc = E.scaleMask(11, "minor");
    function oldStats(sig) {
        const fr = oldDetect(buf(sig)).frames.filter(f => f.midi != null && f.confidence >= 0.6);
        let ink = 0, w25 = 0; const dd = [];
        for (const f of fr) { const m = f.midi + 0.04; const t = E.nearestNote(m, 11, sc, false); const d = Math.abs(m - t) * 100; dd.push(d); if (sc[((Math.round(m) % 12) + 12) % 12]) ink++; if (d <= 25) w25++; }
        dd.sort((a, b) => a - b);
        return `inKey ${(100 * ink / fr.length).toFixed(1)}%  median ${dd[dd.length >> 1].toFixed(1)}c  <=25c ${(100 * w25 / fr.length).toFixed(1)}%  (n=${fr.length})`;
    }
    console.log("6) independent check with the old autocorrelation detector:");
    console.log("   original:", oldStats(vocal.x));
    console.log("   detuned :", oldStats(res.audio.detuned[0]));
    console.log("   tuned   :", oldStats(res.audio.tuned[0]));
}


// ---------- 7. per-event recovery ----------
{
    const orig = res.contours.original, tun = res.contours.tuned, det = res.contours.detuned;
    const hopS = res.hop / SR;
    const m = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const rows = { "off-pitch": [], "wrong-note": [] };
    for (const ev of res.detuneEvents) {
        const a = Math.floor(ev.startSec / hopS), b = Math.floor(ev.endSec / hopS), span = b - a;
        const v = [[], [], []];
        for (let k = a + Math.floor(span * 0.2); k < b - Math.floor(span * 0.2); k++) if (!isNaN(orig[k]) && !isNaN(tun[k]) && !isNaN(det[k])) { v[0].push(orig[k]); v[1].push(det[k]); v[2].push(tun[k]); }
        if (v[0].length < 8) continue;
        const o0 = m(v[0]), d0 = m(v[1]), t0 = m(v[2]);
        rows[ev.kind].push({ applied: ev.cents, detunedErr: (d0 - o0) * 100, residual: (t0 - o0) * 100 });
    }
    for (const kind in rows) {
        const r = rows[kind];
        const back = r.filter(x => Math.abs(x.residual) <= 25).length;
        console.log(`7) ${kind}: ${r.length} events, back to the original note (<=25c): ${back}/${r.length}`);
        for (const x of r.filter(x => Math.abs(x.residual) > 25)) console.log(`     applied ${x.applied}c -> ended ${x.residual.toFixed(0)}c from the original note`);
    }
}