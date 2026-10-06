/* =========================================================
   VOCAL VAULT — CLEAN-UP & TIMING

   Two optional steps, both OFF unless the user ticks them, because
   noise and loose timing are sometimes part of the performance:

   1. Noise reduction   Spectral subtraction. The noise profile is
                        learned from the quietest parts of the vocal.
   2. Timing            Finds the beat's grid, finds where each syllable
                        starts in the vocal, and nudges the ones that
                        are slightly early or late onto the grid.
                        Syllables that are far off the grid are left
                        alone (that is groove, not a slip).

   Both engines live in factory functions so they can be stringified
   into a Web Worker. createPrepEngine needs the tune engine from
   pitchcorrect.js for pitch tracking and the time-warp renderer.
   ========================================================= */

function createDenoiseEngine() {

    // ---------- FFT ----------
    const cache = {};
    function fftFor(N) {
        if (cache[N]) return cache[N];
        const levels = Math.round(Math.log2(N));
        const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2), rev = new Uint32Array(N);
        for (let k = 0; k < N / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / N); sin[k] = Math.sin(2 * Math.PI * k / N); }
        for (let i = 0; i < N; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (levels - 1));
        return (cache[N] = function (re, im) {
            for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
            for (let size = 2; size <= N; size <<= 1) {
                const half = size >> 1, step = N / size;
                for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
                    const a = i + j, b = a + half;
                    const tr = re[b] * cos[k] + im[b] * sin[k], ti = im[b] * cos[k] - re[b] * sin[k];
                    re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
                }
            }
        });
    }

    const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));

    // Cleans one channel. Returns { out, noiseDb, reductionDb } or { skipped: reason }.
    function cleanChannel(x, sr, o) {

        const N = 2048, hop = 512, bins = N / 2 + 1, fft = fftFor(N);
        const n = x.length;
        const frames = Math.max(0, Math.floor((n - N) / hop) + 1);
        if (frames < 20) return { skipped: "too short to measure the noise" };

        const win = new Float64Array(N);
        for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));

        // pass 1: power spectra and a time-domain level per frame
        const P = new Array(frames), rms = new Float64Array(frames);
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let f = 0; f < frames; f++) {
            let e = 0;
            for (let i = 0; i < N; i++) { const v = x[f * hop + i]; e += v * v; re[i] = v * win[i]; im[i] = 0; }
            rms[f] = Math.sqrt(e / N);
            fft(re, im);
            const p = new Float32Array(bins);
            for (let k = 0; k < bins; k++) p[k] = re[k] * re[k] + im[k] * im[k];
            P[f] = p;
        }

        // the noise is whatever the quietest 10% of the recording looks like
        const order = Array.from(rms.keys()).sort((a, b) => rms[a] - rms[b]);
        const take = Math.max(10, Math.floor(frames * 0.10));
        const noiseFrames = order.slice(0, take);
        const noiseRms = noiseFrames.reduce((s, f) => s + rms[f], 0) / take;
        const loudRms = rms[order[Math.floor(frames * 0.9)]];

        const noiseDb = toDb(noiseRms);
        if (noiseDb < o.cleanBelowDb) return { skipped: `already clean (noise floor ${noiseDb.toFixed(0)} dBFS)`, noiseDb };
        if (toDb(loudRms) - noiseDb < 10) return { skipped: "no clear gap between the noise and the singing", noiseDb };

        const noise = new Float64Array(bins);
        for (const f of noiseFrames) for (let k = 0; k < bins; k++) noise[k] += P[f][k] / take;
        // smooth the profile across frequency so one lucky bin does not decide
        const sm = new Float64Array(bins);
        for (let k = 0; k < bins; k++) { let s = 0, c = 0; for (let d = -3; d <= 3; d++) { const j = k + d; if (j >= 0 && j < bins) { s += noise[j]; c++; } } sm[k] = s / c; }

        // pass 2: gains, smoothed so the leftover noise does not twinkle
        const floor = Math.pow(10, -o.maxReductionDb / 20);
        const alpha = o.oversubtract;
        const out = new Float32Array(n), wsum = new Float32Array(n);
        const gPrev = new Float64Array(bins).fill(1), g = new Float64Array(bins), gs = new Float64Array(bins);

        for (let f = 0; f < frames; f++) {

            for (let i = 0; i < N; i++) { re[i] = x[f * hop + i] * win[i]; im[i] = 0; }
            fft(re, im);

            for (let k = 0; k < bins; k++) {
                const p = P[f][k] + 1e-20;
                g[k] = Math.max(floor, Math.sqrt(Math.max(0, 1 - alpha * sm[k] / p)));
            }
            for (let k = 0; k < bins; k++) {                       // across frequency
                let s = 0, c = 0;
                for (let d = -2; d <= 2; d++) { const j = k + d; if (j >= 0 && j < bins) { s += g[j]; c++; } }
                gs[k] = s / c;
            }
            for (let k = 0; k < bins; k++) {                       // over time: open fast, close slowly
                gs[k] = gs[k] >= gPrev[k] ? gs[k] : 0.6 * gPrev[k] + 0.4 * gs[k];
                gPrev[k] = gs[k];
                re[k] *= gs[k]; im[k] *= gs[k];
                if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
            }
            // inverse FFT by conjugation
            for (let i = 0; i < N; i++) im[i] = -im[i];
            fft(re, im);
            for (let i = 0; i < N; i++) { const w = win[i]; out[f * hop + i] += (re[i] / N) * w; wsum[f * hop + i] += w * w; }
        }

        for (let i = 0; i < n; i++) out[i] = wsum[i] > 1e-6 ? out[i] / wsum[i] : x[i];

        // how much quieter did the quiet parts get?
        let before = 0, after = 0;
        for (const f of noiseFrames) for (let i = 0; i < N; i += 7) { before += x[f * hop + i] ** 2; after += out[f * hop + i] ** 2; }
        return { out, noiseDb, reductionDb: 10 * Math.log10(before / Math.max(after, 1e-20)) };
    }

    function process(channels, sr, options) {

        const o = Object.assign({ maxReductionDb: 14, oversubtract: 2.2, cleanBelowDb: -62 }, options || {});
        const outs = [], infos = [];
        for (const ch of channels) {
            const r = cleanChannel(ch, sr, o);
            if (r.skipped) return { channels, applied: false, reason: r.skipped, noiseDb: r.noiseDb };
            outs.push(r.out); infos.push(r);
        }
        return {
            channels: outs, applied: true,
            noiseDb: infos[0].noiseDb,
            reductionDb: infos.reduce((s, i) => s + i.reductionDb, 0) / infos.length
        };
    }

    return { process };
}


