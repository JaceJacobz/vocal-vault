/* =========================================================
   VOCAL VAULT — STUDIO CHAIN

   Everything here decides for itself by measuring the audio. The user
   never sets anything.

   Vocal polish (this stage)
     1. high-pass       cleans rumble below the singer's lowest note
     2. de-esser        tames harsh "s" and "t" sounds, only as much as
                        THIS vocal needs
     3. auto-EQ         compares the vocal's tone with a healthy vocal
                        curve and fixes what is off (mud, boxiness,
                        harshness, dullness), gently and with hard limits
     4. warmth          a little harmonic saturation, blended in

   Everything lives in createStudioEngine() on plain Float32Arrays so it
   can be tested in Node. A browser wrapper at the bottom exposes
   window.VocalVaultStudio.
   ========================================================= */

function createStudioEngine() {

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const toDb = (p) => 10 * Math.log10(Math.max(p, 1e-20));

    // ---------------------------------------------------------
    // FFT (radix-2, in place)
    // ---------------------------------------------------------

    function fft(re, im) {

        const n = re.length;

        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }

        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wr = Math.cos(ang), wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let k = 0; k < len / 2; k++) {
                    const a = i + k, b = a + len / 2;
                    const xr = re[b] * cr - im[b] * ci;
                    const xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                    const nr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr; cr = nr;
                }
            }
        }
    }

    // ---------------------------------------------------------
    // Biquad filters (RBJ cookbook) and a processor
    // ---------------------------------------------------------

    function norm(b0, b1, b2, a0, a1, a2) {
        return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
    }

    const design = {

        highpass(f, sr, Q = Math.SQRT1_2) {
            const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
            return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
        },

        lowpass(f, sr, Q = Math.SQRT1_2) {
            const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
            return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
        },

        peaking(f, dB, Q, sr) {
            const A = Math.pow(10, dB / 40), w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
            return norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
        },

        highShelf(f, dB, sr) {
            const A = Math.pow(10, dB / 40), w = 2 * Math.PI * f / sr, c = Math.cos(w);
            const al = Math.sin(w) / 2 * Math.SQRT2, beta = 2 * Math.sqrt(A) * al;
            return norm(
                A * ((A + 1) + (A - 1) * c + beta),
                -2 * A * ((A - 1) + (A + 1) * c),
                A * ((A + 1) + (A - 1) * c - beta),
                (A + 1) - (A - 1) * c + beta,
                2 * ((A - 1) - (A + 1) * c),
                (A + 1) - (A - 1) * c - beta);
        }
    };

    // magnitude of a biquad at one frequency, in dB
    function biquadMagDb(k, f, sr) {
        const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
        const nr = k.b0 + k.b1 * c1 + k.b2 * c2, ni = -(k.b1 * s1 + k.b2 * s2);
        const dr = 1 + k.a1 * c1 + k.a2 * c2, di = -(k.a1 * s1 + k.a2 * s2);
        return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
    }

    function runBiquad(x, k) {
        const out = new Float32Array(x.length);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < x.length; i++) {
            const v = x[i];
            const y = k.b0 * v + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
            x2 = x1; x1 = v; y2 = y1; y1 = y;
            out[i] = y;
        }
        return out;
    }

    const runCascade = (x, filters) => filters.reduce((sig, k) => runBiquad(sig, k), x);

    // ---------------------------------------------------------
    // 1. High-pass
    // ---------------------------------------------------------

    function highPass(channels, sr, cutoffHz) {
        const k = design.highpass(cutoffHz, sr);
        return channels.map((x) => runBiquad(x, k));
    }

    // ---------------------------------------------------------
    // 2. De-esser (split-band: only the high band is turned down)
    // ---------------------------------------------------------

    function deEss(channels, sr, options) {

        const o = Object.assign({ freq: 5000, ratio: 4, maxCutDb: 8, aboveMedianDb: 8 }, options || {});
        const n = channels[0].length;

        // Linkwitz-Riley crossover (two matched 2nd-order filters each side): the
        // low and high bands sum flat, so turning the top band down is a smooth
        // cut with no bump at the split. The high band is where "s" lives.
        const hpSplit = [design.highpass(o.freq, sr), design.highpass(o.freq, sr)];
        const lpSplit = [design.lowpass(o.freq, sr), design.lowpass(o.freq, sr)];
        const highs = channels.map((x) => runCascade(x, hpSplit));

        // One detector for all channels, so the stereo image never wobbles.
        const att = Math.exp(-1 / (0.0005 * sr)), rel = Math.exp(-1 / (0.02 * sr));
        const env = new Float32Array(n);
        let e = 0;
        for (let i = 0; i < n; i++) {
            let a = 0;
            for (const h of highs) { const v = h[i] < 0 ? -h[i] : h[i]; if (v > a) a = v; }
            e = a > e ? att * e + (1 - att) * a : rel * e + (1 - rel) * a;
            env[i] = e;
        }

        // How loud is that band when the singer is singing? Its typical (median)
        // level is the vocal's own baseline; only what rises well above it is an "s".
        // (A percentile would depend on how often "s" occurs; the median does not.)
        const frame = Math.round(0.005 * sr), levels = [];
        let peakAll = 0;
        for (const x of channels) for (let i = 0; i < n; i++) peakAll = Math.max(peakAll, Math.abs(x[i]));
        const activeGate = peakAll * 0.03;                       // about -30 dB from the loudest peak

        for (let i = 0; i + frame <= n; i += frame) {
            let pk = 0, band = 0;
            for (let k = i; k < i + frame; k++) {
                for (const x of channels) { const v = Math.abs(x[k]); if (v > pk) pk = v; }
                if (env[k] > band) band = env[k];
            }
            if (pk >= activeGate) levels.push(20 * Math.log10(Math.max(band, 1e-9)));
        }

        const result = { thresholdDb: null, maxCutDb: 0, percentTimeActive: 0, applied: false, channels };
        if (levels.length < 20) return result;

        levels.sort((p, q) => p - q);
        const median = levels[levels.length >> 1];
        const threshold = median + o.aboveMedianDb;
        result.thresholdDb = threshold;

        const slope = 1 - 1 / o.ratio;
        const gain = new Float32Array(n);
        let maxCut = 0, active = 0;

        for (let i = 0; i < n; i++) {
            const d = 20 * Math.log10(Math.max(env[i], 1e-9)) - threshold;
            const cut = d > 0 ? Math.min(o.maxCutDb, d * slope) : 0;
            gain[i] = Math.pow(10, -cut / 20);
            if (cut > maxCut) maxCut = cut;
            if (cut > 0.5) active++;
        }

        result.maxCutDb = maxCut;
        result.percentTimeActive = 100 * active / n;
        result.applied = maxCut > 0.5;

        if (!result.applied) return result;

        // out = low band (untouched) + high band * gain
        result.channels = channels.map((x, c) => {
            const out = runCascade(x, lpSplit), h = highs[c];
            for (let i = 0; i < n; i++) out[i] += h[i] * gain[i];
            return out;
        });

        return result;
    }

    // ---------------------------------------------------------
    // 3. Auto-EQ: compare with a healthy vocal curve
    // ---------------------------------------------------------

    // 1/3-octave centres 100 Hz..16 kHz and a healthy long-term vocal
    // level in each (dB, only the shape matters).
    const BAND_CENTRES = [100, 126, 159, 200, 252, 317, 400, 504, 635, 800, 1000, 1260, 1587, 2000, 2520, 3175, 4000, 5040, 6350, 8000, 10079, 12699, 16000];
    const TARGET_DB = [2, 4, 6, 7, 7.5, 7, 6, 4.5, 2.5, 1, 0, -1, -2.5, -3.5, -4.5, -5.5, -7, -8.5, -10, -12, -14.5, -17.5, -21];

    // Where the corrective EQ may act. Gains are limited so it can fix a
    // problem but never remake the voice.
    const EQ_BANDS = [
        { f: 200, Q: 1.0 }, { f: 320, Q: 1.0 }, { f: 500, Q: 1.0 }, { f: 800, Q: 1.0 },
        { f: 1300, Q: 1.0 }, { f: 2000, Q: 1.0 }, { f: 3200, Q: 1.0 }, { f: 5000, Q: 1.0 }, { f: 8000, Q: 1.0 }
    ];

    const EQ_LIMITS = { cut: -4.5, boost: 3, shelfCut: -3, shelfBoost: 4, totalBoost: 4.5, totalCut: -6 };

    // average 1/3-octave band spectrum of the singing, in dB
    function bandSpectrum(channels, sr) {

        const N = 4096, hop = 2048, n = channels[0].length;
        const win = new Float64Array(N);
        for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);

        const frames = [];
        let maxPow = 0;

        for (let s = 0; s + N <= n; s += hop) {
            let pw = 0;
            for (const x of channels) for (let i = 0; i < N; i++) pw += x[s + i] * x[s + i];
            pw /= N * channels.length;
            frames.push([s, pw]);
            if (pw > maxPow) maxPow = pw;
        }

        // singing frames only (within 30 dB of the loudest)
        const used = frames.filter((f) => f[1] >= maxPow * 1e-3 && f[1] > 1e-9);
        if (used.length < 8) return null;

        const re = new Float64Array(N), im = new Float64Array(N);
        const acc = new Float64Array(N / 2);

        for (const [s] of used) {
            for (let i = 0; i < N; i++) {
                let v = 0;
                for (const x of channels) v += x[s + i];
                re[i] = (v / channels.length) * win[i]; im[i] = 0;
            }
            fft(re, im);
            for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
        }

        const binHz = sr / N;
        const out = [];
        for (const fc of BAND_CENTRES) {
            const lo = fc / Math.pow(2, 1 / 6), hi = fc * Math.pow(2, 1 / 6);
            let sum = 0;
            for (let k = Math.max(1, Math.ceil(lo / binHz)); k < Math.min(N / 2, Math.ceil(hi / binHz)); k++) sum += acc[k];
            out.push(toDb(sum / used.length));
        }
        return out;
    }

    // Level-independent comparison: both curves are measured against their
    // own average over 500 Hz - 2 kHz.
    function referenceLevel(db) {
        let s = 0, c = 0;
        BAND_CENTRES.forEach((f, i) => { if (f >= 500 && f <= 2000) { s += db[i]; c++; } });
        return s / c;
    }

    function planEq(measuredDb, options, sr) {

        const o = Object.assign({ cutStrength: 0.6, boostStrength: 0.4, deadbandDb: 0.8, presenceDb: 1.0, airDb: 1.5 }, options || {});
        const rate = sr || 44100;
        const refM = referenceLevel(measuredDb), refT = referenceLevel(TARGET_DB);
        const dev = measuredDb.map((v, i) => (v - refM) - (TARGET_DB[i] - refT));   // + = too much energy here

        // When the vocal looks very unlike the target, that usually means an unusual
        // voice or room, not a fault: do less, never more.
        let sq = 0, cnt = 0;
        BAND_CENTRES.forEach((f, i) => { if (f >= 200 && f <= 8000) { sq += dev[i] * dev[i]; cnt++; } });
        const rmsDev = Math.sqrt(sq / cnt);
        const confidence = clamp(1 - Math.max(0, rmsDev - 5) / 10, 0.5, 1);

        // average of the three 1/3-octave bands around a frequency
        const around = (f) => {
            let s = 0, c = 0;
            BAND_CENTRES.forEach((fc, i) => { if (Math.abs(Math.log2(fc / f)) <= 1 / 3 + 1e-6) { s += dev[i]; c++; } });
            return c ? s / c : 0;
        };

        // taking away is safer than adding, so boosts are more cautious
        const wanted = (deviation) => {
            let g = -deviation * (deviation > 0 ? o.cutStrength : o.boostStrength) * confidence;
            return Math.abs(g) < o.deadbandDb ? 0 : g;
        };

        const bands = EQ_BANDS.map((b) => {
            let g = wanted(around(b.f));
            if (b.f === 3200) g += o.presenceDb;
            return { f: b.f, Q: b.Q, gainDb: clamp(g, EQ_LIMITS.cut, EQ_LIMITS.boost) };
        });

        let hs = 0, hc = 0;
        BAND_CENTRES.forEach((fc, i) => { if (fc >= 8000) { hs += dev[i]; hc++; } });
        const shelf = { f: 10000, gainDb: clamp(wanted(hs / hc) + o.airDb, EQ_LIMITS.shelfCut, EQ_LIMITS.shelfBoost) };

        // Each band is within its limit, but neighbouring bands ADD. Measure the real
        // combined curve and scale back if it gets too big anywhere.
        const response = () => BAND_CENTRES.map((fc) => {
            let r = biquadMagDb(design.highShelf(shelf.f, shelf.gainDb, rate), fc, rate);
            for (const b of bands) r += biquadMagDb(design.peaking(b.f, b.gainDb, b.Q, rate), fc, rate);
            return r;
        });
        let curve = response();
        const top = Math.max(...curve), bottom = Math.min(...curve);
        let scaled = false;
        if (top > EQ_LIMITS.totalBoost || bottom < EQ_LIMITS.totalCut) {
            const kUp = top > EQ_LIMITS.totalBoost ? EQ_LIMITS.totalBoost / top : 1;
            const kDown = bottom < EQ_LIMITS.totalCut ? EQ_LIMITS.totalCut / bottom : 1;
            for (const b of bands) b.gainDb *= b.gainDb > 0 ? kUp : kDown;
            shelf.gainDb *= shelf.gainDb > 0 ? kUp : kDown;
            curve = response();
            scaled = true;
        }

        return { bands, shelf, deviationDb: dev, curveDb: curve, confidence, rmsDeviationDb: rmsDev, scaledBack: scaled };
    }

    function applyEq(channels, sr, eqPlan) {
        const filters = [];
        for (const b of eqPlan.bands) if (Math.abs(b.gainDb) >= 0.1) filters.push(design.peaking(b.f, b.gainDb, b.Q, sr));
        if (Math.abs(eqPlan.shelf.gainDb) >= 0.1) filters.push(design.highShelf(eqPlan.shelf.f, eqPlan.shelf.gainDb, sr));
        return channels.map((x) => runCascade(x, filters));
    }

    // ---------------------------------------------------------
    // 4. Warmth: a little saturation, blended in parallel
    // ---------------------------------------------------------

    function saturate(channels, options) {
        const o = Object.assign({ drive: 2, mix: 0.2 }, options || {});
        return channels.map((x) => {
            const out = new Float32Array(x.length);
            for (let i = 0; i < x.length; i++) {
                const wet = Math.tanh(o.drive * x[i]) / o.drive;      // gain 1 for small signals
                out[i] = (1 - o.mix) * x[i] + o.mix * wet;
            }
            return out;
        });
    }

    // ---------------------------------------------------------
    // The vocal polish pipeline (high-pass -> de-ess -> auto-EQ)
    // Returns the audio plus a plain-language report.
    // ---------------------------------------------------------

    function prepareVocal(channels, sr, options) {

        const o = Object.assign({ highPassHz: 85, deEss: true, autoEq: true }, options || {});
        const report = [];

        let ch = highPass(channels, sr, o.highPassHz);
        report.push(`Cleaned rumble below ${Math.round(o.highPassHz)} Hz.`);

        let de = { applied: false, maxCutDb: 0 };
        if (o.deEss) {
            de = deEss(ch, sr);
            ch = de.channels;
            report.push(de.applied
                ? `Tamed harsh "s" sounds by up to ${de.maxCutDb.toFixed(1)} dB.`
                : `Checked for harsh "s" sounds: none that needed work.`);
        }

        let eq = null;
        if (o.autoEq) {
            const spectrum = bandSpectrum(ch, sr);
            if (spectrum) {
                eq = planEq(spectrum, o.eq, sr);
                ch = applyEq(ch, sr, eq);
                const moved = eq.bands.filter((b) => b.gainDb !== 0);
                const parts = moved.map((b) => `${b.gainDb > 0 ? "+" : ""}${b.gainDb.toFixed(1)} dB at ${b.f >= 1000 ? (b.f / 1000).toFixed(b.f % 1000 ? 1 : 0) + " kHz" : b.f + " Hz"}`);
                parts.push(`${eq.shelf.gainDb > 0 ? "+" : ""}${eq.shelf.gainDb.toFixed(1)} dB of air above 10 kHz`);
                report.push(`Balanced the tone: ${parts.join(", ")}.` + (eq.scaledBack || eq.confidence < 1 ? " (Held back, because this voice is unusual.)" : ""));
            } else {
                report.push("Not enough singing to judge the tone, so the EQ was skipped.");
            }
        }

        return { channels: ch, deEss: de, eq, report };
    }

    function finishVocal(channels, options) {
        const o = Object.assign({ saturation: true }, options || {});
        if (!o.saturation) return { channels, report: [] };
        return { channels: saturate(channels, o.sat), report: ["Added a touch of analog-style warmth."] };
    }


    // =========================================================
    // SPACE: reverb + echo that stay out of the singing's way
    // =========================================================

    function mulberry(seed) {
        let a = seed >>> 0;
        return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }

    // A plate-style reverb impulse response, generated: decaying noise that
    // gets darker as it fades (like real rooms), a short pre-delay so the
    // singing stays up front, a few early reflections, unit energy.
    function makeReverbIR(sr, options) {

        const o = Object.assign({ rt60: 1.4, preDelaySec: 0.02 }, options || {});
        const pre = Math.round(o.preDelaySec * sr);
        const len = pre + Math.round(o.rt60 * 1.15 * sr);
        const ir = [new Float32Array(len), new Float32Array(len)];
        const early = [0.007, 0.013, 0.019, 0.029, 0.041, 0.057, 0.073];

        for (let c = 0; c < 2; c++) {

            const r = mulberry(1234 + c * 977), x = ir[c];
            let lp = 0;

            for (let i = pre; i < len; i++) {
                const t = (i - pre) / sr;
                const env = Math.pow(10, -3 * t / o.rt60);                         // -60 dB at rt60
                const bright = 0.85 - 0.73 * Math.min(1, t / (o.rt60 * 0.8));        // darker with time
                lp += bright * ((r() * 2 - 1) - lp);
                x[i] = lp * env;
            }

            early.forEach((sec, k) => {
                const at = pre + Math.round((sec + c * 0.0013 * (k + 1)) * sr);
                if (at < len) x[at] += (k % 2 ? -1 : 1) * 0.9 * Math.pow(0.78, k);
            });

            const fade = Math.round(0.05 * sr);                                    // no click at the end
            for (let i = 0; i < fade; i++) x[len - 1 - i] *= i / fade;
        }

        let e = 0;
        for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) e += ir[c][i] * ir[c][i];
        const g = 1 / Math.sqrt(e / 2);
        for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) ir[c][i] *= g;

        return ir;
    }

    // Short echo, filtered so it sits behind the voice. Slightly different
    // times left and right give it width. Mono in, stereo out.
    function makeEcho(mono, sr, options) {

        const o = Object.assign({ delaySec: 0.12, feedback: 0.28, widthSec: 0.011, hp: 400, lp: 4000, tailSec: 1.5 }, options || {});
        const n = mono.length + Math.round(o.tailSec * sr);
        const padded = new Float32Array(n); padded.set(mono);

        const send = runCascade(padded, [design.highpass(o.hp, sr), design.lowpass(o.lp, sr)]);
        const out = [new Float32Array(n), new Float32Array(n)];

        [0, 1].forEach((c) => {
            const d = Math.round((o.delaySec + c * o.widthSec) * sr), y = out[c];
            for (let i = d; i < n; i++) y[i] = send[i - d] + o.feedback * y[i - d];
        });
        return out;
    }

    // Per-hop (10 ms) gain that dips while the singer is singing and
    // blooms back in the gaps, so effects never smear the words.
    const DUCK_HOP = 0.01;

    function envelopeHops(mono, sr) {
        const hop = Math.round(DUCK_HOP * sr), hops = Math.ceil(mono.length / hop), env = new Float32Array(hops);
        for (let j = 0; j < hops; j++) {
            let s = 0; const a = j * hop, b = Math.min(mono.length, a + hop);
            for (let i = a; i < b; i++) s += mono[i] * mono[i];
            env[j] = Math.sqrt(s / Math.max(1, b - a));
        }
        return env;
    }

    function activeReference(env) {
        const v = Array.from(env).filter((x) => x > 1e-5).sort((p, q) => p - q);
        return v.length ? v[Math.floor(v.length * 0.9)] : 1;
    }

    function duckCurve(vocalMono, sr, options) {

        const o = Object.assign({ depth: 0.55, attackSec: 0.02, releaseSec: 0.25 }, options || {});
        const env = envelopeHops(vocalMono, sr), ref = activeReference(env);
        const aA = 1 - Math.exp(-DUCK_HOP / o.attackSec), aR = 1 - Math.exp(-DUCK_HOP / o.releaseSec);
        const curve = new Float32Array(env.length);
        let g = 1;
        for (let j = 0; j < env.length; j++) {
            const target = 1 - o.depth * clamp(env[j] / ref, 0, 1);
            g += (target - g) * (target < g ? aA : aR);
            curve[j] = g;
        }
        return curve;
    }

    function applyDuck(channels, curve, sr) {
        const hop = Math.round(DUCK_HOP * sr);
        return channels.map((x) => {
            const out = new Float32Array(x.length);
            for (let i = 0; i < x.length; i++) {
                const u = i / hop, j = Math.min(curve.length - 1, Math.floor(u)), k = Math.min(curve.length - 1, j + 1);
                out[i] = x[i] * (curve[j] + (curve[k] - curve[j]) * (u - j));
            }
            return out;
        });
    }

    // Scale an effect so it sits `relDb` below the singing (measured while singing).
    function levelBelowVocal(wet, vocalMono, sr, relDb) {

        const env = envelopeHops(vocalMono, sr), ref = activeReference(env), hop = Math.round(DUCK_HOP * sr);
        let vs = 0, ws = 0, cnt = 0;
        for (let j = 0; j < env.length; j++) {
            if (env[j] < 0.3 * ref) continue;
            const a = j * hop, b = Math.min(vocalMono.length, a + hop);
            for (let i = a; i < b; i++) {
                vs += vocalMono[i] * vocalMono[i];
                for (const w of wet) ws += w[i] * w[i] / wet.length;
                cnt++;
            }
        }
        if (!cnt || ws <= 0) return { channels: wet, gainDb: 0 };
        const gainDb = (10 * Math.log10(vs / cnt)) - relDb - (10 * Math.log10(ws / cnt));
        const g = Math.pow(10, gainDb / 20);
        return { channels: wet.map((x) => x.map((v) => v * g)), gainDb };
    }

    // =========================================================
    // MASTER: glue, loudness, true-peak limiter
    // =========================================================

    // gentle bus compressor: it only touches the loud parts, 1-2 dB typically
    function glue(channels, sr, options) {

        const o = Object.assign({ ratio: 2, kneeDb: 6, attackSec: 0.03, releaseSec: 0.2, aboveLoudDb: 5 }, options || {});
        const n = channels[0].length;

        // threshold from the mix itself: a little above its typical (70th percentile) level
        const blk = Math.round(0.4 * sr), lv = [];
        for (let a = 0; a + blk <= n; a += blk) {
            let sum = 0;
            for (const x of channels) for (let i = a; i < a + blk; i += 4) sum += x[i] * x[i];
            lv.push(10 * Math.log10(Math.max(sum / (blk / 4 * channels.length), 1e-12)));
        }
        if (lv.length < 4) return { channels, thresholdDb: null, maxReductionDb: 0 };
        lv.sort((p, q) => p - q);
        const thr = lv[Math.floor(lv.length * 0.7)] + o.aboveLoudDb;

        const dAtt = Math.exp(-1 / (0.01 * sr)), dRel = Math.exp(-1 / (0.1 * sr));
        const gAtt = Math.exp(-1 / (o.attackSec * sr)), gRel = Math.exp(-1 / (o.releaseSec * sr));
        const slope = 1 - 1 / o.ratio, half = o.kneeDb / 2;
        const gains = new Float32Array(n);
        let env = 0, gr = 0, maxGr = 0;

        for (let i = 0; i < n; i++) {
            let a = 0;
            for (const x of channels) { const v = x[i] < 0 ? -x[i] : x[i]; if (v > a) a = v; }
            env = a > env ? dAtt * env + (1 - dAtt) * a : dRel * env + (1 - dRel) * a;
            const over = 20 * Math.log10(Math.max(env, 1e-9)) - thr;
            let want = 0;
            if (over > half) want = over * slope;
            else if (over > -half) want = slope * (over + half) * (over + half) / (2 * o.kneeDb);
            gr = want > gr ? gAtt * gr + (1 - gAtt) * want : gRel * gr + (1 - gRel) * want;
            if (gr > maxGr) maxGr = gr;
            gains[i] = Math.pow(10, -gr / 20);
        }

        return { channels: channels.map((x) => x.map((v, i) => v * gains[i])), thresholdDb: thr, maxReductionDb: maxGr };
    }

    // Lookahead brickwall limiter. Offline, so the gain is already down
    // when the peak arrives; the result can never exceed the ceiling.
    function limiter(channels, sr, ceilingDb, options) {

        const o = Object.assign({ lookaheadSec: 0.005, releaseSec: 0.08 }, options || {});
        const ceil = Math.pow(10, ceilingDb / 20), n = channels[0].length, L = Math.max(2, Math.round(o.lookaheadSec * sr));

        // gain each sample needs on its own
        const need = new Float32Array(n);
        let any = false;
        for (let i = 0; i < n; i++) {
            let a = 0;
            for (const x of channels) { const v = x[i] < 0 ? -x[i] : x[i]; if (v > a) a = v; }
            need[i] = a > ceil ? ceil / a : 1;
            if (need[i] < 1) any = true;
        }
        if (!any) return { channels, maxReductionDb: 0 };

        // m[j] = min(need[j .. j+L-1])  (sliding minimum)
        const m = new Float32Array(n), dq = new Int32Array(n);
        let head = 0, tail = 0;
        for (let i = n - 1; i >= 0; i--) {
            while (tail > head && need[dq[tail - 1]] >= need[i]) tail--;
            dq[tail++] = i;
            while (dq[head] > i + L - 1) head++;
            m[i] = need[dq[head]];
        }

        // s[i] = average of m over the last L samples: reaches the needed gain
        // exactly at the peak and never overshoots it.
        const s = new Float32Array(n);
        let acc = 0;
        for (let i = 0; i < n; i++) {
            acc += m[i];
            if (i >= L) acc -= m[i - L];
            const count = Math.min(i + 1, L);
            s[i] = (acc + (L - count)) / L;                 // before the start, the gain is 1
        }

        // release: recover slowly toward 1, never above s (so still no overshoot)
        const k = 1 - Math.exp(-1 / (o.releaseSec * sr));
        let g = 1, minG = 1;
        const gain = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            g = Math.min(s[i], g + k * (1 - g));
            gain[i] = g;
            if (g < minG) minG = g;
        }

        return { channels: channels.map((x) => x.map((v, i) => v * gain[i])), maxReductionDb: -20 * Math.log10(minG) };
    }

    // True peak: 4x oversampling with a windowed sinc (catches the peaks
    // between samples that a plain sample check misses).
    function truePeakDb(channels) {

        const R = 4, H = 6, coef = [];
        for (let p = 0; p < R; p++) {
            const c = [];
            for (let k = -H + 1; k <= H; k++) {
                const t = k - p / R;
                const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
                c.push(sinc * (0.5 + 0.5 * Math.cos(Math.PI * t / H)));
            }
            coef.push(c);
        }

        let samplePeak = 0;
        for (const x of channels) for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > samplePeak) samplePeak = v; }

        let peak = samplePeak;
        const gate = samplePeak * 0.5;

        for (const x of channels) {
            for (let i = H; i < x.length - H; i++) {
                if (Math.abs(x[i]) < gate && Math.abs(x[i + 1]) < gate) continue;
                for (let p = 1; p < R; p++) {
                    const c = coef[p]; let v = 0;
                    for (let k = 0; k < c.length; k++) v += x[i - H + 1 + k] * c[k];
                    if (v < 0) v = -v;
                    if (v > peak) peak = v;
                }
            }
        }
        return 20 * Math.log10(Math.max(peak, 1e-9));
    }

    // The whole master: clean the sub-bass, glue, bring to the target
    // loudness, and limit to a true-peak ceiling.
    function master(channels, sr, options) {

        const o = Object.assign({ targetLufs: -12, ceilingDb: -1, glue: true, maxLimiterDb: 8, meter: null }, options || {});
        if (!o.meter) throw new Error("master() needs a loudness meter");

        const measure = (c) => o.meter.integrated(o.meter.momentary(o.meter.hopPowers(c, sr)));

        let ch = channels.map((x) => runBiquad(x, design.highpass(20, sr)));        // inaudible rumble
        let glueInfo = { maxReductionDb: 0 };
        if (o.glue) { glueInfo = glue(ch, sr); ch = glueInfo.channels; }

        const before = measure(ch);
        let gainDb = o.targetLufs - before;
        let best = null;

        for (let it = 0; it < 5; it++) {

            const k = Math.pow(10, gainDb / 20);
            const lim = limiter(ch.map((x) => x.map((v) => v * k)), sr, o.ceilingDb);

            if (lim.maxReductionDb > o.maxLimiterDb) { gainDb -= (lim.maxReductionDb - o.maxLimiterDb) + 0.2; continue; }    // too hard: back off

            const lufs = measure(lim.channels);
            best = { channels: lim.channels, lufs, limiterDb: lim.maxReductionDb, gainDb };
            const err = o.targetLufs - lufs;
            if (Math.abs(err) < 0.3) break;
            gainDb += err;
        }

        if (!best) {                                              // extremely unusual: fall back to a safe level
            const lim = limiter(ch, sr, o.ceilingDb);
            best = { channels: lim.channels, lufs: measure(lim.channels), limiterDb: lim.maxReductionDb, gainDb: 0 };
        }

        // inter-sample peaks: if the true peak is above the ceiling, pull the ceiling down by the excess
        let tp = truePeakDb(best.channels);
        for (let it = 0; it < 3 && tp > o.ceilingDb + 0.05; it++) {
            const lim = limiter(best.channels, sr, o.ceilingDb - (tp - o.ceilingDb) - 0.05);
            best.channels = lim.channels;
            tp = truePeakDb(best.channels);
        }
        best.lufs = measure(best.channels);

        return {
            channels: best.channels,
            report: { inputLufs: before, outputLufs: best.lufs, targetLufs: o.targetLufs, truePeakDb: tp, limiterMaxDb: best.limiterDb, glueMaxDb: glueInfo.maxReductionDb }
        };
    }

    return {
        fft, design, biquadMagDb, runBiquad, runCascade,
        highPass, deEss, bandSpectrum, planEq, applyEq, saturate,
        prepareVocal, finishVocal,
        makeReverbIR, makeEcho, duckCurve, applyDuck, levelBelowVocal,
        glue, limiter, truePeakDb, master,
        BAND_CENTRES, TARGET_DB, EQ_LIMITS
    };
}


