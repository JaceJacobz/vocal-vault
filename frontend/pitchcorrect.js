/* =========================================================
   VOCAL VAULT — PITCH CORRECTION ENGINE

   Pipeline
   1. trackPitch      YIN pitch tracker (~6 ms hop), refined at the full
                      sample rate for cent-level accuracy.
   2. segmentNotes    Splits the pitch curve into notes.
   3. planCorrection  Moves each note's centre to the nearest note of the
                      beat's key (in the beat's own tuning), keeping the
                      singer's vibrato unless "flatten" is raised.
   4. applyShift      TD-PSOLA pitch shifter. Formants are preserved, so
                      the voice does not turn into a chipmunk. Unvoiced
                      sounds (breaths, "s", "t") pass through untouched.
   5. process         Runs the above, and can first deliberately detune
                      the vocal (testDetune) to prove the correction works.

   Everything lives inside createTuneEngine() so it can be stringified
   into a Web Worker, the same way analysis.js does it. No dependencies.
   ========================================================= */

function createTuneEngine() {

    const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const SCALES = {
        major: [0, 2, 4, 5, 7, 9, 11],
        minor: [0, 2, 3, 5, 7, 8, 10]
    };

    // ---------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------

    function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

    function median(values) {
        if (!values.length) return NaN;
        const s = Float64Array.from(values).sort();
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    function mixDown(channels) {
        if (channels.length === 1) return channels[0];
        const n = channels[0].length;
        const out = new Float32Array(n);
        for (let c = 0; c < channels.length; c++) {
            const d = channels[c];
            for (let i = 0; i < n; i++) out[i] += d[i] / channels.length;
        }
        return out;
    }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function scaleMask(rootPc, scaleName) {
        const mask = new Array(12).fill(false);
        const degrees = SCALES[String(scaleName).toLowerCase()] || SCALES.major;
        for (const d of degrees) mask[(rootPc + d) % 12] = true;
        return mask;
    }

    // Nearest allowed integer note to a (fractional) midi value.
    function nearestNote(m, rootPc, mask, chromatic) {
        const base = Math.round(m);
        let best = base, bestD = Infinity;
        for (let c = base - 2; c <= base + 2; c++) {
            if (!chromatic && !mask[((c % 12) + 12) % 12]) continue;
            const d = Math.abs(c - m);
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    // ---------------------------------------------------------
    // FFT (only used for tuning estimation)
    // ---------------------------------------------------------

    const fftCache = {};

    function fftFor(N) {
        if (fftCache[N]) return fftCache[N];
        const levels = Math.round(Math.log2(N));
        const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
        for (let k = 0; k < N / 2; k++) {
            cos[k] = Math.cos((2 * Math.PI * k) / N);
            sin[k] = Math.sin((2 * Math.PI * k) / N);
        }
        const rev = new Uint32Array(N);
        for (let i = 0; i < N; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (levels - 1));
        const fft = function (re, im) {
            for (let i = 0; i < N; i++) {
                const j = rev[i];
                if (j > i) {
                    let t = re[i]; re[i] = re[j]; re[j] = t;
                    t = im[i]; im[i] = im[j]; im[j] = t;
                }
            }
            for (let size = 2; size <= N; size <<= 1) {
                const half = size >> 1, step = N / size;
                for (let i = 0; i < N; i += size) {
                    for (let j = 0, k = 0; j < half; j++, k += step) {
                        const a = i + j, b = a + half;
                        const tr = re[b] * cos[k] + im[b] * sin[k];
                        const ti = im[b] * cos[k] - re[b] * sin[k];
                        re[b] = re[a] - tr; im[b] = im[a] - ti;
                        re[a] += tr; im[a] += ti;
                    }
                }
            }
        };
        fftCache[N] = fft;
        return fft;
    }

    // ---------------------------------------------------------
    // Tuning reference of a beat: how many cents its "A" is from 440 Hz.
    // Returns { cents, strength }. strength 0..1 (low = not trustworthy).
    // ---------------------------------------------------------

    function estimateTuning(x, sr) {

        const N = 8192;
        const fft = fftFor(N);
        const total = Math.min(x.length, Math.floor(sr * 90));
        const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2);
        const hann = new Float64Array(N);
        for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

        let sumC = 0, sumS = 0, sumW = 0;

        for (let start = 0; start + N <= total; start += N) {

            for (let i = 0; i < N; i++) { re[i] = x[start + i] * hann[i]; im[i] = 0; }
            fft(re, im);

            let frameMax = 0;
            for (let k = 1; k < N / 2; k++) {
                mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
                if (mag[k] > frameMax) frameMax = mag[k];
            }
            if (frameMax === 0) continue;

            const loK = Math.ceil(150 * N / sr), hiK = Math.floor(2000 * N / sr);

            for (let k = Math.max(2, loK); k <= hiK; k++) {
                if (mag[k] < frameMax * 0.15 || mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;

                const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(mag[k] + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
                const denom = a - 2 * b + c;
                const shift = denom === 0 ? 0 : 0.5 * (a - c) / denom;
                const freq = ((k + shift) * sr) / N;

                const cents = 1200 * Math.log2(freq / 440);
                const dev = cents - 100 * Math.round(cents / 100);      // -50..+50
                const ang = (2 * Math.PI * dev) / 100;
                const w = mag[k] / frameMax;

                sumC += w * Math.cos(ang);
                sumS += w * Math.sin(ang);
                sumW += w;
            }
        }

        if (sumW === 0) return { cents: 0, strength: 0 };

        return {
            cents: (Math.atan2(sumS, sumC) * 100) / (2 * Math.PI),
            strength: Math.sqrt(sumC * sumC + sumS * sumS) / sumW
        };
    }

    // ---------------------------------------------------------
    // Pitch tracking (YIN)
    // ---------------------------------------------------------

    function decimate(x, D) {
        if (D === 1) return x;
        const half = 8 * D, fc = 0.45 / D;
        const taps = new Float64Array(2 * half + 1);
        let sum = 0;
        for (let i = -half; i <= half; i++) {
            const s = i === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * i) / (Math.PI * i);
            const w = 0.5 + 0.5 * Math.cos((Math.PI * i) / (half + 1));
            taps[i + half] = s * w;
            sum += taps[i + half];
        }
        for (let i = 0; i < taps.length; i++) taps[i] /= sum;

        const n = Math.floor(x.length / D);
        const y = new Float32Array(n);
        for (let k = 0; k < n; k++) {
            const c = k * D;
            const lo = Math.max(-half, -c), hi = Math.min(half, x.length - 1 - c);
            let acc = 0;
            for (let i = lo; i <= hi; i++) acc += x[c + i] * taps[i + half];
            y[k] = acc;
        }
        return y;
    }

    // Returns { sampleRate, hop, midi, conf }. midi is NaN where unvoiced.
    // Frame k is centred on sample k * hop.
    function trackPitch(x, sr, o) {

        o = o || {};

        const fMin = o.minHz || 70;
        const fMax = o.maxHz || 1000;
        const D = Math.max(1, Math.round(sr / 11025));
        const srd = sr / D;
        const hopD = o.hopD || 64;
        const hop = hopD * D;
        const W = 384;
        const minTau = Math.max(2, Math.floor(srd / fMax));
        const maxTau = Math.ceil(srd / fMin);
        const span = W + maxTau + 2;
        const dipThreshold = 0.15;
        const voicedThreshold = o.voicedThreshold || 0.25;

        const xd = decimate(x, D);
        const frames = Math.floor(x.length / hop) + 1;
        const midi = new Float32Array(frames).fill(NaN);
        const conf = new Float32Array(frames);

        const P = new Float64Array(xd.length + 1);
        for (let i = 0; i < xd.length; i++) P[i + 1] = P[i] + xd[i] * xd[i];

        // Quiet frames are never pitched: gate at -35 dB under the loudest.
        const energy = new Float64Array(frames);
        let maxE = 0;
        for (let k = 0; k < frames; k++) {
            const s = k * hopD - (W >> 1);
            if (s < 0 || s + W > xd.length) continue;
            energy[k] = (P[s + W] - P[s]) / W;
            if (energy[k] > maxE) maxE = energy[k];
        }
        const gate = maxE * 3e-4;

        const cm = new Float64Array(maxTau + 2);

        const Wf = 1024;

        for (let k = 0; k < frames; k++) {

            if (energy[k] <= gate || energy[k] === 0) continue;

            const start = k * hopD - (span >> 1);
            if (start < 0 || start + span > xd.length) continue;

            // Difference function + cumulative mean normalisation
            let running = 0;
            cm[0] = 1;
            for (let tau = 1; tau <= maxTau; tau++) {
                let s = 0;
                for (let j = 0; j < W; j++) {
                    const d = xd[start + j] - xd[start + j + tau];
                    s += d * d;
                }
                running += s;
                cm[tau] = running > 0 ? (s * tau) / running : 1;
            }

            // First dip below threshold, followed down to its minimum
            let found = -1;
            for (let tau = minTau; tau < maxTau; tau++) {
                if (cm[tau] < dipThreshold) {
                    while (tau + 1 < maxTau && cm[tau + 1] < cm[tau]) tau++;
                    found = tau;
                    break;
                }
            }
            if (found < 0) {
                let m = minTau;
                for (let tau = minTau; tau < maxTau; tau++) if (cm[tau] < cm[m]) m = tau;
                found = m;
            }

            if (cm[found] > voicedThreshold) continue;

            let tauF = found;
            if (found > 1 && found < maxTau - 1) {
                const a = cm[found - 1], b = cm[found], c = cm[found + 1];
                const denom = a - 2 * b + c;
                if (denom > 0) tauF = found + 0.5 * (a - c) / denom;
            }

            // Refine at the full sample rate (the coarse lag is only good to
            // about a quarter of a decimated sample).
            let lag = tauF * D;
            const centre = k * hop;
            const L0 = Math.round(lag);
            const s0 = centre - (Wf >> 1);

            if (s0 >= 0 && s0 + Wf + L0 + D + 2 < x.length) {

                const lo = L0 - D, hi = L0 + D;
                const dv = new Float64Array(hi - lo + 1);
                let bi = 0;

                for (let L = lo; L <= hi; L++) {
                    let s = 0;
                    for (let j = 0; j < Wf; j++) {
                        const d = x[s0 + j] - x[s0 + j + L];
                        s += d * d;
                    }
                    dv[L - lo] = s;
                    if (s < dv[bi]) bi = L - lo;
                }

                if (bi > 0 && bi < dv.length - 1) {
                    const a = dv[bi - 1], b = dv[bi], c = dv[bi + 1];
                    const denom = a - 2 * b + c;
                    lag = lo + bi + (denom > 0 ? 0.5 * (a - c) / denom : 0);
                }
            }

            const f0 = sr / lag;
            if (f0 < fMin * 0.95 || f0 > fMax * 1.05) continue;

            midi[k] = 69 + 12 * Math.log2(f0 / 440);
            conf[k] = 1 - cm[found];
        }

        return { sampleRate: sr, hop, midi, conf };
    }

    // Fixes octave jumps, closes tiny gaps, drops specks.
    function cleanTrack(midiIn) {

        const n = midiIn.length;
        const m = Float32Array.from(midiIn);

        // 1. Octave jumps relative to the local median
        for (let k = 0; k < n; k++) {
            if (isNaN(midiIn[k])) continue;
            const near = [];
            for (let i = Math.max(0, k - 6); i <= Math.min(n - 1, k + 6); i++) {
                if (i !== k && !isNaN(midiIn[i])) near.push(midiIn[i]);
            }
            if (near.length < 5) continue;
            const d = midiIn[k] - median(near);
            if (Math.abs(Math.abs(d) - 12) < 1.5) m[k] = midiIn[k] - Math.sign(d) * 12;
        }

        // 2. Fill gaps of up to 3 frames when both sides agree
        for (let k = 1; k < n; k++) {
            if (!isNaN(m[k]) || isNaN(m[k - 1])) continue;
            let e = k;
            while (e < n && isNaN(m[e]) && e - k <= 3) e++;
            if (e < n && !isNaN(m[e]) && e - k <= 3 && Math.abs(m[e] - m[k - 1]) < 1.5) {
                for (let i = k; i < e; i++) m[i] = m[k - 1] + ((m[e] - m[k - 1]) * (i - k + 1)) / (e - k + 1);
            }
            k = e;
        }

        // 3. Remove voiced specks shorter than 5 frames
        for (let k = 0; k < n; k++) {
            if (isNaN(m[k])) continue;
            let e = k;
            while (e < n && !isNaN(m[e])) e++;
            if (e - k < 5) for (let i = k; i < e; i++) m[i] = NaN;
            k = e;
        }

        return m;
    }

    function trackClean(x, sr, o) {
        const t = trackPitch(x, sr, o);
        t.midi = cleanTrack(t.midi);
        return t;
    }

    // ---------------------------------------------------------
    // Note segmentation
    // ---------------------------------------------------------

    function medianSmooth(m, radius) {
        const n = m.length, out = new Float32Array(n).fill(NaN);
        for (let k = 0; k < n; k++) {
            if (isNaN(m[k])) continue;
            const w = [];
            for (let i = Math.max(0, k - radius); i <= Math.min(n - 1, k + radius); i++) if (!isNaN(m[i])) w.push(m[i]);
            out[k] = median(w);
        }
        return out;
    }

    // Returns [{ start, end (exclusive), center }]
    function segmentNotes(midi) {

        const n = midi.length;
        const sm = medianSmooth(midi, 2);
        const notes = [];

        function close(a, b) {
            if (b - a < 1) return;
            let lo = a, hi = b;
            if (b - a >= 10) {                       // ignore the scoop in and the drop out
                lo = a + Math.floor((b - a) * 0.2);
                hi = b - Math.floor((b - a) * 0.2);
            }
            const vals = [];
            for (let i = lo; i < hi; i++) if (!isNaN(midi[i])) vals.push(midi[i]);
            if (vals.length) notes.push({ start: a, end: b, center: median(vals) });
        }

        let k = 0;
        while (k < n) {

            if (isNaN(sm[k])) { k++; continue; }

            let r = k;
            while (r < n && !isNaN(sm[r])) r++;

            let start = k, recent = [], pending = 0;

            for (let i = k; i < r; i++) {
                const v = sm[i];
                const cur = recent.length ? median(recent.slice(-40)) : v;

                if (recent.length >= 3 && Math.abs(v - cur) > 0.65) {
                    pending++;
                    if (pending >= 7) {
                        const split = i - pending + 1;
                        close(start, split);
                        start = split;
                        recent = [];
                        for (let j = split; j <= i; j++) recent.push(sm[j]);
                        pending = 0;
                    }
                } else {
                    pending = 0;
                    recent.push(v);
                }
            }
            close(start, r);
            k = r;
        }

        return notes;
    }

    // ---------------------------------------------------------
    // Measuring how in tune a track is (same metrics for before / after)
    // ---------------------------------------------------------

    function measure(track, o) {

        const mask = scaleMask(o.rootPc, o.scale);
        const ref = (o.refCents || 0) / 100;
        const midi = track.midi;
        const dists = [];
        let inKey = 0;

        for (let k = 0; k < midi.length; k++) {
            if (isNaN(midi[k])) continue;
            const m = midi[k] - ref;
            if (mask[(((Math.round(m) % 12) + 12) % 12)]) inKey++;
            const t = nearestNote(m, o.rootPc, mask, false);
            dists.push(Math.abs(m - t) * 100);
        }

        const voiced = dists.length;
        const within = (c) => (voiced ? dists.filter(d => d <= c).length / voiced : 0);

        // Note level: only notes lasting 120 ms or more
        const minFrames = Math.ceil(0.12 / (track.hop / track.sampleRate));
        const notes = segmentNotes(midi).filter(n => n.end - n.start >= minFrames);
        const noteDists = [];
        let notesInKey = 0;
        for (const nt of notes) {
            const m = nt.center - ref;
            if (mask[(((Math.round(m) % 12) + 12) % 12)]) notesInKey++;
            noteDists.push(Math.abs(m - nearestNote(m, o.rootPc, mask, false)) * 100);
        }

        return {
            voicedFrames: voiced,
            inKeyPct: voiced ? (100 * inKey) / voiced : 0,
            medianCents: voiced ? median(dists) : 0,
            within25Pct: 100 * within(25),
            within50Pct: 100 * within(50),
            notes: notes.length,
            notesInKey,
            notesOutOfKey: notes.length - notesInKey,
            noteMedianCents: noteDists.length ? median(noteDists) : 0,
            noteWithin25: noteDists.filter(d => d <= 25).length
        };
    }

    // Which keys does the vocal itself fit? Guards against a wrong beat key.
    function keyFit(track, o) {

        const ref = (o.refCents || 0) / 100;
        const counts = new Float64Array(12);
        let total = 0;

        for (let k = 0; k < track.midi.length; k++) {
            if (isNaN(track.midi[k])) continue;
            counts[(((Math.round(track.midi[k] - ref)) % 12) + 12) % 12]++;
            total++;
        }
        if (!total) return null;

        const coverage = (root, scale) => {
            let c = 0;
            for (const d of SCALES[scale]) c += counts[(root + d) % 12];
            return c / total;
        };

        let bestPct = 0;
        const all = [];
        for (let root = 0; root < 12; root++) {
            for (const scale of ["major", "minor"]) {
                const pct = coverage(root, scale);
                all.push({ root, scale, pct });
                if (pct > bestPct) bestPct = pct;
            }
        }

        return {
            selectedPct: coverage(o.rootPc, String(o.scale).toLowerCase()),
            bestPct,
            // relative major/minor pairs share notes, so several keys can tie
            best: all.filter(k => k.pct >= bestPct - 0.001)
        };
    }

    // ---------------------------------------------------------
    // Correction plan: a pitch shift, in cents, for every frame
    // ---------------------------------------------------------

    function smoothRuns(values, midi, hopMs, retuneMs) {

        if (retuneMs <= 0) return values;

        // two one-pole passes (forward + backward) = zero-phase glide
        const alpha = 1 - Math.exp(-hopMs / Math.max(1, retuneMs / 2));
        const n = values.length;
        const out = Float32Array.from(values);

        let k = 0;
        while (k < n) {
            if (isNaN(midi[k])) { k++; continue; }
            let r = k;
            while (r < n && !isNaN(midi[r])) r++;

            let y = out[k];
            for (let i = k; i < r; i++) { y += alpha * (out[i] - y); out[i] = y; }
            y = out[r - 1];
            for (let i = r - 1; i >= k; i--) { y += alpha * (out[i] - y); out[i] = y; }
            k = r;
        }
        return out;
    }

    function planCorrection(track, notes, o) {

        const mask = scaleMask(o.rootPc, o.scale);
        const ref = (o.refCents || 0) / 100;
        const hopMs = (1000 * track.hop) / track.sampleRate;
        const n = track.midi.length;
        const raw = new Float32Array(n);
        const info = [];

        // Strength 1 (100%) means FULL correction with no limits at all:
        // no deadzone, no maximum shift, every note lands exactly on its
        // target. Below 100% the deadzone and shift cap come back as a
        // safety net, and the pull toward the target is scaled down.
        const strength = Math.max(0, Math.min(1, o.strength === undefined ? 1 : o.strength));
        const full = strength >= 1;

        for (const nt of notes) {

            const target = nearestNote(nt.center - ref, o.rootPc, mask, o.chromatic) + ref;

            let offset = (target - nt.center) * 100;

            if (!full) {
                if (Math.abs(offset) < (o.deadzone || 0)) offset = 0;
                const cap = o.maxShift || 150;
                offset = Math.max(-cap, Math.min(cap, offset));
                offset *= strength;
            }

            for (let k = nt.start; k < nt.end; k++) {
                if (isNaN(track.midi[k])) continue;
                const drift = (track.midi[k] - nt.center) * 100;
                raw[k] = offset - o.flatten * drift;
            }

            info.push({ start: nt.start, end: nt.end, center: nt.center, target, offsetCents: offset });
        }

        return {
            shift: smoothRuns(raw, track.midi, hopMs, o.retuneMs),
            notes: info
        };
    }

    // ---------------------------------------------------------
    // TD-PSOLA
    // ---------------------------------------------------------

    function boxLowpass(x, w) {
        const n = x.length, y = new Float32Array(n), half = w >> 1;
        const P = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) P[i + 1] = P[i] + x[i];
        for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
            y[i] = (P[b] - P[a]) / (b - a);
        }
        return y;
    }

    function buildPlan(mono, sr, track, shift, o) {

        o = o || {};

        const hop = track.hop, midi = track.midi, frames = midi.length, n = mono.length;
        const lp = boxLowpass(mono, Math.max(3, Math.round(sr / 2000) | 1));

        const period = new Float64Array(frames);
        for (let k = 0; k < frames; k++) {
            period[k] = isNaN(midi[k]) ? NaN : sr / (440 * Math.pow(2, (midi[k] - 69) / 12));
        }

        function periodAt(pos) {
            const f = pos / hop, k = Math.floor(f), t = f - k;
            const a = period[Math.min(frames - 1, k)], b = period[Math.min(frames - 1, k + 1)];
            if (isNaN(a)) return b;
            if (isNaN(b)) return a;
            return a + (b - a) * t;
        }

        function shiftAt(pos) {
            const f = pos / hop, k = Math.floor(f), t = f - k;
            const a = shift[Math.min(frames - 1, k)], b = shift[Math.min(frames - 1, k + 1)];
            return a + (b - a) * t;
        }

        const plan = { ana: [], left: [], right: [], syn: [], vw: new Float32Array(n), runs: 0 };
        const minActive = o.force ? -1 : 3;
        const fade = Math.round(0.006 * sr);

        let k = 0;
        while (k < frames) {

            if (isNaN(midi[k])) { k++; continue; }

            let r = k;
            while (r < frames && !isNaN(midi[r])) r++;

            let maxShift = 0;
            for (let i = k; i < r; i++) maxShift = Math.max(maxShift, Math.abs(shift[i]));

            const runStart = Math.max(0, k * hop - (hop >> 1));
            const runEnd = Math.min(n - 1, (r - 1) * hop + (hop >> 1));
            k = r;

            if (maxShift < minActive) continue;

            // ----- analysis marks (one per glottal period) -----
            const T0 = periodAt(runStart);
            if (!(T0 > 0)) continue;

            let posSum = 0, negSum = 0;
            for (let p = runStart; p + T0 < runEnd; p += Math.round(T0)) {
                let mx = -Infinity, mn = Infinity;
                for (let i = p; i < p + T0; i++) { if (lp[i] > mx) mx = lp[i]; if (lp[i] < mn) mn = lp[i]; }
                posSum += mx; negSum += -mn;
            }
            const pol = posSum >= negSum ? 1 : -1;

            let best = runStart, bv = -Infinity;
            for (let i = runStart; i < Math.min(n, runStart + Math.round(T0)); i++) {
                if (pol * lp[i] > bv) { bv = pol * lp[i]; best = i; }
            }

            const marks = [best];
            for (;;) {
                const last = marks[marks.length - 1];
                const T = periodAt(last);
                if (!(T > 0)) break;
                const pred = last + T;
                if (pred > runEnd - 0.5 * T) break;

                const lo = Math.round(pred - 0.2 * T), hi = Math.round(pred + 0.2 * T);
                let bi = Math.round(pred), bs = -Infinity;
                for (let i = lo; i <= hi; i++) {
                    const v = pol * lp[i];
                    const pen = 1 - 0.25 * Math.abs(i - pred) / (0.2 * T);
                    const s = v > 0 ? v * pen : v;
                    if (s > bs) { bs = s; bi = i; }
                }
                marks.push(bi);
            }

            const M = marks.length;
            if (M < 4) continue;

            // ----- synthesis -----
            const gapLeft = (i) => (i > 0 ? marks[i] - marks[i - 1] : marks[1] - marks[0]);
            const gapRight = (i) => (i < M - 1 ? marks[i + 1] - marks[i] : marks[M - 1] - marks[M - 2]);

            let idx = 0;
            let tSyn = marks[0];
            const tEnd = marks[M - 1];

            while (tSyn <= tEnd) {

                while (idx + 1 < M && Math.abs(marks[idx + 1] - tSyn) <= Math.abs(marks[idx] - tSyn)) idx++;

                const l = gapLeft(idx), rr = gapRight(idx);
                plan.ana.push(marks[idx]);
                plan.left.push(l);
                plan.right.push(rr);
                plan.syn.push(Math.round(tSyn));

                const ratio = Math.pow(2, shiftAt(tSyn) / 1200);
                tSyn += rr / Math.max(0.5, Math.min(2, ratio));   // at ratio 1 this lands exactly on the next analysis mark
            }

            // ----- how much of this region is replaced by PSOLA output -----
            const a = marks[0], b = marks[M - 1];
            const f = Math.max(1, Math.min(fade, (b - a) >> 2));
            for (let i = a; i <= b; i++) {
                const w = Math.min(1, (i - a) / f, (b - i) / f);
                if (w > plan.vw[i]) plan.vw[i] = w;
            }
            plan.runs++;
        }

        return plan;
    }

    function accumulate(x, plan, out, wsum) {

        const n = x.length;

        for (let e = 0; e < plan.ana.length; e++) {

            const a = plan.ana[e], s = plan.syn[e], l = plan.left[e], r = plan.right[e];

            for (let i = -l; i < 0; i++) {
                const ai = a + i, si = s + i;
                if (ai < 0 || si < 0 || ai >= n || si >= n) continue;
                const w = 0.5 * (1 + Math.cos((Math.PI * i) / l));
                out[si] += x[ai] * w;
                if (wsum) wsum[si] += w;
            }
            for (let i = 0; i < r; i++) {
                const ai = a + i, si = s + i;
                if (ai < 0 || si < 0 || ai >= n || si >= n) continue;
                const w = 0.5 * (1 + Math.cos((Math.PI * i) / r));
                out[si] += x[ai] * w;
                if (wsum) wsum[si] += w;
            }
        }
    }

    // Applies a per-frame shift (cents) to every channel. Marks are found
    // once on the mono mix so left and right stay phase-aligned.
    function applyShift(channels, mono, sr, track, shift, o) {

        const plan = buildPlan(mono, sr, track, shift, o);

        if (plan.runs === 0) return channels.map(c => Float32Array.from(c));

        const n = mono.length;
        const wsum = new Float32Array(n);
        const results = [];

        for (let c = 0; c < channels.length; c++) {

            const x = channels[c];
            const out = new Float32Array(n);
            accumulate(x, plan, out, c === 0 ? wsum : null);

            results.push({ x, out });
        }

        return results.map(({ x, out }) => {
            const y = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const vw = plan.vw[i];
                if (vw > 0 && wsum[i] > 1e-3) y[i] = x[i] * (1 - vw) + (out[i] / wsum[i]) * vw;
                else y[i] = x[i];
            }
            return y;
        });
    }

    // ---------------------------------------------------------
    // Deliberate detuning, so the correction has something real to fix
    // ---------------------------------------------------------

    function makeDetune(track, notes, o) {

        const rand = mulberry32(o.seed || 7);
        const mask = scaleMask(o.rootPc, o.scale);
        const ref = (o.refCents || 0) / 100;
        const hopMs = (1000 * track.hop) / track.sampleRate;
        const minFrames = Math.ceil(0.12 / (track.hop / track.sampleRate));

        const sustained = [];
        notes.forEach((nt, i) => { if (nt.end - nt.start >= minFrames) sustained.push(i); });

        // DEBUG TEST:
        // Deliberately detune a much larger portion of sustained notes
        // so the difference is clearly audible during testing.
        const wrongCount = Math.max(5, Math.round(sustained.length * 0.35));

        const chosenWrong = new Set();
        const pool = sustained.slice();

        while (chosenWrong.size < Math.min(wrongCount, pool.length)) {
            chosenWrong.add(pool[Math.floor(rand() * pool.length)]);
        }
        const raw = new Float32Array(track.midi.length);
        const events = [];

        for (const i of sustained) {

            const nt = notes[i];
            let cents = 0, kind = null;

            if (chosenWrong.has(i)) {
                const base = Math.round(nt.center - ref);
                const options = [2, -2].filter(d => !mask[(((base + d) % 12) + 12) % 12]);
                if (options.length) {
                    cents = 100 * options[Math.floor(rand() * options.length)];
                    kind = "wrong-note";
                }
            } else if (rand() < 0.75) {
                // Stronger off-pitch test: 60–100 cents
                // so the detuned version is clearly audible.
                cents = (60 + rand() * 40) * (rand() < 0.5 ? -1 : 1);
                kind = "off-pitch";
            }

            if (!kind) continue;

            for (let k = nt.start; k < nt.end; k++) if (!isNaN(track.midi[k])) raw[k] = cents;
            events.push({ note: i, start: nt.start, end: nt.end, cents, kind, center: nt.center });
        }

        return { shift: smoothRuns(raw, track.midi, hopMs, 10), events };
    }

    // ---------------------------------------------------------
    // Full job
    // ---------------------------------------------------------

    function process(channels, sr, options, progress) {

        progress = progress || function () { };

        const o = Object.assign({
            rootPc: 0, scale: "major", refCents: 0,
            strength: 1, flatten: 0.2, retuneMs: 20,
            deadzone: 5, maxShift: 150, chromatic: false,
            testDetune: false, seed: 7
        }, options || {});

        const result = { audio: {}, stats: {}, contours: {}, options: o };

        let mono = mixDown(channels);

        progress(0.05, "Tracking pitch");
        let track = trackClean(mono, sr);
        result.stats.original = measure(track, o);
        result.contours.original = Float32Array.from(track.midi);
        result.keyFit = keyFit(track, o);

        let work = channels;

        if (o.testDetune) {
            progress(0.25, "Detuning the vocal for the test");
            const d = makeDetune(track, segmentNotes(track.midi), o);
            work = applyShift(channels, mono, sr, track, d.shift);
            mono = mixDown(work);
            track = trackClean(mono, sr);
            result.stats.detuned = measure(track, o);
            result.contours.detuned = Float32Array.from(track.midi);
            result.audio.detuned = work;
            const hopSec = track.hop / sr;
            result.detuneEvents = d.events.map(e => ({
                startSec: e.start * hopSec, endSec: e.end * hopSec,
                cents: Math.round(e.cents), kind: e.kind
            }));
        }

        progress(0.45, "Planning the correction");
        const notes = segmentNotes(track.midi);
        const plan = planCorrection(track, notes, o);

        progress(0.55, "Retuning");
        const tuned = applyShift(work, mono, sr, track, plan.shift);
        result.audio.tuned = tuned;

        progress(0.85, "Checking the result");
        const after = trackClean(mixDown(tuned), sr);
        result.stats.tuned = measure(after, o);
        result.contours.tuned = Float32Array.from(after.midi);

        result.hop = track.hop;
        result.sampleRate = sr;
        result.notes = plan.notes.length;
        result.corrected = plan.notes.filter(n => Math.abs(n.offsetCents) >= 15).length;   // audible moves only

        progress(1, "Done");
        return result;
    }

    return {
        NOTE_NAMES, SCALES,
        estimateTuning, trackPitch, trackClean, cleanTrack, segmentNotes,
        measure, planCorrection, makeDetune, applyShift, buildPlan, process,
        mixDown, scaleMask, nearestNote
    };
}


