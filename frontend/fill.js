/**
 * Vocal Vault — optional fill for missing / thin instruments (v2, section-aware)
 *
 * What it does differently from a "lay a loop over the whole song" fill:
 *  1. GRID      Finds the beat's real tempo (to 0.001%) and where beat 1 of each bar really falls,
 *               so added hits land on the beat's own grid, not on a grid that starts at 0:00.
 *  2. SECTIONS  Looks at the beat bar by bar. Nothing is added to silence, to a sparse intro before the
 *               groove starts, or to a deliberate break where the real drums drop out.
 *  3. PER PART  Each instrument is judged only in the bars where the groove is playing. Fully missing:
 *               filled. Only present in some bars: light support in the bars where it is absent, copying
 *               the rhythm the real part plays. Already there: left alone.
 *  4. HARMONY   Chords and bass follow the beat's own harmony bar by bar (read from the audio). Where the
 *               beat gives no clear harmony, the key's standard progression is used. If the key is not
 *               known it is estimated from the audio.
 *  5. LEVEL     Every added layer is set relative to the beat's own loudness, and rides with it.
 *
 * Off by default; only mixes under the real instrumental.
 */
(function (root) {
    "use strict";

    const MAJOR = [0, 2, 4, 5, 7, 9, 11];
    const MINOR = [0, 2, 3, 5, 7, 8, 10];
    const PROG_MAJOR = [0, 4, 5, 3];       // I V vi IV style, as scale-degree indexes below
    const PROG_MINOR = [0, 5, 2, 6];       // i VI III VII

    const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

    const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
    function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
    function dbOf(x) { return 20 * Math.log10(Math.max(x, 1e-12)); }
    function fmtTime(sec) { const s = Math.max(0, Math.round(sec)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
    function isMinor(scale) { return String(scale || "major").toLowerCase().indexOf("min") >= 0; }

    function makeRng(seed) {
        let a = (seed || 1) >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Typical rhythms (16 steps per bar) used only where the beat has NO part of that kind to copy.
    const STYLE_PATTERNS = {
        universal: { kick: [0, 8], snare: [4, 12], hat: "eighths" },
        clean: { kick: [0, 8], snare: [4, 12], hat: "eighths" },
        rnb: { kick: [0, 7, 10], snare: [4, 12], hat: "eighths" },
        rap: { kick: [0, 6, 10], snare: [4, 12], hat: "eighths" },
        trap: { kick: [0, 7, 11], snare: [8], hat: "sixteenths" },
        afrobeats: { kick: [0, 6, 10], snare: [4, 12], hat: "sixteenths" }
    };

    // How far under the beat's own level each added layer sits (dB), when the part is fully missing / only partly there.
    const LEVEL_DB = {
        kick: [10, 16], snare: [13, 19], hat: [19, 25], bass: [12, 18],
        chord: [18, 23], piano: [21, 26], strings: [24, 28],
        // Afrobeats pack
        clap: [14, 20], shaker: [20, 26], conga: [21, 27], logdrum: [12, 18], pluck: [21, 26]
    };

    // Same energy yardsticks as before: how loud each band is against the whole beat when the part is "ok".
    const REL_THRESHOLD = { kick: -8, snare: -12, hat: -18, bass: -6, chord: -8, pad: -12, piano: -10 };

    function createFillEngine(studio) {

        const design = studio.design, runCascade = studio.runCascade, fft = studio.fft;

        // ---------------------------------------------------------
        // Small DSP helpers
        // ---------------------------------------------------------

        function monoOf(chs) {
            if (chs.length === 1) return chs[0];
            const n = chs[0].length, m = new Float32Array(n);
            for (let c = 0; c < chs.length; c++) { const x = chs[c]; for (let i = 0; i < n; i++) m[i] += x[i] / chs.length; }
            return m;
        }

        function bandpass(x, lo, hi, sr) {
            hi = Math.min(hi, sr * 0.45);
            return runCascade(runCascade(x, [design.highpass(lo, sr), design.highpass(lo, sr)]),
                [design.lowpass(hi, sr), design.lowpass(hi, sr)]);
        }

        function frameRms(x, hop, frames) {
            const out = new Float32Array(frames);
            for (let f = 0; f < frames; f++) {
                let s = 0;
                const a = f * hop, b = a + hop;
                for (let i = a; i < b; i++) s += x[i] * x[i];
                out[f] = Math.sqrt(s / hop);
            }
            return out;
        }

        function flux(e) {
            const o = new Float32Array(e.length);
            for (let f = 1; f < e.length; f++) o[f] = e[f] > e[f - 1] ? e[f] - e[f - 1] : 0;
            return o;
        }

        function meanOf(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / Math.max(1, a.length); }

        function percentile(arr, p) {
            if (!arr.length) return 0;
            const s = Float64Array.from(arr).sort();
            return s[clamp(Math.floor(p * (s.length - 1)), 0, s.length - 1)];
        }

        function triSmooth(a, w) {
            const out = new Float32Array(a.length);
            for (let i = 0; i < a.length; i++) {
                let s = 0, ws = 0;
                for (let k = -w; k <= w; k++) { const j = i + k; if (j < 0 || j >= a.length) continue; const wt = w + 1 - Math.abs(k); s += a[j] * wt; ws += wt; }
                out[i] = s / ws;
            }
            return out;
        }

        function interp(a, pos) {
            const k = Math.floor(pos);
            if (k < 0 || k + 1 >= a.length) return 0;
            const f = pos - k;
            return a[k] * (1 - f) + a[k + 1] * f;
        }

        // ---------------------------------------------------------
        // 1. Beat grid: tempo + phase, searched coarse -> fine
        // ---------------------------------------------------------

        function gridScore(O, P, ph) {
            let s = 0, n = 0;
            for (let pos = ph; pos < O.length - 2; pos += P) { s += interp(O, pos); n++; }
            return n ? s / n : 0;
        }

        function bestPhase(O, P, step) {
            let best = -1, bestPh = 0;
            for (let ph = 0; ph < P; ph += step) {
                const s = gridScore(O, P, ph);
                if (s > best) { best = s; bestPh = ph; }
            }
            return { score: best, phase: bestPh };
        }

        function findGrid(Oraw, hopSec, bpm0) {

            const Oc = triSmooth(Oraw, 4), Of = triSmooth(Oraw, 1);
            const meanO = meanOf(Oraw) + 1e-12;

            // stage 1: +-3 % in 0.05 % steps on a broad onset curve
            let best = { score: -1, bpm: bpm0, phase: 0 };
            for (let d = -60; d <= 60; d++) {
                const bpm = bpm0 * (1 + d * 0.0005), P = 60 / bpm / hopSec;
                const r = bestPhase(Oc, P, 1);
                // tiny preference for the tempo that was passed in
                const sc = r.score * (1 - 0.0004 * Math.abs(d));
                if (sc > best.score) best = { score: sc, bpm: bpm, phase: r.phase };
            }
            // stage 2 and 3: narrow in on the exact tempo (long songs drift if it is off by even 0.01 %)
            const stages = [{ span: 0.0006, step: 0.00005, curve: Oc, ph: 0.5 }, { span: 0.00006, step: 0.000005, curve: Of, ph: 0.25 }];
            for (const st of stages) {
                const centre = best.bpm;
                let b2 = { score: -1, bpm: centre, phase: best.phase };
                for (let d = -st.span; d <= st.span + 1e-12; d += st.step) {
                    const bpm = centre * (1 + d), P = 60 / bpm / hopSec;
                    const r = bestPhase(st.curve, P, st.ph);
                    if (r.score > b2.score) b2 = { score: r.score, bpm: bpm, phase: r.phase };
                }
                best = b2;
            }

            const P = 60 / best.bpm / hopSec;
            const confidence = gridScore(Of, P, best.phase) / meanO;
            return { bpm: best.bpm, phaseFrames: best.phase, periodFrames: P, confidence: confidence };
        }

        // ---------------------------------------------------------
        // Chroma (pitch-class energy) per bar, key estimate, chord choice
        // ---------------------------------------------------------

        // Pitch-class energy of a stretch of audio, plus two "is there music here" measures:
        //  midTonal: how concentrated the 250-2000 Hz range is on a few notes (chords/pads/keys are; drums and noise are not)
        //  lowTonal: how concentrated 40-160 Hz is on one pitch (a bass line is; a kick's sweep is not)
        function chromaOfSegment(mono, sr, aSample, bSample, N) {
            const chroma = new Float64Array(12);
            const res = { chroma: chroma, midTonal: 0, lowTonal: 0, lowShareDb: -99, ok: false };
            const len = bSample - aSample;
            if (len < N / 2) return res;
            const windows = clamp(Math.floor(len / (N / 2)), 1, 8);
            const re = new Float64Array(N), im = new Float64Array(N);
            const hann = new Float64Array(N);
            for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
            const binHz = sr / N;
            let used = 0, bestShare = -999;
            for (let w = 0; w < windows; w++) {
                const start = Math.round(aSample + (len - N) * (windows === 1 ? 0.5 : w / (windows - 1)));
                if (start < 0 || start + N > mono.length) continue;
                for (let i = 0; i < N; i++) { re[i] = mono[start + i] * hann[i]; im[i] = 0; }
                fft(re, im);
                const tmp = new Float64Array(12), mid = new Float64Array(12);
                let tot = 0, midTot = 0;
                for (let k = Math.ceil(55 / binHz); k < Math.floor(1500 / binHz); k++) {
                    const mag = Math.pow(Math.sqrt(re[k] * re[k] + im[k] * im[k]), 0.7);
                    const pc = ((Math.round(69 + 12 * Math.log2(k * binHz / 440)) % 12) + 12) % 12;
                    tmp[pc] += mag; tot += mag;
                    if (k * binHz >= 250 && k * binHz <= 2000) { mid[pc] += mag; midTot += mag; }
                }
                if (tot > 0) for (let p = 0; p < 12; p++) chroma[p] += tmp[p] / tot;
                if (midTot > 0) { const m = Array.from(mid).sort((a, b) => b - a); res.midTonal += (m[0] + m[1] + m[2]) / midTot; }
                // low band: how much of the 40-140 Hz power sits at one pitch, and what share of the low-mid (40-800 Hz) power it is
                let pw = 0, maxP = 0, maxK = 0, totPw = 0;
                const kLo = Math.ceil(40 / binHz), kHi = Math.floor(140 / binHz), P = [];
                for (let k = kLo; k <= kHi; k++) { const q = re[k] * re[k] + im[k] * im[k]; P.push(q); pw += q; if (q > maxP) { maxP = q; maxK = k - kLo; } }
                for (let k = kLo; k < Math.floor(800 / binHz); k++) totPw += re[k] * re[k] + im[k] * im[k];
                // judged on the window where the low end is strongest (a staccato bass is silent between its notes)
                const share = 10 * Math.log10(Math.max(pw, 1e-30) / Math.max(totPw, 1e-30));
                if (share > bestShare) { bestShare = share; res.lowTonal = pw > 0 ? ((P[maxK - 1] || 0) + P[maxK] + (P[maxK + 1] || 0)) / pw : 0; }
                used++;
            }
            if (!used) return res;
            let sum = 0; for (let p = 0; p < 12; p++) sum += chroma[p];
            if (sum > 0) for (let p = 0; p < 12; p++) chroma[p] /= sum;
            res.midTonal /= used; res.lowShareDb = bestShare; res.ok = true;
            return res;
        }

        function estimateKey(chroma) {
            const corr = (a, b) => {
                const ma = meanOf(a), mb = meanOf(b); let n = 0, da = 0, db2 = 0;
                for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db2 += (b[i] - mb) ** 2; }
                return n / Math.sqrt(Math.max(1e-12, da * db2));
            };
            let best = { r: -2, rootPc: 0, scale: "major" };
            for (let root = 0; root < 12; root++) {
                const rot = new Float64Array(12);
                for (let i = 0; i < 12; i++) rot[i] = chroma[(i + root) % 12];
                const rM = corr(rot, KS_MAJOR), rm = corr(rot, KS_MINOR);
                if (rM > best.r) best = { r: rM, rootPc: root, scale: "major" };
                if (rm > best.r) best = { r: rm, rootPc: root, scale: "minor" };
            }
            return best;
        }

        // Best diatonic triad for one bar's chroma. margin = how clearly it beat the runner-up.
        function chooseChord(chroma, rootPc, scale) {
            const degs = isMinor(scale) ? MINOR : MAJOR;
            let best = null, second = -1e9;
            for (let d = 0; d < 7; d++) {
                const pcs = [0, 2, 4].map(o => (rootPc + degs[(d + o) % 7]) % 12);
                let inside = 0;
                for (const p of pcs) inside += chroma[p];
                const score = chroma[pcs[0]] * 1.0 + chroma[pcs[1]] * 0.8 + chroma[pcs[2]] * 0.7 - 0.25 * (1 - inside);
                if (!best || score > best.score) { if (best) second = best.score; best = { degree: d, pcs: pcs, score: score }; }
                else if (score > second) second = score;
            }
            best.margin = best.score - second;
            return best;
        }

        // ---------------------------------------------------------
        // 2. Analysis: grid, bars, per-bar presence of each instrument
        // ---------------------------------------------------------

        function analyze(beatChannels, sr, options) {

            const o = options || {};
            const mono = monoOf(beatChannels), n = mono.length;
            const hop = Math.max(1, Math.round(0.005 * sr)), frames = Math.floor(n / hop), hopSec = hop / sr;
            if (frames < 400) return null;

            const BANDS = {
                kick: [40, 110], snare: [180, 400], crack: [2000, 5000], hat: [6000, 12000],
                bass: [50, 250], low: [40, 160], chord: [300, 900], pad: [600, 2000], piano: [400, 2500], perc: [250, 1000]
            };
            const E = {};
            for (const k in BANDS) E[k] = frameRms(bandpass(mono, BANDS[k][0], BANDS[k][1], sr), hop, frames);
            E.full = frameRms(mono, hop, frames);
            E.snareCombo = new Float32Array(frames);
            for (let f = 0; f < frames; f++) E.snareCombo[f] = Math.sqrt(E.crack[f] ** 2 + (0.35 * E.snare[f]) ** 2);

            const F = { kick: flux(E.kick), snare: flux(E.snareCombo), hat: flux(E.hat), bass: flux(E.bass), perc: flux(E.perc), chord: flux(E.chord) };

            // --- grid ---
            const mk = meanOf(F.kick) + 1e-12, ms = meanOf(F.snare) + 1e-12, mh = meanOf(F.hat) + 1e-12, mb = meanOf(F.bass) + 1e-12;
            const mc = meanOf(F.chord) + 1e-12;
            const O = new Float32Array(frames);
            // chord changes are strong cues for where the bars start (they usually change on beat 1)
            for (let f = 0; f < frames; f++) O[f] = F.kick[f] / mk + F.snare[f] / ms + 0.6 * F.hat[f] / mh + 0.5 * F.bass[f] / mb + 0.5 * F.chord[f] / mc;
            const bpmIn = clamp(o.bpm || 90, 60, 180);
            const grid = findGrid(O, hopSec, bpmIn);
            const P = grid.periodFrames;

            // --- which of the four beats is beat 1 ---
            const lowO = triSmooth(F.kick, 1), bassO = triSmooth(F.bass, 1);
            const downScore = [0, 0, 0, 0], clapScore = [0, 0, 0, 0], snareO = triSmooth(F.snare, 1), chordO = triSmooth(F.chord, 2);
            let k = 0;
            for (let pos = grid.phaseFrames; pos < frames - 2; pos += P, k++) {
                downScore[k % 4] += interp(lowO, pos) / mk + 0.5 * interp(bassO, pos) / mb + 0.8 * interp(chordO, pos) / mc;
                clapScore[k % 4] += interp(snareO, pos) / ms;
            }
            // a clap or snare on beats 2 and 4 puts beat 1 one beat before each of them (weighted lightly: half-time styles differ)
            for (let i = 0; i < 4; i++) downScore[i] += 0.35 * (clapScore[(i + 1) % 4] + clapScore[(i + 3) % 4]) / 2;
            let b0 = 0;
            for (let i = 1; i < 4; i++) if (downScore[i] > downScore[b0]) b0 = i;
            const sorted = downScore.slice().sort((a, b) => b - a);
            const downConfident = sorted[0] > sorted[1] * 1.08;

            const barFrames = 4 * P;
            let s0 = grid.phaseFrames + b0 * P;                 // first beat 1 at or after frame 0 (within one bar)
            while (s0 >= barFrames) s0 -= barFrames;
            const barStartFrame = (j) => s0 + (j - 1) * barFrames;   // bar 0 is the partial bar before the first beat 1
            const nBars = Math.ceil((frames - s0) / barFrames) + 1;

            // --- bar by bar ---
            const bars = [];
            for (let j = 0; j < nBars; j++) {
                const fa = barStartFrame(j), fb = fa + barFrames;
                const a = Math.max(0, Math.round(fa)), b = Math.min(frames, Math.round(fb));
                if (b - a < barFrames * 0.35) { bars.push({ j: j, empty: true, fullDb: -120 }); continue; }
                const bar = { j: j, a: a, b: b, startFrame: fa };
                let sf = 0; for (let f = a; f < b; f++) sf += E.full[f] ** 2;
                bar.fullDb = dbOf(Math.sqrt(sf / (b - a)));
                bar.fullLin = Math.sqrt(sf / (b - a));
                bar.rel = {}; bar.peaks = {};
                // measured on the inside of the bar, so the neighbouring bars' note starts do not leak into this bar's levels
                const trimF = Math.round(0.05 * (b - a)), ra = a + trimF, rb = b - trimF;
                const names = { kick: E.kick, snare: E.snareCombo, hat: E.hat, bass: E.bass, low: E.low, chord: E.chord, pad: E.pad, piano: E.piano };
                for (const nm in names) {
                    let s = 0; for (let f = ra; f < rb; f++) s += names[nm][f] ** 2;
                    let sFull = 0; for (let f = ra; f < rb; f++) sFull += E.full[f] ** 2;
                    bar.rel[nm] = dbOf(Math.sqrt(s / (rb - ra))) - dbOf(Math.sqrt(sFull / (rb - ra)));
                }
                // how many separate hits does a percussive band make in this bar? A hit must jump well above the band's
                // own average level; the ripple of a sustained pad or bass note never does.
                const bandOf = { kick: E.kick, snare: E.snareCombo, hat: E.hat, perc: E.perc };
                const decayFrames = { kick: Math.round(0.12 / hopSec), snare: Math.round(0.08 / hopSec), hat: Math.round(0.04 / hopSec), perc: Math.round(0.06 / hopSec) };
                for (const nm of ["kick", "snare", "hat", "perc"]) {
                    const fl = F[nm], be = bandOf[nm];
                    let mx = 0, mean = 0; for (let f = a; f < b; f++) { if (fl[f] > mx) mx = fl[f]; mean += be[f]; }
                    mean /= (b - a);
                    const thr = Math.max(0.35 * mx, 0.6 * mean);
                    let count = 0, last = -99;
                    for (let f = a + 1; f < b - 1; f++) {
                        if (fl[f] > thr && fl[f] >= fl[f - 1] && fl[f] >= fl[f + 1] && f - last >= 4) {
                            // a drum hit multiplies the band's energy within a few frames; the ripple of a held note does not
                            let pre = 0, pc = 0; for (let k = f - 4; k < f; k++) if (k >= 0) { pre += be[k]; pc++; }
                            let post = 0; for (let k = f; k < Math.min(frames, f + 4); k++) if (be[k] > post) post = be[k];
                            // ...and dies away quickly. A bass note onset jumps too, but it rings on; a drum does not.
                            const dEnd = f + decayFrames[nm];
                            const decays = dEnd >= frames || be[dEnd] < 0.55 * post;
                            if (pc && post > 2.4 * (pre / pc) && decays) { count++; last = f; }
                        }
                    }
                    bar.peaks[nm] = count;
                    // Does one step of the bar stand out from the rest? A snare or clap is a hit that is clearly bigger than the
                    // others; a shaker or hat pattern is a row of equal hits, and a bass or kick only leaks a little into this band.
                    if (nm === "snare") {
                        const stepF = grid.periodFrames / 4, vals = [], kvals = [];
                        for (let st = 0; st < 16; st++) {
                            const c = Math.round(bar.startFrame + st * stepF);
                            let m = 0, km = 0;
                            for (let f2 = c - 2; f2 <= c + 2; f2++) if (f2 >= 0 && f2 < frames) { if (fl[f2] > m) m = fl[f2]; if (F.kick[f2] > km) km = F.kick[f2]; }
                            vals.push(m); kvals.push(km);
                        }
                        const sortedV = vals.slice().sort((x, y) => x - y), medV = sortedV[8], maxV = sortedV[15];
                        bar.snareContrast = maxV / Math.max(medV, 1e-12);
                        // an accented shaker has FOUR equally strong pushed hits; a snare or clap has one to three
                        bar.snareStandouts = vals.filter(v => v > 0.6 * maxV).length;
                        bar.snareHitFloor = maxV > 0.01 * bar.fullLin;       // a real hit is not tiny next to the beat itself
                    }
                }
                bars.push(bar);
            }

            const valid = bars.filter(b => !b.empty && b.fullDb > -60);
            const refDb = percentile(valid.map(b => b.fullDb), 0.8);
            for (const b of bars) b.on = !b.empty && b.fullDb > Math.max(-60, refDb - 16);

            // chroma + tonal measures first (needed for the harmony and bass checks)
            const N = 16384;
            const globalChroma = new Float64Array(12);
            for (const b of bars) {
                if (!b.on) continue;
                if (o.skipHarmony) { b.chroma = new Float64Array(12); b.midTonal = 0; b.lowTonal = 0; b.lowShareDb = -99; b.tonalOk = false; continue; }
                // analyse the inside of the bar, so the neighbouring bars' note starts and chord changes do not leak in
                const trim = Math.round(0.06 * (b.b - b.a) * hop);
                const seg = chromaOfSegment(mono, sr, Math.round(b.a * hop) + trim, Math.round(b.b * hop) - trim, N);
                b.chroma = seg.chroma; b.midTonal = seg.midTonal; b.lowTonal = seg.lowTonal; b.lowShareDb = seg.lowShareDb; b.tonalOk = seg.ok;
                for (let p = 0; p < 12; p++) globalChroma[p] += b.chroma[p];
            }

            // per-bar presence for every instrument: "ok" | "thin" | "missing"
            const PERC = { kick: 1, snare: 1, hat: 1 };
            for (const b of bars) {
                if (!b.on) continue;
                b.status = {};
                for (const nm of ["kick", "snare", "hat"]) {
                    // Judged mainly by the hits themselves (a real pattern with a drum-like decay). Level only breaks ties:
                    // a hit pattern that is very quiet against the whole beat still counts as thin.
                    const rel = b.rel[nm], thr = REL_THRESHOLD[nm];
                    const minHits = nm === "hat" ? 4 : (nm === "snare" ? 1 : 2);      // half-time snares hit once a bar
                    let st;
                    if (b.peaks[nm] >= minHits) st = rel >= thr - 14 ? 0 : 1;
                    else if (b.peaks[nm] >= 1 && rel >= thr - 8) st = 1;
                    else st = 2;
                    // a row of equal hits (shaker, hats) leaking into the snare band is not a snare or clap
                    if (nm === "snare" && st < 2 && (b.snareContrast < 2.2 || !b.snareHitFloor)) st = 2;
                    b.status[nm] = ["ok", "thin", "missing"][st];
                }
                // Bass. A kick alone cannot be told apart reliably from a kick plus a bass line, and adding a synth bass over a real
                // one is worse than missing one, so bass only counts as missing when the beat has almost no low end at all.
                b.status.bass = b.rel.low < -15 ? "missing" : (b.rel.low < -10 ? "thin" : "ok");
                // harmony (chords, pads, keys): notes concentrated on a few pitch classes in the mid range
                const hs = !b.tonalOk ? "missing" : (b.midTonal >= 0.39 ? "ok" : (b.midTonal >= 0.33 ? "thin" : "missing"));
                b.status.chord = b.status.pad = b.status.piano = hs;
                // hand percussion (congas, bongos, tumbao patterns): many short pitched hits in the mid range
                b.status.perc = b.peaks.perc >= 5 ? "ok" : (b.peaks.perc >= 3 ? "thin" : "missing");
                // drums that really play in this bar (a hit pattern, not leakage)
                b.percPresent = ["kick", "snare", "hat"].filter(nm => b.peaks[nm] >= (nm === "hat" ? 4 : 2) && b.status[nm] !== "missing").length;
            }

            // --- where does the groove really start? ---
            const onBars = bars.filter(b => b.on);
            const firstOn = onBars.length ? onBars[0].j : 0;
            let grooveStart = firstOn;
            const withDrums = onBars.filter(b => b.percPresent >= 1);
            if (withDrums.length >= Math.max(2, onBars.length * 0.25)) {
                // the beat has real percussion: the groove begins where it first holds for two bars in a row
                grooveStart = null;
                for (let i = 0; i < bars.length - 1; i++) {
                    if (bars[i].on && bars[i + 1].on && bars[i].percPresent >= 1 && bars[i + 1].percPresent >= 1) { grooveStart = bars[i].j; break; }
                }
                if (grooveStart === null) grooveStart = firstOn;
            } else {
                // No real percussion at all, so there is no rhythm cue. The groove begins where the bass line comes in (two bars
                // in a row); a beat with no bass either begins once the music is at full level.
                const bassOn = onBars.filter(b => b.status.bass === "ok");
                grooveStart = null;
                if (bassOn.length >= Math.max(2, onBars.length * 0.25)) {
                    for (let i = 0; i < bars.length - 1; i++) {
                        if (bars[i].on && bars[i + 1].on && bars[i].status.bass === "ok" && bars[i + 1].status.bass === "ok") { grooveStart = bars[i].j; break; }
                    }
                } else {
                    for (let i = 0; i < bars.length - 1; i++) {
                        if (bars[i].on && bars[i + 1].on && bars[i].fullDb > refDb - 5 && bars[i + 1].fullDb > refDb - 5) { grooveStart = bars[i].j; break; }
                    }
                }
                if (grooveStart === null) grooveStart = firstOn;
            }
            // start the groove on a bar line that is on, never in the partial bar before the first beat 1
            grooveStart = Math.max(grooveStart, 1);

            // a bar belongs to the groove if it is after the start AND (when the beat has real drums) the drums are playing in it.
            // Deliberate breaks, where the real drums drop out, are therefore left alone.
            const beatHasPerc = withDrums.length >= Math.max(2, onBars.length * 0.25);
            for (const b of bars) b.groove = !!b.on && b.j >= grooveStart && (!beatHasPerc || b.percPresent >= 1);

            // --- key ---
            let key = { rootPc: o.rootPc || 0, scale: o.scale || "major", source: "given" };
            if (o.keyKnown === false && !o.skipHarmony) {
                const est = estimateKey(globalChroma);
                key = { rootPc: est.rootPc, scale: est.scale, source: "estimated", r: est.r };
            }

            return {
                sr: sr, n: n, hop: hop, hopSec: hopSec, frames: frames, E: E, F: F, O: O,
                grid: grid, b0: b0, downConfident: downConfident, s0: s0, barFrames: barFrames, barStartFrame: barStartFrame,
                bars: bars, refDb: refDb, firstOn: firstOn, grooveStart: grooveStart, key: key, mono: mono
            };
        }

        // ---------------------------------------------------------
        // 3. Planning: what to add, in which bars
        // ---------------------------------------------------------

        function classify(A, inst, eligible) {
            const els = A.bars.filter(eligible);
            if (!els.length) return { cls: "ok", bars: [], fracPresent: 1, eligible: 0 };
            const present = els.filter(b => b.status[inst] === "ok").length;
            const frac = present / els.length;
            let cls = frac >= 0.6 ? "ok" : (frac <= 0.25 ? "missing" : "partial");
            // a part that is "thin" in most bars (but never gone) gets light support in those bars
            return { cls: cls, fracPresent: frac, eligible: els.length, bars: els };
        }

        // The 16-step rhythm the real part plays, from the bars where it is present. null if none can be learned.
        function learnPattern(A, inst, presentBars) {
            if (presentBars.length < 3) return null;
            const fl = A.F[inst === "snare" ? "snare" : inst], P = A.grid.periodFrames, stepF = P / 4;
            const freq = new Float64Array(16);
            for (const b of presentBars) {
                let mx = 0; for (let f = b.a; f < b.b; f++) if (fl[f] > mx) mx = fl[f];
                if (mx <= 0) continue;
                for (let s = 0; s < 16; s++) {
                    const c = b.startFrame + s * stepF;
                    let m = 0;
                    for (let f = Math.round(c) - 2; f <= Math.round(c) + 2; f++) if (f >= 0 && f < fl.length && fl[f] > m) m = fl[f];
                    if (m > 0.35 * mx) freq[s]++;
                }
            }
            const steps = [];
            for (let s = 0; s < 16; s++) if (freq[s] / presentBars.length >= 0.5) steps.push(s);
            return steps.length >= 1 && steps.length <= 12 ? steps : null;
        }

        function plan(A, options) {

            const style = STYLE_PATTERNS[options.style] ? options.style : "universal";
            const def = STYLE_PATTERNS[style];
            const grooveBar = (b) => b.groove;
            const anyBar = (b) => b.on;

            const items = {};
            const detection = { presence: {} };

            const classes = {
                kick: classify(A, "kick", grooveBar), snare: classify(A, "snare", grooveBar), hat: classify(A, "hat", grooveBar),
                bass: classify(A, "bass", grooveBar), chord: classify(A, "chord", anyBar), pad: classify(A, "pad", anyBar), piano: classify(A, "piano", anyBar),
                perc: classify(A, "perc", grooveBar)
            };
            const afro = options.style === "afrobeats", amapiano = afro && options.subgenre === "amapiano";
            for (const nm in classes) detection.presence[nm] = classes[nm].cls === "ok" ? "ok" : (classes[nm].cls === "partial" ? "thin" : "missing");

            const lines = [];
            const fillBars = (c) => c.cls === "missing" ? c.bars : (c.cls === "partial" ? c.bars.filter(b => b.status[c.inst] !== "ok") : []);

            for (const nm in classes) classes[nm].inst = nm;

            // percussion
            for (const nm of ["kick", "snare", "hat"]) {
                const c = classes[nm];
                const targets = fillBars(c);
                if (!targets.length) continue;
                let steps = null, learned = false;
                if (c.cls === "partial") {
                    steps = learnPattern(A, nm, c.bars.filter(b => b.status[nm] === "ok"));
                    learned = !!steps;
                }
                let hatMode = null;
                if (!steps) {
                    if (nm === "kick") steps = def.kick.slice();
                    else if (nm === "snare") steps = def.snare.slice();
                    else { hatMode = def.hat; steps = []; for (let s = 0; s < 16; s += (hatMode === "sixteenths" ? 1 : 2)) steps.push(s); }
                }
                // Afrobeats uses a clap where other styles use a snare, and a shaker where they use hats
                const name = afro && nm === "snare" ? "clap" : (afro && nm === "hat" ? "shaker" : nm);
                items[name] = { inst: name, level: c.cls === "missing" ? 0 : 1, bars: targets, steps: steps, learned: learned, hatMode: hatMode };
            }
            // hand percussion (Afrobeats): congas/bongos in a tumbao-style pattern when the beat has none
            // (it cannot be told apart reliably from claps and shakers, so it is only added when the beat has no other percussion either)
            if (afro && classes.perc.cls !== "ok" && classes.hat.cls !== "ok" && classes.snare.cls !== "ok") {
                const c = classes.perc, targets = fillBars(c);
                if (targets.length) items.conga = { inst: "conga", level: c.cls === "missing" ? 0 : 1, bars: targets, steps: [3, 6, 7, 10, 11, 14] };
            }

            // harmony (needs a chord for each bar)
            const chordNeeded = classes.chord.cls !== "ok" || classes.bass.cls !== "ok";
            let chords = null, followed = 0, fallback = 0;
            if (chordNeeded) {
                chords = {};
                const degs = isMinor(A.key.scale) ? MINOR : MAJOR, prog = isMinor(A.key.scale) ? PROG_MINOR : PROG_MAJOR;
                const base = A.firstOn;
                for (const b of A.bars) {
                    if (!b.on) continue;
                    const pick = chooseChord(b.chroma, A.key.rootPc, A.key.scale);
                    let ch;
                    if (pick.margin >= 0.06) { ch = pick; followed++; }
                    else {
                        const d = prog[((b.j - base) % 4 + 4) % 4];
                        ch = { degree: d, pcs: [0, 2, 4].map(oo => (A.key.rootPc + degs[(d + oo) % 7]) % 12) };
                        fallback++;
                    }
                    chords[b.j] = ch;
                }
            }

            if (classes.bass.cls === "missing") {
                const c = classes.bass;
                // Amapiano's signature low end is the log drum, not a sustained bass
                const bn = amapiano ? "logdrum" : "bass";
                items[bn] = { inst: bn, level: c.cls === "missing" ? 0 : 1, bars: fillBars(c) };
            }
            // chords, pads and keys are judged together: if the beat has harmony, nothing harmonic is added
            const hc = classes.chord;
            if (hc.cls === "missing") {
                const soft = options.style === "universal" || options.style === "rnb" || options.style === "clean";
                items.chord = { inst: "chord", level: 0, bars: fillBars(hc) };
                if (soft) items.piano = { inst: "piano", level: 0, bars: fillBars(hc) };
                items.strings = { inst: "strings", level: 0, bars: fillBars(hc) };
                if (afro) items.pluck = { inst: "pluck", level: 0, bars: fillBars(hc) };     // highlife-style guitar pluck
            } else if (hc.cls === "partial") {
                items.chord = { inst: "chord", level: 1, bars: fillBars(hc) };
            }
            for (const nm in items) if (!items[nm].bars.length) delete items[nm];

            return { items: items, classes: classes, chords: chords, followed: followed, fallback: fallback, detection: detection, style: style };
        }

        // ---------------------------------------------------------
        // 4. Synthesis
        // ---------------------------------------------------------

        function env(t, a, d, s, r, dur) {
            if (t < 0) return 0;
            if (t < a) return t / Math.max(1e-4, a);
            if (t < a + d) return 1 - (1 - s) * ((t - a) / Math.max(1e-4, d));
            if (t < dur - r) return s;
            if (t < dur) return s * (1 - (t - (dur - r)) / Math.max(1e-4, r));
            return 0;
        }

        function synthKick(sr, rnd) {
            const n = Math.round(0.35 * sr), out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const t = i / sr;
                const f = 150 * Math.exp(-t * 18) + 45;
                const amp = Math.exp(-t * 9) * (t < 0.002 ? t / 0.002 : 1);
                out[i] = Math.sin(2 * Math.PI * f * t) * amp * 0.9;
                if (t < 0.01) out[i] += (rnd() * 2 - 1) * Math.exp(-t * 120) * 0.25;
            }
            return out;
        }
        function synthSnare(sr, rnd) {
            const n = Math.round(0.28 * sr), out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const t = i / sr;
                out[i] = (Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 20) * 0.35 + (rnd() * 2 - 1) * Math.exp(-t * 14) * 0.65) * 0.55;
            }
            return out;
        }
        function synthHat(sr, rnd, open) {
            const n = Math.round((open ? 0.18 : 0.08) * sr), out = new Float32Array(n);
            const decay = open ? 8 : 28;
            let hp = 0;
            for (let i = 0; i < n; i++) {
                const t = i / sr;
                const noise = rnd() * 2 - 1;
                hp = noise - hp * 0.95;
                out[i] = hp * Math.exp(-t * decay) * (open ? 0.22 : 0.18);
            }
            return out;
        }
        function synthBass(sr, freq, durSec) {
            const n = Math.max(1, Math.round(durSec * sr)), out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const t = i / sr, amp = env(t, 0.01, 0.08, 0.7, Math.min(0.12, durSec * 0.4), durSec);
                const ph = 2 * Math.PI * freq * t;
                out[i] = (Math.sin(ph) * 0.75 + Math.sin(ph * 2) * 0.18 + Math.sin(ph * 3) * 0.07) * amp;
            }
            return out;
        }
        function synthChord(sr, freqs, durSec, kind) {
            const n = Math.max(1, Math.round(durSec * sr)), out = new Float32Array(n);
            const v = 1 / Math.max(1, freqs.length);
            for (let i = 0; i < n; i++) {
                const t = i / sr;
                let amp, s = 0;
                if (kind === "piano") amp = env(t, 0.005, 0.25, 0.35, 0.35, durSec);
                else if (kind === "strings") amp = env(t, 0.08, 0.3, 0.8, 0.4, durSec);
                else amp = env(t, 0.04, 0.2, 0.7, 0.25, durSec);
                for (const f of freqs) {
                    const ph = 2 * Math.PI * f * t;
                    if (kind === "piano") s += Math.sin(ph) + 0.4 * Math.sin(ph * 2) + 0.15 * Math.sin(ph * 3);
                    else if (kind === "strings") s += Math.sin(ph) * 0.5 + Math.sin(ph * 2.01) * 0.3 + Math.sin(ph * 3.02) * 0.15;
                    else s += Math.sin(ph) * 0.55 + Math.sin(ph * 2) * 0.25 + Math.sin(ph * 3) * 0.12;
                }
                out[i] = s * amp * v;
            }
            return out;
        }

        // --- Afrobeats pack ---
        function synthClap(sr, rnd) {
            const n = Math.round(0.16 * sr), out = new Float32Array(n);
            const aLp = 1 - Math.exp(-2 * Math.PI * 4200 / sr), aHp = 1 - Math.exp(-2 * Math.PI * 900 / sr);
            let lp = 0, hp = 0;
            const bursts = [0, 0.009, 0.019];
            for (let i = 0; i < n; i++) {
                const t = i / sr;
                lp += aLp * ((rnd() * 2 - 1) - lp); hp += aHp * (lp - hp);
                let env = 0.55 * Math.exp(-Math.max(0, t - 0.028) * 28) * (t >= 0.028 ? 1 : 0);
                for (const b of bursts) if (t >= b && t < b + 0.008) env = Math.max(env, 0.9 * Math.exp(-(t - b) * 220));
                out[i] = (lp - hp) * env * 1.4;
            }
            return out;
        }
        function synthShaker(sr, rnd) {
            const n = Math.round(0.07 * sr), out = new Float32Array(n);
            let prev = 0;
            for (let i = 0; i < n; i++) {
                const t = i / sr, noise = rnd() * 2 - 1;
                const hp = noise - prev * 0.75; prev = noise;
                out[i] = hp * Math.min(1, t / 0.004) * Math.exp(-t * 42) * 0.2;
            }
            return out;
        }
        function synthConga(sr, freq, slap, rnd) {
            const n = Math.round(0.28 * sr), out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const t = i / sr, f = freq * (1 + 0.22 * Math.exp(-t * 70));
                let v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * (slap ? 26 : 16)) + 0.25 * Math.sin(2 * Math.PI * f * 2.3 * t) * Math.exp(-t * 40);
                if (slap && t < 0.006) v += (rnd() * 2 - 1) * Math.exp(-t * 500) * 0.8;
                out[i] = v * 0.7;
            }
            return out;
        }
        function synthLogDrum(sr, freq, durSec, rnd) {
            const n = Math.max(1, Math.round(Math.min(durSec, 0.4) * sr)), out = new Float32Array(n);
            let phase = 0;
            for (let i = 0; i < n; i++) {
                const t = i / sr, f = freq * (1 + 0.16 * Math.exp(-t * 32));
                phase += 2 * Math.PI * f / sr;
                const amp = Math.min(1, t / 0.002) * Math.exp(-t * 8.5);
                let v = Math.sin(phase) + 0.38 * Math.sin(2 * phase) + 0.14 * Math.sin(3 * phase);
                v = Math.tanh(1.6 * v) * 0.62;
                if (t < 0.003) v += (rnd() * 2 - 1) * 0.25;
                out[i] = v * amp;
            }
            return out;
        }
        function synthPluck(sr, freq, durSec, rnd) {            // Karplus-Strong string
            const n = Math.max(1, Math.round(durSec * sr)), out = new Float32Array(n);
            const N = Math.max(2, Math.round(sr / freq)), buf = new Float32Array(N);
            let prev = 0;
            for (let i = 0; i < N; i++) { const v = rnd() * 2 - 1; buf[i] = 0.5 * (v + prev); prev = v; }   // softened start = rounder pluck
            let pos = 0;
            for (let i = 0; i < n; i++) {
                const cur = buf[pos], nxt = buf[(pos + 1) % N];
                buf[pos] = 0.5 * (cur + nxt) * 0.996;
                out[i] = cur * Math.min(1, i / (0.002 * sr)) * Math.min(1, (n - i) / (0.02 * sr));
                pos = (pos + 1) % N;
            }
            return out;
        }

        function addHit(L, R, hit, at, gL, gR) {
            for (let i = 0; i < hit.length; i++) {
                const k = at + i;
                if (k < 0 || k >= L.length) continue;
                L[k] += hit[i] * gL; R[k] += hit[i] * gR;
            }
        }

        // nearest triad voicing (root position or inversion) to a target centre, for smooth chord changes
        function voice(pcs, centre, lo, hi) {
            let best = null;
            for (let inv = 0; inv < 3; inv++) {
                const order = pcs.slice(inv).concat(pcs.slice(0, inv));
                const notes = [];
                let prev = lo - 1;
                for (const pc of order) {
                    let m = lo + ((pc - lo) % 12 + 12) % 12;
                    while (m <= prev) m += 12;
                    notes.push(m); prev = m;
                }
                if (notes[notes.length - 1] > hi) continue;
                const c = notes.reduce((a, b) => a + b, 0) / notes.length;
                if (!best || Math.abs(c - centre) < best.d) best = { notes: notes, c: c, d: Math.abs(c - centre) };
            }
            if (!best) { const notes = pcs.map(pc => lo + ((pc - lo) % 12 + 12) % 12).sort((a, b) => a - b); best = { notes: notes, c: notes.reduce((a, b) => a + b, 0) / notes.length }; }
            return best;
        }

        function bassMidi(rootPc) { let m = 36 + rootPc; if (m < 36) m += 12; if (m > 47) m -= 12; return m; }   // C2..B2

        function render(A, P, options) {

            const sr = A.sr, n = A.n;
            const rnd = makeRng(20240601);
            const tune = Math.pow(2, (options.tuningCents || 0) / 1200);
            const barSec = A.barFrames * A.hopSec, stepFrames = A.grid.periodFrames / 4;
            const stepSample = (b, s) => Math.round((b.startFrame + s * stepFrames) * A.hop);
            const barEndSample = (b) => Math.round((b.startFrame + A.barFrames) * A.hop);

            // follow the beat's own dynamics: louder bars get a little more, quieter a little less
            const follow = (b) => clamp(Math.pow(10, (b.fullDb - A.refDb) * 0.7 / 20), 0.5, 1.4);

            const layers = {};
            const make = (name) => (layers[name] = { L: new Float32Array(n), R: new Float32Array(n), used: [] });

            const kickHit = synthKick(sr, rnd), snareHit = synthSnare(sr, rnd);
            const hatClosed = synthHat(sr, rnd, false), hatOpen = synthHat(sr, rnd, true);
            const clapHit = synthClap(sr, rnd), shakerHit = synthShaker(sr, rnd);
            const congaLow = synthConga(sr, 185 * tune, false, rnd), congaHigh = synthConga(sr, 270 * tune, false, rnd), congaSlap = synthConga(sr, 300 * tune, true, rnd);

            // the real kick steps (when the kick is present in the beat) so the bass can lock to them
            const realKick = P.classes.kick.cls === "ok" ? learnPattern(A, "kick", P.classes.kick.bars.filter(b => b.status.kick === "ok")) : null;

            let centrePad = 58, centrePiano = 64;

            for (const name of Object.keys(P.items)) {
                const it = P.items[name], lay = make(name);
                for (const b of it.bars) {
                    const f = follow(b);
                    lay.used.push(b);

                    if (name === "kick" || name === "snare" || name === "clap") {
                        const hit = name === "kick" ? kickHit : (name === "clap" ? clapHit : snareHit);
                        for (const s of it.steps) {
                            const vel = (s % 4 === 0 ? 1 : 0.85) * (0.94 + 0.06 * rnd()) * f;
                            addHit(lay.L, lay.R, hit, stepSample(b, s), vel, vel * (name === "snare" ? 0.95 : 1));
                        }
                    } else if (name === "shaker") {
                        // the classic Afrobeats shaker: constant 16ths, the off-beats pushed forward
                        for (const s of it.steps) {
                            const accent = s % 4 === 2 ? 0.9 : (s % 4 === 0 ? 0.55 : 0.4);
                            const vel = accent * (0.92 + 0.08 * rnd()) * f, left = (s % 2 === 0) ? 1 : 0.8;
                            addHit(lay.L, lay.R, shakerHit, stepSample(b, s), vel * left, vel * (left === 1 ? 0.8 : 1));
                        }
                    } else if (name === "conga") {
                        it.steps.forEach((s, idx) => {
                            const high = idx % 3 !== 0, slap = s === 7 || s === 14;
                            const hit = slap ? congaSlap : (high ? congaHigh : congaLow);
                            const vel = (slap ? 0.9 : 0.7) * (0.9 + 0.1 * rnd()) * f;
                            addHit(lay.L, lay.R, hit, stepSample(b, s), vel * (high ? 0.7 : 1), vel * (high ? 1 : 0.7));
                        });
                    } else if (name === "logdrum" || name === "pluck") {
                        const ch = P.chords && P.chords[b.j];
                        if (!ch) continue;
                        if (name === "logdrum") {
                            const root = ch.pcs[0], fifth = ch.pcs[2];
                            const m = (pc) => 38 + (((pc - 38) % 12) + 12) % 12;
                            [[0, root], [3, root], [6, fifth], [10, root], ...(b.j % 2 ? [[12, fifth]] : [])].forEach(([s, pc]) => {
                                const hz = midiToHz(m(pc)) * tune;
                                addHit(lay.L, lay.R, synthLogDrum(sr, hz, 0.3, rnd), stepSample(b, s), f, f);
                            });
                        } else {
                            const v = voice(ch.pcs, 66, 60, 78), seq = [0, 1, 2, 1, 2, 1], steps = [0, 3, 6, 8, 11, 14];
                            steps.forEach((s, idx) => {
                                const note = v.notes[seq[idx] % v.notes.length] + (idx === 2 ? 12 : 0);
                                const hz = midiToHz(note) * tune, vel = (s % 4 === 0 ? 1 : 0.8) * f;
                                addHit(lay.L, lay.R, synthPluck(sr, hz, 0.4, rnd), stepSample(b, s), vel * 0.9, vel * 1.1);
                            });
                        }
                    } else if (name === "hat") {
                        for (const s of it.steps) {
                            const open = it.hatMode === "eighths" && s === 14 && (b.j % 2 === 1);
                            const accent = s % 4 === 0 ? 1 : (s % 2 === 0 ? 0.75 : 0.55);
                            const vel = accent * (0.9 + 0.1 * rnd()) * f;
                            const left = (s % 4 < 2) ? 1 : 0.75;
                            addHit(lay.L, lay.R, open ? hatOpen : hatClosed, stepSample(b, s), vel * left, vel * (left === 1 ? 0.75 : 1));
                        }
                    } else if (name === "bass") {
                        const ch = P.chords && P.chords[b.j];
                        if (!ch) continue;
                        const hz = midiToHz(bassMidi(ch.pcs[0])) * tune;
                        const kickSteps = (realKick && realKick.length ? realKick : (P.items.kick ? P.items.kick.steps : [0, 10])).slice(0, 4);
                        const steps = kickSteps.length ? kickSteps : [0];
                        steps.forEach((s, idx) => {
                            const nextS = idx + 1 < steps.length ? steps[idx + 1] : 16;
                            const durSec = clamp((nextS - s) * stepFrames * A.hopSec * 0.92, 0.12, barSec * 0.95);
                            addHit(lay.L, lay.R, synthBass(sr, hz, durSec), stepSample(b, s), f, f);
                        });
                    } else {
                        const ch = P.chords && P.chords[b.j];
                        if (!ch) continue;
                        const isPiano = name === "piano", kind = isPiano ? "piano" : (name === "strings" ? "strings" : "pad");
                        const v = isPiano ? voice(ch.pcs, centrePiano, 60, 76) : voice(ch.pcs, centrePad, 50, 66);
                        if (isPiano) centrePiano = v.c; else if (name === "chord") centrePad = v.c;
                        const freqs = v.notes.map(m => midiToHz(m) * tune);
                        const stabs = isPiano ? [0, 8] : [0];
                        for (const s of stabs) {
                            const dur = ((isPiano ? 8 : 16) * stepFrames * A.hopSec) * (kind === "pad" ? 0.98 : 0.95);
                            const chord = synthChord(sr, freqs, dur, kind);
                            addHit(lay.L, lay.R, chord, stepSample(b, s), (name === "strings" ? 0.95 : 0.9) * f, (name === "strings" ? 1.05 : 1.1) * f);
                        }
                    }
                }
            }

            // set every layer relative to the beat's own loudness
            let onE = 0, onN = 0;
            for (const b of A.bars) if (b.on) for (let f = b.a; f < b.b; f++) { onE += A.E.full[f] ** 2; onN++; }
            const beatRms = Math.sqrt(onE / Math.max(1, onN));
            const mul = clamp((options.strength != null ? options.strength : 0.75) / 0.75, 0.33, 1.6);

            const outL = new Float32Array(n), outR = new Float32Array(n);
            const balance = {};
            for (const name of Object.keys(layers)) {
                const lay = layers[name], it = P.items[name];
                let e = 0, cnt = 0;
                for (const b of lay.used) {
                    const a = Math.round(b.a * A.hop), z = Math.min(n, Math.round(b.b * A.hop));
                    for (let i = a; i < z; i++) { e += lay.L[i] ** 2 + lay.R[i] ** 2; cnt += 2; }
                }
                const rms = Math.sqrt(e / Math.max(1, cnt));
                if (rms <= 0) continue;
                const off = LEVEL_DB[name][it.level];
                const g = (beatRms * Math.pow(10, -off / 20) * mul) / rms;
                balance[name] = dbOf(g);
                for (let i = 0; i < n; i++) { outL[i] += lay.L[i] * g; outR[i] += lay.R[i] * g; }
            }
            return { channels: [outL, outR], beatRms: beatRms };
        }

        // ---------------------------------------------------------
        // Public API
        // ---------------------------------------------------------

        function describeBars(bars) {
            if (!bars.length) return "";
            const sorted = bars.map(b => b.j).sort((a, b) => a - b);
            return sorted[0] + "-" + sorted[sorted.length - 1];
        }

        function fillMissing(beatChannels, sr, options) {

            const o = Object.assign({ bpm: 90, rootPc: 0, scale: "major", strength: 0.75, style: "universal", keyKnown: true, tuningCents: 0 }, options || {});
            const report = [];

            let A;
            try { A = analyze(beatChannels, sr, o); } catch (e) { A = null; }
            if (!A) {
                report.push("Checked for missing instruments, but the beat was too short to analyze, so nothing was added.");
                return { channels: beatChannels, report: report, detection: null, added: [] };
            }

            const P = plan(A, o);
            const names = { kick: "kick", snare: "snare", hat: "hats", bass: "bass", chord: "chords", piano: "piano", strings: "soft strings",
                clap: "claps", shaker: "shaker", conga: "congas", logdrum: "log drum", pluck: "plucked guitar" };
            const added = Object.keys(P.items).map(k => (P.items[k].level ? "light " : "") + names[k]);

            const detection = {
                presence: P.detection.presence,
                grid: { bpm: A.grid.bpm, bpmGiven: o.bpm, confidence: A.grid.confidence, firstDownbeatSec: A.barStartFrame(1) * A.hopSec, downbeatConfident: A.downConfident },
                grooveStartSec: A.barStartFrame(A.grooveStart) * A.hopSec,
                grooveStartBar: A.grooveStart,
                key: A.key,
                bars: A.bars.length
            };

            if (!added.length) {
                report.push("Checked for missing instruments — beat already feels full enough, nothing added.");
                return { channels: beatChannels, report: report, detection: detection, added: added, fillChannels: null };
            }

            const R = render(A, P, o);
            const n = A.n;
            const mixed = beatChannels.map((ch, c) => {
                const src = R.channels[c === 0 ? 0 : 1], y = new Float32Array(n);
                for (let i = 0; i < n; i++) y[i] = ch[i] + src[i];
                return y;
            });
            let peak = 0;
            for (const ch of mixed) for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
            if (peak > 0.97) { const sc = 0.97 / peak; for (const ch of mixed) for (let i = 0; i < n; i++) ch[i] *= sc; }

            const g = detection.grid;
            report.push(`Locked onto the beat's grid at ${g.bpm.toFixed(2)} BPM` + (Math.abs(g.bpm - o.bpm) > 0.2 ? ` (the detected ${o.bpm.toFixed(1)} was a little off)` : "") +
                `, first bar line at ${fmtTime(g.firstDownbeatSec)}.` + (g.confidence < 1.6 ? " The beat's rhythm is not very clear, so timing may be less exact." : ""));
            report.push(`The groove starts at ${fmtTime(detection.grooveStartSec)} — nothing was added to the intro before it, to silence, or to breaks.`);
            const parts = Object.keys(P.items).map(k => `${names[k]} (${P.items[k].level ? "support in " : ""}bars ${describeBars(P.items[k].bars)}${P.items[k].learned ? ", copying the real rhythm" : ""})`);
            report.push("Added: " + parts.join("; ") + ".");
            if (P.chords) report.push(`Harmony: followed the beat's own chords in ${P.followed} bar${P.followed === 1 ? "" : "s"}` + (P.fallback ? `, used the key's standard progression in ${P.fallback}` : "") +
                ` (key ${NOTE_NAMES[A.key.rootPc]} ${A.key.scale}${A.key.source === "estimated" ? ", estimated from the audio" : ""}).`);
            report.push("Fill is mixed under the real beat, set from the beat's own loudness (optional synth support, not a full arrangement).");

            return { channels: mixed, report: report, detection: detection, added: added, fillChannels: R.channels, plan: P, analysis: A };
        }

        function detectInstruments(beatChannels, sr, options) {
            const A = analyze(beatChannels, sr, Object.assign({ bpm: 90 }, options || {}));
            if (!A) return null;
            return plan(A, Object.assign({ style: "universal" }, options || {})).detection;
        }

        return { fillMissing, detectInstruments, analyze, plan };
    }

    if (typeof window !== "undefined" && window.VocalVaultStudio && window.VocalVaultStudio.engine) {
        const eng = createFillEngine(window.VocalVaultStudio.engine);
        window.VocalVaultFill = { detectInstruments: eng.detectInstruments, fillMissing: eng.fillMissing, engine: eng };
    }
    if (typeof module !== "undefined") module.exports = { createFillEngine: createFillEngine };

})(typeof window !== "undefined" ? window : this);