// ============================================================
// BROWSER WRAPPER
// ============================================================

if (typeof window !== "undefined") {

    const engine = createStudioEngine();

    const channelsOf = (buffer) => {
        const out = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
        return out;
    };

    const toBuffer = (channels, sampleRate) => {
        const buf = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate });
        channels.forEach((x, c) => buf.copyToChannel(x, c));
        return buf;
    };

    // high-pass, de-ess, auto-EQ.  AudioBuffer in, AudioBuffer + plain-language report out.
    function prepareVocal(buffer, options) {
        const r = engine.prepareVocal(channelsOf(buffer), buffer.sampleRate, options);
        return { buffer: toBuffer(r.channels, buffer.sampleRate), report: r.report, details: r };
    }

    // warmth, after compression
    function finishVocal(buffer, options) {
        const r = engine.finishVocal(channelsOf(buffer), options);
        return { buffer: r.channels === channelsOf(buffer) ? buffer : toBuffer(r.channels, buffer.sampleRate), report: r.report };
    }

    // Reverb + echo for the vocal, already placed on the song's timeline.
    // Both duck under the singing and sit well below it in level.
    async function renderFx(leveled, sr, options) {

        const o = Object.assign({
            reverb: true, echo: true,
            reverbBelowDb: 16, echoBelowDb: 22,
            reverbSec: 1.4, echoSec: 0.12,
            duckDepth: 0.5, tailSec: 2.0
        }, options || {});

        const n = leveled[0].length, total = n + Math.round(o.tailSec * sr);
        const right = leveled[1] || leveled[0];
        const mono = new Float32Array(n);
        for (let i = 0; i < n; i++) mono[i] = 0.5 * (leveled[0][i] + right[i]);

        const duck = engine.duckCurve(mono, sr, { depth: o.duckDepth });
        const stems = [], report = [];

        if (o.reverb) {

            // the send: no lows (they only muddy a reverb) and no extreme highs
            const send = engine.runCascade(mono, [engine.design.highpass(300, sr), engine.design.lowpass(7000, sr)]);
            const padded = new Float32Array(total); padded.set(send);

            const ctx = new OfflineAudioContext(2, total, sr);
            const src = ctx.createBufferSource();
            src.buffer = toBuffer([padded], sr);
            const conv = ctx.createConvolver();
            conv.normalize = false;
            conv.buffer = toBuffer(engine.makeReverbIR(sr, { rt60: o.reverbSec }), sr);
            src.connect(conv); conv.connect(ctx.destination); src.start();

            const rendered = await ctx.startRendering();
            const wet = [Float32Array.from(rendered.getChannelData(0)), Float32Array.from(rendered.getChannelData(1))];
            const lv = engine.levelBelowVocal(wet, mono, sr, o.reverbBelowDb);
            stems.push(engine.applyDuck(lv.channels, duck, sr));
            report.push(`Added a ${o.reverbSec.toFixed(1)} second plate-style reverb for depth, ${o.reverbBelowDb} dB below the voice, dipping out of the way while you sing.`);
        }

        if (o.echo) {
            const echo = engine.makeEcho(mono, sr, { delaySec: o.echoSec, tailSec: o.tailSec });
            const lv = engine.levelBelowVocal(echo, mono, sr, o.echoBelowDb);
            stems.push(engine.applyDuck(lv.channels, duck, sr));
            report.push(`Added a short echo (${Math.round(o.echoSec * 1000)} ms) for width, ${o.echoBelowDb} dB below the voice.`);
        }

        const out = [new Float32Array(total), new Float32Array(total)];
        for (const stem of stems) for (let c = 0; c < 2; c++) for (let i = 0; i < Math.min(total, stem[c].length); i++) out[c][i] += stem[c][i];

        return { channels: out, tailSec: o.tailSec, report };
    }

    // glue + loudness + true-peak limiter on the final mix (plain channel arrays in and out)
    function master(channels, sr, options) {
        const meter = window.VocalVaultLevels && window.VocalVaultLevels.engine;
        if (!meter) throw new Error("Mastering needs levelmatch.js loaded first.");
        return engine.master(channels, sr, Object.assign({ meter }, options || {}));
    }

    window.VocalVaultStudio = { engine, prepareVocal, finishVocal, renderFx, master };
}

if (typeof module !== "undefined") {
    module.exports = { createStudioEngine };
}