/* =========================================================
   BROWSER WRAPPER
   Runs the whole job in a Web Worker so the page stays responsive.
   ========================================================= */

function tuneVocal(channelData, sampleRate, options, onProgress) {

    // Copies, so the page's own AudioBuffer is never detached.
    const channels = channelData.map(c => Float32Array.from(c));

    return new Promise((resolve, reject) => {

        function runHere() {
            try {
                resolve(createTuneEngine().process(channels, sampleRate, options, onProgress));
            } catch (err) {
                reject(err);
            }
        }

        let worker, url;

        try {

            const source =
                "const engine = (" + createTuneEngine.toString() + ")();\n" +
                "self.onmessage = function (e) {\n" +
                "  try {\n" +
                "    const r = engine.process(e.data.channels, e.data.sampleRate, e.data.options,\n" +
                "      function (f, label) { self.postMessage({ progress: f, label: label }); });\n" +
                "    const t = [];\n" +
                "    for (const k in r.audio) r.audio[k].forEach(function (a) { t.push(a.buffer); });\n" +
                "    for (const k in r.contours) t.push(r.contours[k].buffer);\n" +
                "    self.postMessage({ result: r }, t);\n" +
                "  } catch (err) { self.postMessage({ error: String(err && err.stack || err) }); }\n" +
                "};";

            url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            worker = new Worker(url);

            worker.onmessage = (event) => {
                const d = event.data;
                if (d.progress !== undefined) {
                    if (onProgress) onProgress(d.progress, d.label);
                    return;
                }
                URL.revokeObjectURL(url);
                worker.terminate();
                if (d.error) reject(new Error(d.error)); else resolve(d.result);
            };

            worker.onerror = (event) => {
                URL.revokeObjectURL(url);
                worker.terminate();
                reject(new Error(event.message || "Pitch correction worker failed."));
            };

            worker.postMessage({ channels, sampleRate, options });

        } catch (error) {
            runHere();
        }
    });
}

// Beat tuning is cheap enough to run on the main thread.
function estimateBeatTuning(audioBuffer) {
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    const engine = createTuneEngine();
    return engine.estimateTuning(engine.mixDown(channels), audioBuffer.sampleRate);
}

if (typeof window !== "undefined") {
    window.VocalVaultTune = {
        tuneVocal,
        estimateBeatTuning,
        noteNames: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    };
}

if (typeof module !== "undefined") {
    module.exports = { createTuneEngine };
}