function createPrepEngine(tune) {

    const cache = {};
    function fftFor(N) {
        if (cache[N]) return cache[N];
        const levels = Math.round(Math.log2(N));
        const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2), rev = new Uint32Array(N);
        for (let k = 0; k < N / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / N); sin[k] = Math.sin(2 * Math.PI * k / N); }
        for (let i = 0; i < N; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (levels - 1));
        return (cache[N] = function (re, im) {
            for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
            for (let size = 2; size <= N; size <<= 1) {
                const half = size >> 1, step = N / size;
                for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
                    const a = i + j, b = a + half;
                    const tr = re[b] * cos[k] + im[b] * sin[k], ti = im[b] * cos[k] - re[b] * sin[k];
                    re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
                }
            }
        });
    }

    const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

    // ---------------------------------------------------------
    // Onset strength: how suddenly new sound appears, per ~2.9 ms.
    // The SAME function is used for the beat and the vocal, so any
    // small built-in delay is the same for both.
    // ---------------------------------------------------------

    const ENV_N = 512, ENV_HOP = 128;

    function onsetEnvelope(x, sr) {

        const fft = fftFor(ENV_N), frames = Math.max(0, Math.floor((x.length - ENV_N) / ENV_HOP) + 1);
        const lo = Math.max(1, Math.round(150 * ENV_N / sr)), hi = Math.min(ENV_N / 2 - 1, Math.round(5000 * ENV_N / sr));
        const re = new Float64Array(ENV_N), im = new Float64Array(ENV_N), prev = new Float64Array(ENV_N / 2);
        const win = new Float64Array(ENV_N);
        for (let i = 0; i < ENV_N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / ENV_N);

        const env = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            for (let i = 0; i < ENV_N; i++) { re[i] = x[f * ENV_HOP + i] * win[i]; im[i] = 0; }
            fft(re, im);
            let flux = 0;
            for (let k = lo; k <= hi; k++) {
                const m = Math.log1p(40 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
                const d = m - prev[k];
                if (d > 0) flux += d;
                prev[k] = m;
            }
            env[f] = flux;
        }

        // remove the slow background so only sudden changes are left
        const R = Math.round(0.25 * sr / ENV_HOP), out = new Float32Array(frames);
        const P = new Float64Array(frames + 1);
        for (let i = 0; i < frames; i++) P[i + 1] = P[i] + env[i];
        for (let i = 0; i < frames; i++) {
            const a = Math.max(0, i - R), b = Math.min(frames, i + R + 1);
            out[i] = Math.max(0, env[i] - (P[b] - P[a]) / (b - a));
        }
        return { env: out, hopSec: ENV_HOP / sr, delaySec: (ENV_N * 0.25) / sr };
    }

    // time of frame i, corrected for the analysis window
    const frameTime = (e, i) => i * e.hopSec + e.delaySec;

    // ---------------------------------------------------------
    // The beat's grid: tempo (refined around the hint) and where beats fall
    // ---------------------------------------------------------

    function findGrid(beatMono, sr, bpmHint) {

        if (!(bpmHint > 30 && bpmHint < 300)) return null;

        const seconds = Math.min(beatMono.length / sr, 120);
        const e = onsetEnvelope(beatMono.subarray(0, Math.floor(seconds * sr)), sr);
        const env = e.env, B = 96;
        let best = null;

        for (let b = bpmHint * 0.985; b <= bpmHint * 1.015 + 1e-9; b += bpmHint * 0.0002) {

            const P = (60 / b) / e.hopSec;                       // beat length in frames
            const hist = new Float64Array(B);
            for (let i = 0; i < env.length; i++) hist[Math.floor(((i % P) / P) * B) % B] += env[i];

            // light smoothing, then the sharpest peak
            let pk = 0, pb = 0, total = 0;
            for (let k = 0; k < B; k++) {
                const v = hist[(k + B - 1) % B] * 0.5 + hist[k] + hist[(k + 1) % B] * 0.5;
                total += v; if (v > pk) { pk = v; pb = k; }
            }
            const score = pk / (total / B + 1e-12);
            if (!best || score > best.score) best = { bpm: b, P, phaseBin: pb, score, hist };
        }

        // parabolic refinement of the phase bin
        const h = best.hist, B1 = h[(best.phaseBin + B - 1) % B], B0 = h[best.phaseBin], B2 = h[(best.phaseBin + 1) % B];
        const den = B1 - 2 * B0 + B2;
        const frac = den < 0 ? 0.5 * (B1 - B2) / den : 0;
        const phaseFrames = ((best.phaseBin + 0.5 + frac) / B) * best.P;

        return {
            bpm: best.bpm,
            beatSec: 60 / best.bpm,
            phaseSec: frameTime(e, phaseFrames),
            sharpness: best.score                         // 1 = no rhythm found; higher = clear grid
        };
    }

    // ---------------------------------------------------------
    // Where each syllable of the vocal starts (seconds, vocal time)
    // ---------------------------------------------------------

    function findOnsets(vocalMono, sr) {

        const e = onsetEnvelope(vocalMono, sr), env = e.env;
        let top = 0;
        for (let i = 0; i < env.length; i++) if (env[i] > top) top = env[i];
        if (top <= 0) return [];

        // 1. every local peak above a very low floor
        const floor = 0.03 * top, minGap = Math.round(0.09 / e.hopSec), nb = Math.round(0.015 / e.hopSec);
        let peaks = [];
        for (let i = nb; i < env.length - nb; i++) {
            if (env[i] < floor) continue;
            let isMax = true;
            for (let d = -nb; d <= nb; d++) if (env[i + d] > env[i]) { isMax = false; break; }
            if (!isMax) continue;
            if (peaks.length && i - peaks[peaks.length - 1] < minGap) { if (env[i] > env[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i; continue; }
            peaks.push(i);
        }
        if (!peaks.length) return [];

        // 2. keep what looks like a real syllable: at least a fifth as strong as the typical strong one.
        //    (Noise, breaths and hum make peaks too, but 10-20 times weaker than singing.)
        const vals = peaks.map(i => env[i]).sort((a, b) => b - a);
        const strong = vals.slice(0, Math.max(1, Math.ceil(vals.length / 4)));
        const ref = strong[strong.length >> 1];
        peaks = peaks.filter(i => env[i] >= 0.2 * ref);

        // 3. a syllable must also be clearly louder than the recording's own floor, otherwise a
        //    take that is only room noise would "find" syllables in the noise
        const blk = Math.round(0.01 * sr), nBlk = Math.floor(vocalMono.length / blk), lev = new Float32Array(nBlk);
        for (let b = 0; b < nBlk; b++) { let s = 0; for (let i = b * blk; i < (b + 1) * blk; i++) s += vocalMono[i] * vocalMono[i]; lev[b] = Math.sqrt(s / blk); }
        const floorLev = Float32Array.from(lev).sort()[Math.floor(nBlk * 0.1)] || 1e-9;
        peaks = peaks.filter(i => {
            const t0 = Math.floor((i * e.hopSec) / 0.01);
            let mx = 0; for (let b = t0; b < Math.min(nBlk, t0 + 12); b++) if (lev[b] > mx) mx = lev[b];
            return mx >= 2.5 * floorLev;
        });

        // step back to where the rise begins
        return peaks.map(i => {
            let j = i;
            while (j > 0 && i - j < Math.round(0.02 / e.hopSec) && env[j - 1] >= 0.4 * env[i]) j--;
            return frameTime(e, j);
        });
    }

    // ---------------------------------------------------------
    // How fast does the singer actually go, compared with the beat?
    //
    // If syllables fall on a regular 16th-note grid, their times line up (all share one phase) only
    // for the singer's true tempo. So try tempos around the beat's and keep the one where the
    // syllables line up best. It is only trusted when it is clearly better than the beat's own tempo.
    // ---------------------------------------------------------

    function estimateVocalTempo(onsets, beatBpm) {

        const none = (reason) => ({ apply: false, reason, ratio: 1 });
        if (!(beatBpm > 30) || onsets.length < 12) return none("too few syllables to judge the speed");

        const R = (bpm) => {
            const p = 60 / bpm / 4;                                   // a 16th note
            let c = 0, s = 0;
            for (const t of onsets) { const a = 2 * Math.PI * t / p; c += Math.cos(a); s += Math.sin(a); }
            return Math.sqrt(c * c + s * s) / onsets.length;
        };

        const lo = 0.88, hi = 1.12, stepRel = 0.0005, rs = [];
        for (let r = lo; r <= hi + 1e-9; r += stepRel) rs.push({ r, v: R(beatBpm * r) });

        let best = rs[0];
        for (const x of rs) if (x.v > best.v) best = x;
        const atBeat = R(beatBpm);

        // the best rival that is NOT just the same peak
        let rival = 0;
        for (const x of rs) if (Math.abs(x.r - best.r) > 0.015 && x.v > rival) rival = x.v;

        const off = Math.abs(best.r - 1);
        if (best.v < 0.5) return none("the syllables do not sit on a regular grid, so there is no speed to match");
        if (off < 0.004) return Object.assign(none("already at the beat's speed"), { bpm: beatBpm * best.r, fit: best.v });
        if (best.v - atBeat < 0.2) return none("the singer's speed is not clearly different from the beat's");
        if (rival > 0.88 * best.v) return none("two different speeds fit equally well, so it is not safe to pick one");

        return { apply: true, ratio: best.r, bpm: beatBpm * best.r, fit: best.v, fitAtBeat: atBeat };
    }

    // ---------------------------------------------------------
    // Timing plan: how far to move each syllable, as a warp map
    // ---------------------------------------------------------

    function planTiming(onsets, grid, offsetSec, n, sr, o) {

        o = Object.assign({ strength: 0.8, maxMoveSec: 0.05, maxStretch: 0.2 }, o || {});

        const step = grid.beatSec / 4;                          // a 16th note
        // 30% of a 16th note: any wider and a late syllable looks like an early one on the next line
        const tol = Math.min(o.maxMoveSec, 0.3 * step);

        const devs = [], knots = [{ t: 0, s: 0, fixed: true }];
        let snapped = 0;

        for (const t of onsets) {
            const tb = t + offsetSec;
            const target = grid.phaseSec + Math.round((tb - grid.phaseSec) / step) * step;
            const dev = target - tb;
            devs.push(dev);
            if (Math.abs(dev) <= tol && t > 0.05) { knots.push({ t, s: o.strength * dev, fixed: false, dev }); snapped++; }
        }

        // between phrases, bring the shift back to zero inside the gap
        const withGaps = [knots[0]];
        for (let j = 1; j < knots.length; j++) {
            const a = withGaps[withGaps.length - 1], b = knots[j];
            if (b.t - a.t > 0.6) {
                if (Math.abs(a.s) > 1e-4 && !a.fixed) withGaps.push({ t: a.t + 0.2, s: 0, fixed: true });
                if (Math.abs(b.s) > 1e-4) withGaps.push({ t: b.t - 0.2, s: 0, fixed: true });
            }
            withGaps.push(b);
        }

        // never stretch the audio by more than maxStretch between two points
        for (let pass = 0; pass < 30; pass++) {
            for (let j = 1; j < withGaps.length; j++) {
                const L = o.maxStretch * (withGaps[j].t - withGaps[j - 1].t), p = withGaps[j - 1], c = withGaps[j];
                if (!c.fixed) c.s = Math.max(p.s - L, Math.min(p.s + L, c.s));
                else if (!p.fixed) p.s = Math.max(c.s - L, Math.min(c.s + L, p.s));
            }
            for (let j = withGaps.length - 2; j >= 0; j--) {
                const L = o.maxStretch * (withGaps[j + 1].t - withGaps[j].t), p = withGaps[j], c = withGaps[j + 1];
                if (!p.fixed) p.s = Math.max(c.s - L, Math.min(c.s + L, p.s));
            }
        }

        const tIn = [], tOut = [];
        for (const k of withGaps) {
            const a = Math.round(k.t * sr), b = Math.round((k.t + k.s) * sr);
            if (tIn.length && (a <= tIn[tIn.length - 1] || b <= tOut[tOut.length - 1])) continue;
            tIn.push(a); tOut.push(b);
        }
        if (tIn[tIn.length - 1] < n) { tIn.push(n); tOut.push(n + (tOut[tOut.length - 1] - tIn[tIn.length - 2])); }

        // what the plan means in plain numbers
        const moved = withGaps.filter(k => !k.fixed && k.dev !== undefined);
        const before = moved.map(k => Math.abs(k.dev) * 1000);
        const after = moved.map(k => Math.abs(k.dev - k.s) * 1000);

        return {
            anchors: { tIn, tOut },
            onsets: onsets.length, snapped,
            leftAlone: onsets.length - snapped,
            medianMoveMs: moved.length ? median(moved.map(k => Math.abs(k.s) * 1000)) : 0,
            medianBeforeMs: before.length ? median(before) : 0,
            medianAfterMs: after.length ? median(after) : 0,
            toleranceMs: tol * 1000
        };
    }

    // ---------------------------------------------------------
    // Full job
    // ---------------------------------------------------------

    function process(args, progress) {

        progress = progress || function () { };
        const { sr, options } = args;
        let channels = args.channels;
        const report = [], stats = {};

        if (options.denoise) {
            progress(0.1, "Measuring the background noise");
            const d = createDenoiseEngine().process(channels, sr, { maxReductionDb: 14 });
            stats.denoise = { applied: d.applied, noiseDb: d.noiseDb, reductionDb: d.reductionDb, reason: d.reason };
            if (d.applied) {
                channels = d.channels;
                report.push(`Reduced steady background noise by about ${d.reductionDb.toFixed(0)} dB (the noise floor was ${d.noiseDb.toFixed(0)} dBFS).`);
            } else {
                report.push(`Left the noise alone: ${d.reason}.`);
            }
        }

        if (options.tempo) {
            progress(0.3, "Measuring the singer's speed");
            if (!(args.bpm > 30)) {
                report.push("Left the speed alone: the beat's tempo is not known yet.");
                stats.tempo = { applied: false };
            } else {
                const mono0 = tune.mixDown(channels);
                const onsets0 = findOnsets(mono0, sr);
                const est = estimateVocalTempo(onsets0, args.bpm);
                stats.tempo = Object.assign({ applied: est.apply }, est);
                if (!est.apply) {
                    report.push(`Left the speed alone: ${est.reason}.`);
                } else {
                    // stretch around the first syllable so the opening stays where you aligned it
                    const t0 = Math.round(onsets0[0] * sr), n0 = mono0.length;
                    const anchors = { tIn: [0, t0, n0], tOut: [0, t0, t0 + Math.round((n0 - t0) * est.ratio)] };
                    progress(0.4, "Fitting the speed to the beat");
                    channels = tune.applyWarp(channels, mono0, sr, tune.trackClean(mono0, sr), anchors);
                    report.push(`The singer was ${est.ratio < 1 ? "slower" : "faster"} than the beat (about ${est.bpm.toFixed(1)} BPM against ${args.bpm.toFixed(1)}), ` +
                        `so the whole vocal was ${est.ratio < 1 ? "sped up" : "slowed down"} by ${Math.abs((1 - est.ratio) * 100).toFixed(1)}% to fit. Pitch is unchanged.`);
                }
            }
        }

        if (options.timing) {
            progress(0.5, "Finding the beat grid");
            const grid = args.beatMono ? findGrid(args.beatMono, sr, args.bpm) : null;

            if (!grid) {
                report.push("Left the timing alone: the beat's tempo is not known yet.");
                stats.timing = { applied: false };
            } else if (grid.sharpness < 1.6) {
                report.push("Left the timing alone: the beat has no clear pulse to line up with.");
                stats.timing = { applied: false, grid };
            } else {
                progress(0.55, "Finding the syllables");
                const mono = tune.mixDown(channels);
                const onsets = findOnsets(mono, sr);
                const plan = planTiming(onsets, grid, args.offsetSec || 0, mono.length, sr);
                stats.timing = Object.assign({ applied: plan.snapped > 0, grid }, plan);
                delete stats.timing.anchors;

                if (plan.snapped === 0) {
                    report.push("Left the timing alone: no syllable was close enough to the grid to be a slip.");
                } else {
                    progress(0.7, "Re-timing");
                    const track = tune.trackClean(mono, sr);
                    channels = tune.applyWarp(channels, mono, sr, track, plan.anchors);
                    report.push(
                        `Tightened ${plan.snapped} of ${plan.onsets} syllable starts toward the beat grid ` +
                        `(${grid.bpm.toFixed(1)} BPM, 16th notes). The typical slip of ${plan.medianBeforeMs.toFixed(0)} ms ` +
                        `is now about ${plan.medianAfterMs.toFixed(0)} ms. ` +
                        (plan.leftAlone ? `${plan.leftAlone} were left alone because they sit more than ${plan.toleranceMs.toFixed(0)} ms from any grid line, which usually means groove rather than a mistake.` : ""));
                }
            }
        }

        progress(1, "Done");
        return { channels, report, stats };
    }

    return { onsetEnvelope, findGrid, findOnsets, planTiming, estimateVocalTempo, process };
}


/* =========================================================
   BROWSER: worker wrapper
   ========================================================= */

function runPrepJob(job, onProgress) {

    return new Promise((resolve, reject) => {

        function here() {
            try {
                const tune = createTuneEngine();
                resolve(createPrepEngine(tune).process(job, onProgress));
            } catch (error) { reject(error); }
        }

        try {
            const source =
                createTuneEngine.toString() + "\n" +
                createDenoiseEngine.toString() + "\n" +
                createPrepEngine.toString() + "\n" +
                "const __prep = createPrepEngine(createTuneEngine());\n" +
                "self.onmessage = function (e) {\n" +
                "  try {\n" +
                "    const r = __prep.process(e.data, function (f, l) { self.postMessage({ progress: f, label: l }); });\n" +
                "    self.postMessage({ result: r }, r.channels.map(function (c) { return c.buffer; }));\n" +
                "  } catch (err) { self.postMessage({ error: String(err && err.stack || err) }); }\n" +
                "};";

            const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            const worker = new Worker(url);

            worker.onmessage = (event) => {
                const d = event.data;
                if (d.progress !== undefined) { if (onProgress) onProgress(d.progress, d.label); return; }
                URL.revokeObjectURL(url); worker.terminate();
                if (d.error) reject(new Error(d.error)); else resolve(d.result);
            };
            worker.onerror = (event) => { URL.revokeObjectURL(url); worker.terminate(); reject(new Error(event.message || "Clean-up worker failed.")); };

            worker.postMessage(job, job.channels.map(c => c.buffer).concat(job.beatMono ? [job.beatMono.buffer] : []));

        } catch (error) {
            here();
        }
    });
}


/* =========================================================
   BROWSER: Step 04 UI
   ========================================================= */

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", () => {

    const $ = (id) => document.getElementById(id);
    const section = $("prep-section");
    if (!section) return;

    const S = window.VocalVaultState;
    const denoiseBox = $("prep-denoise"), timingBox = $("prep-timing"), tempoBox = $("prep-tempo");
    const runButton = $("prep-run-button"), status = $("prep-status"), reportList = $("prep-report");
    const compare = $("prep-compare"), playBefore = $("prep-play-before"), playAfter = $("prep-play-after"), stopButton = $("prep-stop");
    const timingNote = $("prep-timing-note"), tempoNote = $("prep-tempo-note");

    let running = false, after = null, nodes = [], playing = null;

    // Resolve the beat tempo: state getter, or the number shown on the analysis step.
    function resolveBeatBpm() {
        let bpm = S && S.beatBpm;
        if (bpm > 30 && bpm < 400) return Number(bpm);
        // Fallback: read the analysis readout if the getter was empty
        const el = document.getElementById("beat-bpm");
        if (el) {
            const n = parseFloat(String(el.textContent).replace(/[^\d.]/g, ""));
            if (n > 30 && n < 400) return n;
        }
        return null;
    }

    function refreshTempoControls() {
        const bpm = resolveBeatBpm();
        // Stash so the run path always has a number even if the getter fails
        if (bpm && S) S._prepBpm = bpm;

        timingBox.disabled = !bpm;
        timingNote.textContent = bpm
            ? `Uses the beat's ${Number(bpm).toFixed(1)} BPM from the analysis step.`
            : "No tempo yet — run analysis first, or type a BPM below.";
        if (!bpm) timingBox.checked = false;

        tempoBox.disabled = !bpm;
        tempoNote.textContent = bpm
            ? `Uses the beat's ${Number(bpm).toFixed(1)} BPM.`
            : "No tempo yet — run analysis first, or type a BPM below.";
        if (!bpm) tempoBox.checked = false;

        // Show/hide manual BPM entry when detection failed
        const manualWrap = $("prep-manual-bpm-wrap");
        if (manualWrap) manualWrap.classList.toggle("hidden", !!bpm);
    }

    // ---- open the step ----
    $("continue-prep-button").addEventListener("click", () => {
        section.classList.remove("hidden");
        section.scrollIntoView({ behavior: "smooth", block: "start" });
        refreshTempoControls();
    });

    // Manual BPM: unlock tempo/timing when the user types a value
    const manualBpmInput = $("prep-manual-bpm");
    if (manualBpmInput) {
        manualBpmInput.addEventListener("input", () => {
            const n = parseFloat(manualBpmInput.value);
            if (n > 30 && n < 400 && S) {
                S._prepBpm = n;
                // Also push into the analysis state so Mix can use it
                try {
                    const setBpm = window.VocalVaultSetBeatBpm;
                    if (typeof setBpm === "function") setBpm(n);
                } catch (e) { /* ignore */ }
            }
            refreshTempoControls();
            // If they typed a valid BPM, enable boxes immediately
            if (n > 30 && n < 400) {
                timingBox.disabled = false;
                tempoBox.disabled = false;
                timingNote.textContent = `Uses your tempo: ${n.toFixed(1)} BPM.`;
                tempoNote.textContent = `Uses your tempo: ${n.toFixed(1)} BPM.`;
            }
        });
    }

    $("continue-from-prep-button").addEventListener("click", () => {
        stopPlayback();
        $("continue-tune-button").click();
    });

    // ---- run ----
    runButton.addEventListener("click", async () => {

        if (running || !S || !S.vocalBuffer) return;

        stopPlayback();
        reportList.innerHTML = "";

        if (!denoiseBox.checked && !timingBox.checked && !tempoBox.checked) {
            S.preparedVocal = null; after = null;
            compare.classList.add("hidden");
            status.textContent = "Nothing ticked, so the vocal stays exactly as you recorded it.";
            window.dispatchEvent(new Event("vv-prep-changed"));
            return;
        }

        running = true; runButton.disabled = true;
        status.textContent = "Starting…";

        const vocal = S.vocalBuffer, beat = S.beatBuffer;
        const channels = [];
        for (let c = 0; c < vocal.numberOfChannels; c++) channels.push(Float32Array.from(vocal.getChannelData(c)));

        let beatMono = null;
        if (timingBox.checked && beat) {
            const secs = Math.min(beat.length, Math.floor(beat.sampleRate * 120));
            beatMono = new Float32Array(secs);
            for (let c = 0; c < beat.numberOfChannels; c++) { const d = beat.getChannelData(c); for (let i = 0; i < secs; i++) beatMono[i] += d[i] / beat.numberOfChannels; }
        }

        try {
            const result = await runPrepJob({
                channels, sr: vocal.sampleRate, beatMono,
                bpm: (S._prepBpm || S.beatBpm || null), offsetSec: S.vocalOffset || 0,
                options: { denoise: denoiseBox.checked, timing: timingBox.checked, tempo: tempoBox.checked }
            }, (f, label) => { status.textContent = `${label}… ${Math.round(f * 100)}%`; });

            const buffer = S.audioContext.createBuffer(result.channels.length, result.channels[0].length, vocal.sampleRate);
            result.channels.forEach((c, i) => buffer.copyToChannel(c, i));

            const changed = result.channels[0] !== channels[0] && (result.stats.denoise && result.stats.denoise.applied || result.stats.tempo && result.stats.tempo.applied || result.stats.timing && result.stats.timing.applied);
            after = changed ? buffer : null;
            S.preparedVocal = after;

            result.report.forEach(line => { const li = document.createElement("li"); li.textContent = line; reportList.appendChild(li); });
            compare.classList.toggle("hidden", !after);
            status.textContent = after ? "Done. Compare below, then continue." : "Nothing needed changing, so the vocal stays as recorded.";
            window.dispatchEvent(new Event("vv-prep-changed"));

        } catch (error) {
            console.error(error);
            status.textContent = "Clean-up failed. See the console for details.";
        } finally {
            running = false; runButton.disabled = false;
        }
    });

    // ---- before / after, with the beat underneath ----
    function stopPlayback() {
        nodes.forEach(n => { try { n.onended = null; n.stop(); } catch (e) { /* stopped */ } });
        nodes = []; playing = null;
        playBefore.classList.remove("is-active"); playAfter.classList.remove("is-active");
    }

    function start(which) {
        const buf = which === "after" ? after : S.vocalBuffer;
        if (!buf || !S.beatBuffer) return;
        const ctx = S.audioContext;
        if (ctx.state === "suspended") ctx.resume();

        let pos;
        if (playing) pos = playing.pos + (ctx.currentTime - playing.t0);
        else {
            const d = S.vocalBuffer.getChannelData(0); let first = 0, pk = 0;
            for (let i = 0; i < d.length; i += 64) pk = Math.max(pk, Math.abs(d[i]));
            for (let i = 0; i < d.length; i += 64) if (Math.abs(d[i]) > pk * 0.1) { first = i / S.vocalBuffer.sampleRate; break; }
            pos = Math.max(0, first + (S.vocalOffset || 0) - 1);
        }
        stopPlayback();

        const beat = ctx.createBufferSource(); beat.buffer = S.beatBuffer;
        const g = ctx.createGain(); g.gain.value = 0.75; beat.connect(g).connect(ctx.destination);
        const voc = ctx.createBufferSource(); voc.buffer = buf; voc.connect(ctx.destination);

        const off = S.vocalOffset || 0, vt = pos - off, now = ctx.currentTime + 0.05;
        beat.start(now, pos);
        if (vt >= 0) voc.start(now, vt); else voc.start(now - vt, 0);
        beat.onended = stopPlayback;
        nodes = [beat, voc]; playing = { pos, t0: now };
        (which === "after" ? playAfter : playBefore).classList.add("is-active");
        (which === "after" ? playBefore : playAfter).classList.remove("is-active");
    }

    playBefore.addEventListener("click", () => start("before"));
    playAfter.addEventListener("click", () => start("after"));
    stopButton.addEventListener("click", stopPlayback);
});

if (typeof module !== "undefined") {
    module.exports = { createDenoiseEngine, createPrepEngine };
}