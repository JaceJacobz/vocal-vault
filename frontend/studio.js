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
        },

        // RBJ low-shelf — used to restore thin kicks / sub weight on instrumentals
        lowShelf(f, dB, sr) {
            const A = Math.pow(10, dB / 40), w = 2 * Math.PI * f / sr, c = Math.cos(w);
            const al = Math.sin(w) / 2 * Math.SQRT2, beta = 2 * Math.sqrt(A) * al;
            return norm(
                A * ((A + 1) - (A - 1) * c + beta),
                2 * A * ((A - 1) - (A + 1) * c),
                A * ((A + 1) - (A - 1) * c - beta),
                (A + 1) + (A - 1) * c + beta,
                -2 * ((A - 1) + (A + 1) * c),
                (A + 1) + (A - 1) * c - beta);
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

        // Smarter de-ess: only when highs spike *relative to the voice*, and
        // never so often that the whole take goes dull.
        const o = Object.assign({
            freq: 5200,
            ratio: 3.5,
            maxCutDb: 7,
            aboveMedianDb: 6.5,
            maxActivePct: 18
        }, options || {});
        const n = channels[0].length;

        // Linkwitz-Riley: low + high sum flat; only high band is reduced.
        const hpSplit = [design.highpass(o.freq, sr), design.highpass(o.freq, sr)];
        const lpSplit = [design.lowpass(o.freq, sr), design.lowpass(o.freq, sr)];
        const highs = channels.map((x) => runCascade(x, hpSplit));

        // Presence band detector (~2–4 kHz) so we know "s" vs bright singing
        const presHp = [design.highpass(2000, sr), design.highpass(2000, sr)];
        const presLp = [design.lowpass(4000, sr), design.lowpass(4000, sr)];
        const presence = channels.map((x) => runCascade(runCascade(x, presHp), presLp));

        // Fast attack / slower release on the sibilance envelope
        const att = Math.exp(-1 / (0.0004 * sr));
        const rel = Math.exp(-1 / (0.035 * sr));
        const envS = new Float32Array(n);
        const envP = new Float32Array(n);
        let eS = 0, eP = 0;
        for (let i = 0; i < n; i++) {
            let aS = 0, aP = 0;
            for (const h of highs) { const v = h[i] < 0 ? -h[i] : h[i]; if (v > aS) aS = v; }
            for (const h of presence) { const v = h[i] < 0 ? -h[i] : h[i]; if (v > aP) aP = v; }
            eS = aS > eS ? att * eS + (1 - att) * aS : rel * eS + (1 - rel) * aS;
            eP = aP > eP ? att * eP + (1 - att) * aP : rel * eP + (1 - rel) * aP;
            envS[i] = eS;
            envP[i] = eP;
        }

        const frame = Math.round(0.005 * sr);
        const levels = [];
        const ratios = [];
        let peakAll = 0;
        for (const x of channels) for (let i = 0; i < n; i++) peakAll = Math.max(peakAll, Math.abs(x[i]));
        const activeGate = peakAll * 0.03;

        for (let i = 0; i + frame <= n; i += frame) {
            let pk = 0, bandS = 0, bandP = 0;
            for (let k = i; k < i + frame; k++) {
                for (const x of channels) { const v = Math.abs(x[k]); if (v > pk) pk = v; }
                if (envS[k] > bandS) bandS = envS[k];
                if (envP[k] > bandP) bandP = envP[k];
            }
            if (pk >= activeGate) {
                levels.push(20 * Math.log10(Math.max(bandS, 1e-9)));
                ratios.push(bandS / Math.max(bandP, 1e-9));
            }
        }

        const result = { thresholdDb: null, maxCutDb: 0, percentTimeActive: 0, applied: false, channels };
        if (levels.length < 20) return result;

        levels.sort((p, q) => p - q);
        ratios.sort((p, q) => p - q);
        const median = levels[levels.length >> 1];
        const ratioMed = ratios[ratios.length >> 1];
        const ratioHi = ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.85))];

        // Adaptive threshold: bright-but-smooth voices get a higher bar;
        // spiky "s"-heavy takes get a lower one.
        let above = o.aboveMedianDb;
        if (ratioHi > ratioMed * 2.2) above = Math.max(5, above - 1.5);  // clear sibilance spikes
        else if (ratioHi < ratioMed * 1.35) above = above + 2;           // already smooth — do less

        let threshold = median + above;
        result.thresholdDb = threshold;

        const slope = 1 - 1 / o.ratio;

        // First pass: measure how often we would cut
        let activeCount = 0;
        const rawCut = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const d = 20 * Math.log10(Math.max(envS[i], 1e-9)) - threshold;
            // Also require highs elevated vs presence (true "s", not just loud bright vowel)
            const ratio = envS[i] / Math.max(envP[i], 1e-9);
            const ratioOk = ratio >= Math.max(0.55, ratioMed * 0.9);
            let cut = (d > 0 && ratioOk) ? Math.min(o.maxCutDb, d * slope) : 0;
            rawCut[i] = cut;
            if (cut > 0.5) activeCount++;
        }

        // If too much of the take would be cut, raise threshold and recompute
        const activePct = 100 * activeCount / n;
        if (activePct > o.maxActivePct) {
            const bump = Math.min(6, (activePct - o.maxActivePct) * 0.25);
            threshold += bump;
            result.thresholdDb = threshold;
            activeCount = 0;
            for (let i = 0; i < n; i++) {
                const d = 20 * Math.log10(Math.max(envS[i], 1e-9)) - threshold;
                const ratio = envS[i] / Math.max(envP[i], 1e-9);
                const ratioOk = ratio >= Math.max(0.55, ratioMed * 0.9);
                let cut = (d > 0 && ratioOk) ? Math.min(o.maxCutDb, d * slope) : 0;
                rawCut[i] = cut;
                if (cut > 0.5) activeCount++;
            }
        }

        // Smooth gain so cuts don't click or pump
        const gAtt = 1 - Math.exp(-1 / (0.003 * sr));
        const gRel = 1 - Math.exp(-1 / (0.04 * sr));
        const gain = new Float32Array(n);
        let g = 1, maxCut = 0, active = 0;
        for (let i = 0; i < n; i++) {
            const want = Math.pow(10, -rawCut[i] / 20);
            g += (want < g ? gAtt : gRel) * (want - g);
            gain[i] = g;
            const cutNow = -20 * Math.log10(Math.max(g, 1e-6));
            if (cutNow > maxCut) maxCut = cutNow;
            if (cutNow > 0.5) active++;
        }

        result.maxCutDb = maxCut;
        result.percentTimeActive = 100 * active / n;
        result.applied = maxCut > 0.6;

        if (!result.applied) return result;

        result.channels = channels.map((x, c) => {
            const out = runCascade(x, lpSplit), h = highs[c];
            for (let i = 0; i < n; i++) out[i] += h[i] * gain[i];
            return out;
        });

        return result;
    }

    // ---------------------------------------------------------
    // 2a. Adaptive de-grind — only when the SOURCE take is already gritty
    // Detects harsh mid-high roughness on voiced frames. Clean takes: no-op.
    // Grindy phone/mic takes: mild dynamic cut in the "grind" band only.
    // ---------------------------------------------------------

    function deGrind(channels, sr, options) {
        // Two jobs, only when the take already has them:
        //  1) Strain (singer pushing) — harsh 1.6–3.5 kHz that mastering makes obvious
        //  2) Grind — rough 3–6.5 kHz texture
        // Clean takes: no-op.
        const o = Object.assign({
            strainLowHz: 1800,
            strainHighHz: 3200,
            grindLowHz: 3500,
            grindHighHz: 6500,
            maxStrainCutDb: 2.5,
            maxGrindCutDb: 3.0,
            minScore: 0.42,
            maxActivePct: 28
        }, options || {});

        const n = channels[0].length;
        if (n < sr * 0.4) return { channels, applied: false, score: 0 };

        const hop = Math.max(1, Math.round(0.01 * sr));
        const frames = Math.ceil(n / hop);

        function bandpass(x, lo, hi) {
            return runCascade(runCascade(x, [design.highpass(lo, sr), design.highpass(lo, sr)]),
                [design.lowpass(hi, sr), design.lowpass(hi, sr)]);
        }

        const mono = new Float32Array(n);
        for (let c = 0; c < channels.length; c++) {
            const x = channels[c];
            for (let i = 0; i < n; i++) mono[i] += x[i] / channels.length;
        }

        const strainCh = channels.map((x) => bandpass(x, o.strainLowHz, o.strainHighHz));
        const grindCh = channels.map((x) => bandpass(x, o.grindLowHz, o.grindHighHz));
        const bodyCh = channels.map((x) => bandpass(x, 250, 1200));

        const sRms = new Float32Array(frames);
        const gRms = new Float32Array(frames);
        const bRms = new Float32Array(frames);
        const zcr = new Float32Array(frames);

        for (let f = 0; f < frames; f++) {
            const a = f * hop, b = Math.min(n, a + hop);
            let es = 0, eg = 0, eb = 0, zc = 0, prev = 0, cnt = 0;
            for (let i = a; i < b; i++) {
                let sv = 0, gv = 0, bv = 0;
                for (let c = 0; c < channels.length; c++) {
                    sv += strainCh[c][i];
                    gv += grindCh[c][i];
                    bv += bodyCh[c][i];
                }
                const inv = 1 / channels.length;
                sv *= inv; gv *= inv; bv *= inv;
                es += sv * sv; eg += gv * gv; eb += bv * bv;
                const v = mono[i];
                if (i > a && ((prev >= 0 && v < 0) || (prev < 0 && v >= 0))) zc++;
                prev = v;
                cnt++;
            }
            const len = Math.max(1, cnt);
            sRms[f] = Math.sqrt(es / len);
            gRms[f] = Math.sqrt(eg / len);
            bRms[f] = Math.sqrt(eb / len);
            zcr[f] = zc / len;
        }

        const bodySorted = Float32Array.from(bRms).sort();
        const bodyLoud = bodySorted[Math.min(frames - 1, Math.floor(frames * 0.85))] || 1e-6;
        const gate = bodyLoud * 0.1;

        let scoreSum = 0, scoreN = 0, hot = 0;
        for (let f = 0; f < frames; f++) {
            if (bRms[f] < gate) continue;
            const strainRatio = sRms[f] / Math.max(bRms[f], 1e-9);
            const grindRatio = gRms[f] / Math.max(bRms[f], 1e-9);
            // Strain reads as hot mids even without high ZCR; grind is noisier
            const strainPart = Math.min(1, Math.max(0, strainRatio - 0.45) * 2.2);
            const grindPart = Math.min(1, Math.max(0, grindRatio - 0.35) * 2.0) * (zcr[f] > 0.12 ? 1 : 0.55);
            const frameScore = Math.min(1, 0.55 * strainPart + 0.45 * grindPart);
            scoreSum += frameScore;
            scoreN++;
            if (frameScore > 0.4) hot++;
        }
        const score = scoreN ? scoreSum / scoreN : 0;
        if (score < o.minScore || hot < 5) {
            return { channels, applied: false, score: Math.round(score * 100) / 100 };
        }

        const strength = Math.min(1, (score - o.minScore) / 0.4);
        const maxStrain = o.maxStrainCutDb * (0.5 + 0.5 * strength);
        const maxGrind = o.maxGrindCutDb * (0.45 + 0.55 * strength);

        // Dynamic gains for each band
        const att = 1 - Math.exp(-hop / (0.01 * sr));
        const rel = 1 - Math.exp(-hop / (0.06 * sr));
        let gS = 1, gG = 1, peakCut = 0, active = 0;
        const gainS = new Float32Array(n);
        const gainG = new Float32Array(n);

        for (let f = 0; f < frames; f++) {
            let wantS = 1, wantG = 1;
            if (bRms[f] >= gate) {
                const sr_ = sRms[f] / Math.max(bRms[f], 1e-9);
                const gr_ = gRms[f] / Math.max(bRms[f], 1e-9);
                if (sr_ > 0.55) {
                    const excess = (sr_ - 0.55) / 0.6;
                    const cutDb = Math.min(maxStrain, excess * maxStrain);
                    wantS = Math.pow(10, -cutDb / 20);
                    if (cutDb > peakCut) peakCut = cutDb;
                    if (cutDb > 0.4) active++;
                }
                if (gr_ > 0.4 && zcr[f] > 0.1) {
                    const excess = (gr_ - 0.4) / 0.7;
                    const cutDb = Math.min(maxGrind, excess * maxGrind);
                    wantG = Math.pow(10, -cutDb / 20);
                    if (cutDb > peakCut) peakCut = cutDb;
                    if (cutDb > 0.4) active++;
                }
            }
            gS += (wantS < gS ? att : rel) * (wantS - gS);
            gG += (wantG < gG ? att : rel) * (wantG - gG);
            const a = f * hop, b = Math.min(n, a + hop);
            for (let i = a; i < b; i++) { gainS[i] = gS; gainG[i] = gG; }
        }

        if (peakCut < 0.7) {
            return { channels, applied: false, score: Math.round(score * 100) / 100 };
        }
        if ((100 * active / Math.max(1, frames)) > o.maxActivePct) {
            return { channels, applied: false, score: Math.round(score * 100) / 100, skipped: "would dull take" };
        }

        // Rebuild: low (<strain) + strained mid * gainS + grind mid * gainG + air (>grind high)
        // Simpler: start from full signal, subtract (1-gain)*band for each
        const out = channels.map((x, c) => {
            const y = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const s = strainCh[c][i];
                const g = grindCh[c][i];
                // Remove full strain/grind bands, add back attenuated
                // Avoid double-counting overlap 3.2–3.5k by weighting
                y[i] = x[i] - s * (1 - gainS[i]) - g * (1 - gainG[i]) * 0.85;
            }
            return y;
        });

        return {
            channels: out,
            applied: true,
            score: Math.round(score * 100) / 100,
            maxCutDb: Math.round(peakCut * 10) / 10,
            kind: "strain+grind"
        };
    }


    // ---------------------------------------------------------
    // 2a-bis. De-strain: tame the moments where the singer PUSHED
    // Strain = the 1.6-3.5 kHz band gets hot relative to the voice's body, and the singer is
    // singing loud. Judged against THIS singer's own take (median), so a naturally bright voice
    // is not flagged, only the moments that are harsher than the rest of the performance.
    // Mastering (presence, saturation, limiting) makes those moments stand out, so the cut
    // happens BEFORE any of that. Clean takes: no-op.
    // ---------------------------------------------------------
    function deStrain(channels, sr, options) {
        // Must stay subtle. Cutting 1.6–3.5 kHz on a large % of the take
        // is what reviewers hear as “singing through mucus” / forced cracks.
        // Only the clearest pushed peaks, and only a little.
        const o = Object.assign({
            lowHz: 1800, highHz: 3200, deadbandDb: 3.5, maxCutDb: 2.2, amount: 0.5,
            attackSec: 0.018, releaseSec: 0.16, analyzeOnly: false
        }, options || {});

        const n = channels[0].length;
        const none = { channels, applied: false, strength: 0, peakCutDb: 0, activePct: 0 };
        if (n < sr * 0.5) return none;

        const hop = Math.max(1, Math.round(0.01 * sr)), frames = Math.ceil(n / hop);
        const bp = (x, lo, hi) => runCascade(runCascade(x, [design.highpass(lo, sr), design.highpass(lo, sr)]),
            [design.lowpass(hi, sr), design.lowpass(hi, sr)]);

        const strainCh = channels.map((x) => bp(x, o.lowHz, o.highHz));
        const bodyCh = channels.map((x) => bp(x, 250, 1200));

        const sRms = new Float32Array(frames), bRms = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            const a = f * hop, b = Math.min(n, a + hop);
            let es = 0, eb = 0;
            for (let i = a; i < b; i++) {
                let sv = 0, bv = 0;
                for (let c = 0; c < channels.length; c++) { sv += strainCh[c][i]; bv += bodyCh[c][i]; }
                sv /= channels.length; bv /= channels.length;
                es += sv * sv; eb += bv * bv;
            }
            const len = Math.max(1, b - a);
            sRms[f] = Math.sqrt(es / len); bRms[f] = Math.sqrt(eb / len);
        }

        // voiced = the body band is within ~20 dB of the voice's loud parts
        const sortedB = Float32Array.from(bRms).sort();
        const bodyLoud = sortedB[Math.min(frames - 1, Math.floor(frames * 0.9))] || 1e-6;
        const gate = bodyLoud * 0.1;

        // smooth over ~5 frames so one vowel or consonant does not trigger it
        const sm = (arr) => { const out = new Float32Array(frames); for (let f = 0; f < frames; f++) { let s = 0, c = 0; for (let k = -2; k <= 2; k++) { const j = f + k; if (j >= 0 && j < frames) { s += arr[j] * arr[j]; c++; } } out[f] = Math.sqrt(s / c); } return out; };
        const sS = sm(sRms), bS = sm(bRms);

        const ratios = [], bodyDbs = [];
        for (let f = 0; f < frames; f++) if (bS[f] >= gate) { ratios.push(20 * Math.log10(Math.max(sS[f], 1e-9) / bS[f])); bodyDbs.push(20 * Math.log10(bS[f])); }
        if (ratios.length < 30) return none;
        const med = (a) => Float32Array.from(a).sort()[Math.floor(a.length / 2)];
        const baseRatioDb = med(ratios), baseBodyDb = med(bodyDbs);

        // per-frame cut: how much harsher than this singer's norm, scaled up when singing loud (pushing)
        const wantCut = new Float32Array(frames);
        let peak = 0, active = 0, sumActive = 0, voiced = 0;
        for (let f = 0; f < frames; f++) {
            if (bS[f] < gate) continue;
            voiced++;
            const r = 20 * Math.log10(Math.max(sS[f], 1e-9) / bS[f]);
            const excess = r - baseRatioDb - o.deadbandDb;
            if (excess <= 0) continue;
            const loud = Math.min(1, Math.max(0, (20 * Math.log10(bS[f]) - baseBodyDb + 3) / 9));   // quiet 0 .. loud 1
            const cut = Math.min(o.maxCutDb, excess * o.amount * (0.45 + 0.55 * loud));
            wantCut[f] = cut;
            if (cut > 0.5) { active++; sumActive += cut; }
            if (cut > peak) peak = cut;
        }

        const activeFrac = active / Math.max(1, voiced), meanActive = active ? sumActive / active : 0;
        const strength = Math.min(1, 0.5 * Math.min(1, activeFrac / 0.08) + 0.5 * Math.min(1, meanActive / 2.5));
        // Need a clear peak and not half the performance — otherwise leave the voice alone
        const info = { strength: (peak < 1.4 || activeFrac > 0.18) ? 0 : strength, peakCutDb: peak, activePct: 100 * activeFrac };
        if (peak < 1.4 || activeFrac > 0.18 || o.analyzeOnly) {
            return Object.assign({ channels, applied: false }, info);
        }

        // smooth gain curve (fast down, slower up)
        const att = 1 - Math.exp(-hop / (o.attackSec * sr)), rel = 1 - Math.exp(-hop / (o.releaseSec * sr));
        const gain = new Float32Array(n);
        let g = 1;
        for (let f = 0; f < frames; f++) {
            const want = Math.pow(10, -wantCut[f] / 20);
            g += (want < g ? att : rel) * (want - g);
            const a = f * hop, b = Math.min(n, a + hop);
            for (let i = a; i < b; i++) gain[i] = g;
        }
        // Narrower cut (~2.5 kHz, Q a bit higher) so body and air stay intact
        const cutLin = Math.pow(10, -o.maxCutDb / 20);
        const cutFilter = design.peaking(2500, -o.maxCutDb, 1.35, sr);
        const out = channels.map((x) => {
            const cutX = runCascade(x, [cutFilter]);
            const y = new Float32Array(n);
            for (let i = 0; i < n; i++) y[i] = x[i] + ((1 - gain[i]) / (1 - cutLin)) * (cutX[i] - x[i]);
            return y;
        });
        return Object.assign({ channels: out, applied: true }, info);
    }


    // ---------------------------------------------------------
    // 2a-ter. Resonance control: the "room and mic" cleanup
    // A home recording leaves a few narrow ringing frequencies (a boxy room mode, a harsh mic peak).
    // Voice harmonics move with the pitch, so over a whole take they average out; a resonance does not.
    // Find the persistent ones, then dip each only while it rings above its usual level.
    // A take with nothing sticking out is returned untouched.
    // ---------------------------------------------------------
    function deResonate(channels, sr, options) {

        // Below ~700 Hz the harmonic lines of a few sung notes look like resonances, so boxy low-mids are left to the auto-EQ
        // and the mud control; this looks for ringing and harshness in the mids and highs.
        const o = Object.assign({ loHz: 700, hiHz: 9000, minExcessDb: 4, maxCutDb: 4.5, maxBands: 5, analyzeOnly: false }, options || {});
        const n = channels[0].length;
        const none = { channels, applied: false, bands: [] };
        if (n < sr * 3) return none;

        const mono = new Float32Array(n);
        for (let c = 0; c < channels.length; c++) for (let i = 0; i < n; i++) mono[i] += channels[c][i] / channels.length;

        // ---- long-term spectrum of the singing ----
        const N = 4096, hop = 2048, frames = Math.floor((n - N) / hop) + 1;
        const lev = new Float32Array(frames);
        for (let f = 0; f < frames; f++) { let e = 0; for (let i = f * hop; i < f * hop + N; i++) e += mono[i] * mono[i]; lev[f] = 10 * Math.log10(e / N + 1e-14); }
        const loud = Float32Array.from(lev).sort()[Math.floor(frames * 0.9)];
        const voiced = []; for (let f = 0; f < frames; f++) if (lev[f] > loud - 25) voiced.push(f);
        if (voiced.length < 10) return none;

        const hann = new Float64Array(N); for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
        const re = new Float64Array(N), im = new Float64Array(N), K = N / 2, avg = new Float64Array(K);
        for (const f of voiced) {
            for (let i = 0; i < N; i++) { re[i] = mono[f * hop + i] * hann[i]; im[i] = 0; }
            fft(re, im);
            for (let k = 0; k < K; k++) avg[k] += re[k] * re[k] + im[k] * im[k];
        }
        // blend over +-1/40 octave in the power domain, just enough to settle bin-to-bin jitter
        const Ldb = new Float64Array(K);
        {
            const pre = new Float64Array(K + 1); for (let k = 0; k < K; k++) pre[k + 1] = pre[k] + avg[k];
            const r16 = Math.pow(2, 1 / 40);
            for (let k = 1; k < K; k++) {
                const a = Math.max(0, Math.min(k - 1, Math.floor(k / r16))), b = Math.min(K, Math.max(k + 2, Math.ceil(k * r16) + 1));
                Ldb[k] = 10 * Math.log10((pre[b] - pre[a]) / (b - a) / voiced.length + 1e-20);
            }
        }

        const binHz = sr / N, kLo = Math.ceil(o.loHz / binHz), kHi = Math.min(K - 2, Math.floor(o.hiHz / binHz));

        // envelope = running median over +-1/4 octave (a peak cannot pull its own reference up)
        const excess = new Float64Array(K);
        const q = Math.pow(2, 0.25);
        for (let k = kLo; k <= kHi; k++) {
            const a = Math.max(1, Math.floor(k / q)), b = Math.min(K - 1, Math.ceil(k * q));
            const w = Array.from(Ldb.subarray(a, b + 1)).sort((x, y) => x - y);
            excess[k] = Ldb[k] - w[w.length >> 1];
        }
        // light smoothing across 3 bins
        const ex = new Float64Array(K);
        for (let k = kLo + 1; k < kHi; k++) ex[k] = (excess[k - 1] + 2 * excess[k] + excess[k + 1]) / 4;

        // ---- pick the strongest persistent peaks, at least 1/3 octave apart ----
        const peaks = [];
        for (let k = kLo + 3; k < kHi - 3; k++) {
            const reach = Math.max(3, Math.round(k * 0.03));
            let isMax = true; for (let d = -reach; d <= reach; d++) if (k + d > kLo && k + d < kHi && ex[k + d] > ex[k]) { isMax = false; break; }
            if (isMax && ex[k] >= o.minExcessDb) peaks.push({ k, excess: ex[k] });
        }
        peaks.sort((a, b) => b.excess - a.excess);
        const chosen = [];
        for (const p of peaks) {
            if (chosen.length >= o.maxBands) break;
            if (chosen.some(c => Math.abs(Math.log2(p.k / c.k)) < 1 / 3)) continue;
            // width at half height -> Q
            let k1 = p.k, k2 = p.k; const half = p.excess / 2;
            while (k1 > kLo && ex[k1] > half) k1--;
            while (k2 < kHi && ex[k2] > half) k2++;
            const fc = p.k * binHz, bw = Math.max((k2 - k1) * binHz, fc * 0.04);
            const depth = Math.min(o.maxCutDb, 0.7 * p.excess);        // the measured excess understates a narrow peak, so ~70% of it is roughly half the real ring
            if (depth < 1) continue;
            chosen.push({ k: p.k, fc, Q: Math.max(3, Math.min(10, fc / bw)), excessDb: p.excess, depthDb: depth });
        }
        const info = { bands: chosen.map(c => ({ hz: Math.round(c.fc), excessDb: +c.excessDb.toFixed(1), cutDb: +c.depthDb.toFixed(1) })) };
        if (!chosen.length || o.analyzeOnly) return Object.assign({ channels, applied: false }, info);

        // ---- dip each one only while it rings above its usual level ----
        const h = Math.max(1, Math.round(0.01 * sr)), nf = Math.ceil(n / h);
        const gateLev = new Float32Array(nf);
        for (let f = 0; f < nf; f++) { let e = 0; const a = f * h, b = Math.min(n, a + h); for (let i = a; i < b; i++) e += mono[i] * mono[i]; gateLev[f] = 10 * Math.log10(e / Math.max(1, b - a) + 1e-14); }
        const gLoud = Float32Array.from(gateLev).sort()[Math.floor(nf * 0.9)];

        let out = channels;
        for (const c of chosen) {
            const bp = runCascade(runCascade(mono, [design.highpass(c.fc / 1.12, sr), design.highpass(c.fc / 1.12, sr)]), [design.lowpass(c.fc * 1.12, sr), design.lowpass(c.fc * 1.12, sr)]);
            const bDb = new Float32Array(nf), ref = [];
            for (let f = 0; f < nf; f++) {
                let e = 0; const a = f * h, b = Math.min(n, a + h); for (let i = a; i < b; i++) e += bp[i] * bp[i];
                bDb[f] = 10 * Math.log10(e / Math.max(1, b - a) + 1e-14);
                if (gateLev[f] > gLoud - 25) ref.push(bDb[f]);
            }
            const p60 = Float32Array.from(ref).sort()[Math.floor(ref.length * 0.6)];
            const att = 1 - Math.exp(-h / (0.008 * sr)), rel = 1 - Math.exp(-h / (0.12 * sr));
            const amt = new Float32Array(n);
            let y = 0.85;
            for (let f = 0; f < nf; f++) {
                const target = gateLev[f] > gLoud - 25 ? Math.max(0.5, Math.min(1, 0.85 + (bDb[f] - p60) / 20)) : 0.5;
                y += (target > y ? att : rel) * (target - y);
                const a = f * h, b = Math.min(n, a + h); for (let i = a; i < b; i++) amt[i] = y;
            }
            const filt = design.peaking(c.fc, -c.depthDb, c.Q, sr);
            out = out.map((x) => {
                const cutX = runCascade(x, [filt]), r2 = new Float32Array(n);
                for (let i = 0; i < n; i++) r2[i] = x[i] + amt[i] * (cutX[i] - x[i]);
                return r2;
            });
        }
        return Object.assign({ channels: out, applied: true }, info);
    }

    // ---------------------------------------------------------
    // 2a-quater. Clean low end for the whole mix
    //   - removes inaudible rumble (4th-order high-pass at 24 Hz; kick and bass notes start well above it)
    //   - keeps everything below ~110 Hz in the centre (bass and kick that swing left and right sound loose and shrink on a phone or club system)
    //   Mono-ing is skipped when the lows are out of phase between the channels, because folding them to mono would erase them.
    // ---------------------------------------------------------
    function tidyLowEnd(channels, sr, options) {

        const o = Object.assign({ subHz: 24, monoBelowHz: 110 }, options || {});
        const report = [];
        const sub = [design.highpass(o.subHz, sr), design.highpass(o.subHz, sr)];

        const rmsOf = (x) => { let s = 0; for (let i = 0; i < x.length; i += 2) s += x[i] * x[i]; return Math.sqrt(s / Math.ceil(x.length / 2) + 1e-30); };
        const lowOf = (x, hz) => runCascade(x, [design.lowpass(hz, sr), design.lowpass(hz, sr)]);

        const before = rmsOf(lowOf(channels[0], o.subHz * 1.2));
        let ch = channels.map((x) => runCascade(x, sub));
        const after = rmsOf(lowOf(ch[0], o.subHz * 1.2));
        const subDb = 20 * Math.log10(before / after);
        if (subDb >= 1.5) report.push(`Removed ${subDb.toFixed(1)} dB of inaudible rumble below ${o.subHz} Hz.`);

        let monoed = false, sideDropDb = 0;
        if (ch.length === 2) {
            const n = ch[0].length, L = ch[0], R = ch[1];
            const lowL = lowOf(L, o.monoBelowHz), lowR = lowOf(R, o.monoBelowHz);
            let sLR = 0, sLL = 0, sRR = 0;
            for (let i = 0; i < n; i += 2) { sLR += lowL[i] * lowR[i]; sLL += lowL[i] ** 2; sRR += lowR[i] ** 2; }
            const corr = sLR / Math.sqrt(sLL * sRR + 1e-30);
            if (sLL + sRR < 1e-12) { /* nothing down there */ }
            else if (corr < 0.3) report.push("The bass and kick are partly out of phase between left and right, so they were left as they are (folding them to mono would thin them out).");
            else {
                const M = new Float32Array(n), S = new Float32Array(n);
                for (let i = 0; i < n; i++) { M[i] = 0.5 * (L[i] + R[i]); S[i] = 0.5 * (L[i] - R[i]); }
                const lowSideBefore = rmsOf(lowOf(S, o.monoBelowHz));
                const Sh = runCascade(S, [design.highpass(o.monoBelowHz, sr), design.highpass(o.monoBelowHz, sr)]);
                const lowSideAfter = rmsOf(lowOf(Sh, o.monoBelowHz * 0.7));
                sideDropDb = 20 * Math.log10(lowSideBefore / Math.max(1e-12, lowSideAfter));
                const nl = new Float32Array(n), nr = new Float32Array(n);
                for (let i = 0; i < n; i++) { nl[i] = M[i] + Sh[i]; nr[i] = M[i] - Sh[i]; }
                ch = [nl, nr]; monoed = true;
                if (sideDropDb >= 3) report.push(`Pulled the bass and kick (below ${o.monoBelowHz} Hz) to the centre — they were ${sideDropDb.toFixed(0)} dB wider than they should be, which gets muddy and loses punch on phones and club systems.`);
            }
        }
        return { channels: ch, report, info: { subDb, monoed, sideDropDb } };
    }

    // ---------------------------------------------------------
    // 2b. Multiband mud control (low-mid vs presence)
    // Only turns down the boxy 200–500 Hz region when it is loud
    // relative to the midrange — never a static “thin the vocal” EQ.
    // ---------------------------------------------------------

    function multibandClean(channels, sr, options) {
        const o = Object.assign({
            lowSplitHz: 400,
            highSplitHz: 2500,
            maxCutDb: 5.5,
            threshDb: 2.5,      // low band may sit this far above mid before cutting
            ratio: 2.2,
            openSec: 0.02,
            closeSec: 0.08
        }, options || {});

        const n = channels[0].length;
        if (n < sr * 0.25) return { channels, applied: false, maxCutDb: 0 };

        // Linkwitz-Riley splits: low | mid | high, sum flat when gains are 1
        const lpLow = [design.lowpass(o.lowSplitHz, sr), design.lowpass(o.lowSplitHz, sr)];
        const hpLow = [design.highpass(o.lowSplitHz, sr), design.highpass(o.lowSplitHz, sr)];
        const lpHigh = [design.lowpass(o.highSplitHz, sr), design.lowpass(o.highSplitHz, sr)];
        const hpHigh = [design.highpass(o.highSplitHz, sr), design.highpass(o.highSplitHz, sr)];

        const lows = channels.map((x) => runCascade(x, lpLow));
        const rest = channels.map((x) => runCascade(x, hpLow));
        const mids = rest.map((x) => runCascade(x, lpHigh));
        const highs = rest.map((x) => runCascade(x, hpHigh));

        // Sidechain from mono low vs mid energy
        const hop = Math.max(1, Math.round(0.008 * sr));
        const frames = Math.ceil(n / hop);
        const lowRms = new Float32Array(frames);
        const midRms = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            const a = f * hop, b = Math.min(n, a + hop);
            let el = 0, em = 0, cnt = 0;
            for (let i = a; i < b; i++) {
                let lv = 0, mv = 0;
                for (let c = 0; c < channels.length; c++) {
                    lv += lows[c][i];
                    mv += mids[c][i];
                }
                lv /= channels.length;
                mv /= channels.length;
                el += lv * lv;
                em += mv * mv;
                cnt++;
            }
            lowRms[f] = Math.sqrt(el / Math.max(1, cnt));
            midRms[f] = Math.sqrt(em / Math.max(1, cnt));
        }

        // Only act on frames that are actually singing (mid has energy)
        const midSorted = Float32Array.from(midRms).sort();
        const midLoud = midSorted[Math.min(frames - 1, Math.floor(frames * 0.85))] || 1e-6;
        const gate = midLoud * 0.08;

        const maxLin = Math.pow(10, -o.maxCutDb / 20);
        const up = 1 - Math.exp(-hop / (o.openSec * sr));
        const down = 1 - Math.exp(-hop / (o.closeSec * sr));
        let g = 1;
        let peakCutDb = 0;
        let active = 0;
        const gain = new Float32Array(n);

        for (let f = 0; f < frames; f++) {
            let want = 1;
            if (midRms[f] >= gate && lowRms[f] > 1e-8) {
                const lowDb = 20 * Math.log10(Math.max(lowRms[f], 1e-12));
                const midDb = 20 * Math.log10(Math.max(midRms[f], 1e-12));
                const excess = lowDb - midDb - o.threshDb;
                if (excess > 0) {
                    // Soft knee: excess dB → cut toward maxCutDb
                    const cutDb = Math.min(o.maxCutDb, excess * (o.ratio - 1));
                    want = Math.pow(10, -cutDb / 20);
                    if (cutDb > peakCutDb) peakCutDb = cutDb;
                    active++;
                }
            }
            const alpha = want < g ? down : up;
            g += alpha * (want - g);
            // Never go below maxLin
            if (g < maxLin) g = maxLin;
            const a = f * hop, b = Math.min(n, a + hop);
            for (let i = a; i < b; i++) gain[i] = g;
        }

        // Skip if barely anything needed (don't report noise)
        if (peakCutDb < 0.8 || active < 4) {
            return { channels, applied: false, maxCutDb: 0 };
        }

        const out = channels.map((_, c) => {
            const y = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                y[i] = lows[c][i] * gain[i] + mids[c][i] + highs[c][i];
            }
            return y;
        });

        return {
            channels: out,
            applied: true,
            maxCutDb: Math.round(peakCutDb * 10) / 10
        };
    }

    // ---------------------------------------------------------
    // 3. Auto-EQ: compare with a healthy vocal curve
    // ---------------------------------------------------------

    // 1/3-octave centres 100 Hz..16 kHz and a healthy long-term vocal
    // level in each (dB, only the shape matters).
    const BAND_CENTRES = [100, 126, 159, 200, 252, 317, 400, 504, 635, 800, 1000, 1260, 1587, 2000, 2520, 3175, 4000, 5040, 6350, 8000, 10079, 12699, 16000];
    // The tone a PRODUCED vocal aims for. The old curve described a natural speaking voice (a big hump around
    // 250 Hz, steep fall above 4 kHz). Pulling every voice toward it added low-mid body and took away presence
    // Leaner low-mids, mild presence — not a bright radio curve. Big top
    // targets on home takes are what kept results from sounding studio-clean.
    const TARGET_DB = [0, 1.2, 2.0, 2.4, 2.5, 2.3, 1.8, 1.2, 0.5, 0.1, -0.2, -0.6, -1.1, -1.4, -1.8, -2.4, -3.2, -4.0, -5.0, -6.2, -7.6, -9.2, -12];

    // Where the corrective EQ may act. Gains are limited so it can fix a
    // problem but never remake the voice.
    const EQ_BANDS = [
        { f: 200, Q: 1.0 }, { f: 320, Q: 1.0 }, { f: 500, Q: 1.0 }, { f: 800, Q: 1.0 },
        { f: 1300, Q: 1.0 }, { f: 2000, Q: 1.0 }, { f: 3200, Q: 1.0 }, { f: 5000, Q: 1.0 }, { f: 8000, Q: 1.0 }
    ];

    // highCut: above 2 kHz the EQ may only trim a little (harshness is the de-esser's job).
    // shelfBoost kept low: big air on home/quiet takes is what keeps them from sounding studio-clean.
    const EQ_LIMITS = { cut: -4.5, boost: 2.5, shelfCut: 0, shelfBoost: 1.5, highCut: -0.5, harshCut: -1.0, totalBoost: 3.2, totalCut: -6, presenceBoost: 1.6, highBoost: 1.8 };

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

        const o = Object.assign({
            cutStrength: 0.6,
            boostStrength: 0.35,
            deadbandDb: 0.9,
            presenceDb: 0.9,
            airDb: 0.85,
            quietTake: false
        }, options || {});
        const rate = sr || 44100;
        const refM = referenceLevel(measuredDb), refT = referenceLevel(TARGET_DB);
        const dev = measuredDb.map((v, i) => (v - refM) - (TARGET_DB[i] - refT));   // + = too much energy here

        // When the vocal looks very unlike the target, that usually means an unusual
        // voice or room, not a fault: do less, never more.
        let sq = 0, cnt = 0;
        BAND_CENTRES.forEach((f, i) => { if (f >= 200 && f <= 8000) { sq += dev[i] * dev[i]; cnt++; } });
        const rmsDev = Math.sqrt(sq / cnt);
        const confidence = clamp(1 - Math.max(0, rmsDev - 5) / 10, 0.45, 1);
        // Quiet / home takes: further reduce how hard we chase a bright studio curve
        const topScale = o.quietTake ? 0.55 : (confidence < 0.75 ? 0.7 : 1);

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

        const maxPresence = (o.quietTake ? 1.0 : EQ_LIMITS.presenceBoost) * topScale;
        const maxHigh = (o.quietTake ? 1.2 : EQ_LIMITS.highBoost) * topScale;
        const maxShelf = (o.quietTake ? 0.9 : EQ_LIMITS.shelfBoost) * topScale;

        const bands = EQ_BANDS.map((b) => {
            let g = wanted(around(b.f));
            // Presence is a gentle lift, not a fixed +2 on top of correction
            if (b.f === 3200) g += Math.min(o.presenceDb, maxPresence) * 0.85 * topScale;
            if (b.f <= 500 && g > 0) g = 0;                                   // never ADD low-mid body
            if (b.f <= 500 && g < 0) g *= 1.15;
            let floor = EQ_LIMITS.cut;
            let ceil = EQ_LIMITS.boost;
            if (b.f >= 5000) {
                floor = EQ_LIMITS.harshCut;
                ceil = maxHigh;
            } else if (b.f >= 3200) {
                floor = EQ_LIMITS.highCut;
                ceil = maxPresence + 0.3;
            } else if (b.f >= 2000) {
                floor = EQ_LIMITS.highCut;
                ceil = Math.min(EQ_LIMITS.boost, 2.0);
            }
            return { f: b.f, Q: b.Q, gainDb: clamp(g, floor, ceil) };
        });

        let hs = 0, hc = 0;
        BAND_CENTRES.forEach((fc, i) => { if (fc >= 8000) { hs += dev[i]; hc++; } });
        // Air is a small shelf only — never stack a large fixed airDb on a correction boost
        const airWant = wanted(hs / hc) + Math.min(o.airDb, maxShelf) * 0.75 * topScale;
        const shelf = { f: 10000, gainDb: clamp(airWant, EQ_LIMITS.shelfCut, maxShelf) };

        // Each band is within its limit, but neighbouring bands ADD. Measure the real
        // combined curve and scale back if it gets too big anywhere.
        const totalBoostCap = o.quietTake ? 2.2 : EQ_LIMITS.totalBoost;
        const response = () => BAND_CENTRES.map((fc) => {
            let r = biquadMagDb(design.highShelf(shelf.f, shelf.gainDb, rate), fc, rate);
            for (const b of bands) r += biquadMagDb(design.peaking(b.f, b.gainDb, b.Q, rate), fc, rate);
            return r;
        });
        let curve = response();
        const top = Math.max(...curve), bottom = Math.min(...curve);
        let scaled = false;
        if (top > totalBoostCap || bottom < EQ_LIMITS.totalCut) {
            const kUp = top > totalBoostCap ? totalBoostCap / top : 1;
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
        // Soft warmth only — high drive + mix reads as gritty "grind" on the voice.
        const o = Object.assign({ drive: 1.35, mix: 0.08 }, options || {});
        const drive = Math.max(1.05, Math.min(2.2, o.drive));
        const mix = Math.max(0, Math.min(0.22, o.mix));
        return channels.map((x) => {
            const out = new Float32Array(x.length);
            for (let i = 0; i < x.length; i++) {
                const v = x[i];
                // Softer than raw tanh(drive*x)/drive — less upper harmonic grit
                const wet = Math.tanh(drive * v * 0.85) / (drive * 0.85);
                out[i] = (1 - mix) * v + mix * wet;
            }
            return out;
        });
    }

    // Soft expander: pull down only the quiet floor so hiss/static between phrases fades, without the
    // musical noise of heavy spectral denoise.
    //
    // The first version decided open/closed from loudness alone, every 10 ms, with no memory. On a quiet take (singing
    // only 15-25 dB above the room noise) every soft note, fade-out and quiet word ending dipped under the threshold, so
    // the gate chattered open and shut on SUNG material: audible "break points" in a vocal that should be smooth.
    // This version:
    //   - counts a frame as singing if it has a clear pitch (periodicity is level-independent, so it works on quiet takes)
    //     or is simply well above the noise
    //   - opens early (it can look ahead, this is offline) and holds open after the last singing
    //   - never closes for a gap shorter than ~0.25 s (a breath between words is not a gap between phrases)
    //   - closes slowly, so what it does do cannot be heard as a step
    //   - works less the closer the take is to the noise (a gate cannot separate them cleanly): at poor signal-to-noise
    //     it backs off, and below the point where it would only chop it does nothing
    function voicedFrames(mono, sr, frames, hop) {

        // 4x-ish downsample (box average), then normalised autocorrelation over 80-1000 Hz lags
        const ds = Math.max(1, Math.round(sr / 11025)), m = Math.floor(mono.length / ds), x = new Float32Array(m);
        for (let i = 0; i < m; i++) { let s = 0; for (let k = 0; k < ds; k++) s += mono[i * ds + k]; x[i] = s / ds; }
        const rate = sr / ds, win = Math.round(0.025 * rate), lagLo = Math.max(2, Math.round(rate / 1000)), lagHi = Math.round(rate / 80);
        const stride = 2, out = new Uint8Array(frames), conf = new Float32Array(frames);
        for (let f = 0; f < frames; f += stride) {
            const centre = Math.round((f * hop + hop / 2) / ds), a = centre - (win >> 1);
            if (a < 0 || a + win + lagHi >= m) continue;
            let e0 = 0; for (let i = 0; i < win; i++) e0 += x[a + i] * x[a + i];
            if (e0 < 1e-12) continue;
            let best = 0;
            for (let lag = lagLo; lag <= lagHi; lag++) {
                let r = 0, e1 = 0;
                for (let i = 0; i < win; i++) { const v = x[a + i + lag]; r += x[a + i] * v; e1 += v * v; }
                const c = r / Math.sqrt(e0 * e1 + 1e-30);
                if (c > best) best = c;
            }
            conf[f] = best; if (f + 1 < frames) conf[f + 1] = best;
            out[f] = best >= 0.5 ? 1 : 0; if (f + 1 < frames) out[f + 1] = out[f];
        }
        return { voiced: out, conf };
    }

    function phraseGate(channels, sr, options) {

        const o = Object.assign({
            depthDb: 7, minDepthDb: 1.5, snrFloorDb: 14, snrSlope: 0.45,
            holdSec: 0.15, preOpenSec: 0.05, minGapSec: 0.25, attackSec: 0.006, releaseSec: 0.15
        }, options || {});
        const n = channels[0].length, hop = Math.max(1, Math.round(0.01 * sr)), frames = Math.ceil(n / hop);
        const none = { channels, applied: false };

        const mono = new Float32Array(n);
        for (let c = 0; c < channels.length; c++) { const x = channels[c]; for (let i = 0; i < n; i++) mono[i] += x[i] / channels.length; }
        const rms = new Float32Array(frames), db = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            let e = 0; const a = f * hop, b = Math.min(n, a + hop);
            for (let i = a; i < b; i++) e += mono[i] * mono[i];
            rms[f] = Math.sqrt(e / Math.max(1, b - a)); db[f] = 20 * Math.log10(rms[f] + 1e-9);
        }
        if (frames < 100) return none;
        const sorted = Float32Array.from(db).sort();
        const noise = sorted[Math.floor(frames * 0.10)], loud = sorted[Math.floor(frames * 0.90)], snr = loud - noise;

        // how much separation is there between the singing and the room? a gate can only hide what it can cleanly tell apart
        const depth = Math.min(o.depthDb, Math.max(0, (snr - o.snrFloorDb) * o.snrSlope));
        if (depth < o.minDepthDb) return Object.assign({}, none, { skipped: "close-to-noise", snrDb: snr });

        const { voiced } = voicedFrames(mono, sr, frames, hop);
        const openDb = noise + 0.4 * snr;
        const sung = new Uint8Array(frames);
        for (let f = 0; f < frames; f++) sung[f] = ((voiced[f] && db[f] > noise + 3) || db[f] >= openDb) ? 1 : 0;

        // hold after, and open before (the gate can look ahead: no clipped word starts)
        const hold = Math.round(o.holdSec / 0.01), pre = Math.round(o.preOpenSec / 0.01), open = new Uint8Array(frames);
        for (let f = 0; f < frames; f++) if (sung[f]) { for (let k = Math.max(0, f - pre); k <= Math.min(frames - 1, f + hold); k++) open[k] = 1; }
        // a quiet stretch shorter than minGap is a pause inside a phrase, not a gap between phrases
        const minGap = Math.round(o.minGapSec / 0.01);
        for (let f = 0; f < frames;) {
            if (open[f]) { f++; continue; }
            let g = f; while (g < frames && !open[g]) g++;
            if (f > 0 && g < frames && g - f < minGap) for (let k = f; k < g; k++) open[k] = 1;
            f = g;
        }

        const floorGain = Math.pow(10, -depth / 20);
        const up = 1 - Math.exp(-hop / (o.attackSec * sr)), down = 1 - Math.exp(-hop / (o.releaseSec * sr));
        const gain = new Float32Array(n);
        let g = 1, closed = 0;
        for (let f = 0; f < frames; f++) {
            const want = open[f] ? 1 : floorGain;
            g += (want < g ? down : up) * (want - g);
            if (g < 0.95) closed++;
            const a = f * hop, b = Math.min(n, a + hop);
            for (let i = a; i < b; i++) gain[i] = g;
        }
        if (closed / frames > 0.55) return none;
        return {
            channels: channels.map((x) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = x[i] * gain[i]; return y; }),
            applied: true, depthDb: Math.round(depth * 10) / 10, snrDb: snr
        };
    }

    // Soften clear inhales between lines — conservative so singing is never ducked.
    function reduceBreaths(channels, sr, options) {
        // Softer default: −11 dB made quiet takes sound over-processed
        const o = Object.assign({ cutDb: 7 }, options || {});
        const n = channels[0].length;
        const hop = Math.max(1, Math.round(0.01 * sr));
        const frames = Math.ceil(n / hop);
        const mono = new Float32Array(n);
        for (let c = 0; c < channels.length; c++) {
            const x = channels[c];
            for (let i = 0; i < n; i++) mono[i] += x[i] / channels.length;
        }
        const rms = new Float32Array(frames);
        const zcr = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            let e = 0, zc = 0, prev = 0;
            const a = f * hop, b = Math.min(n, a + hop);
            for (let i = a; i < b; i++) {
                const v = mono[i];
                e += v * v;
                if (i > a && ((prev >= 0 && v < 0) || (prev < 0 && v >= 0))) zc++;
                prev = v;
            }
            const len = Math.max(1, b - a);
            rms[f] = Math.sqrt(e / len);
            zcr[f] = zc / len;
        }
        const sorted = Float32Array.from(rms).sort();
        const floor = sorted[Math.max(0, Math.floor(frames * 0.08))] || 1e-6;
        const loud = sorted[Math.min(frames - 1, Math.floor(frames * 0.9))] || floor * 10;
        if (loud < floor * 4) return { channels, applied: false };

        // Only moderate energy: above floor, well under sung level
        const lo = Math.max(floor * 2.5, loud * 0.04);
        const hi = Math.min(loud * 0.28, lo * 8);

        const mark = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            // Must look like air noise (high zero-crossings), not a vowel
            if (rms[f] >= lo && rms[f] <= hi && zcr[f] >= 0.12) mark[f] = 1;
        }

        // Keep runs 60 ms – 700 ms only
        const minF = Math.max(2, Math.round(0.06 * sr / hop));
        const maxF = Math.max(minF + 1, Math.round(0.7 * sr / hop));
        for (let f = 0; f < frames; ) {
            if (!mark[f]) { f++; continue; }
            let e = f;
            while (e < frames && mark[e]) e++;
            const len = e - f;
            if (len < minF || len > maxF) {
                for (let i = f; i < e; i++) mark[i] = 0;
            }
            f = e;
        }

        // Never cut into a rising sung onset
        for (let f = 1; f < frames - 3; f++) {
            if (!mark[f]) continue;
            if (rms[f + 1] > loud * 0.4 || rms[f + 2] > loud * 0.4 || rms[f + 3] > loud * 0.45) {
                mark[f] = 0;
            }
            // Also clear if previous frame was already loud (still in a phrase)
            if (rms[f - 1] > loud * 0.35) mark[f] = 0;
        }

        let active = 0;
        for (let f = 0; f < frames; f++) if (mark[f]) active++;
        if (active < 4 || active / frames > 0.12) return { channels, applied: false };

        const target = Math.pow(10, -o.cutDb / 20);
        const up = 1 - Math.exp(-hop / (0.045 * sr));
        const down = 1 - Math.exp(-hop / (0.025 * sr));
        let g = 1;
        const gain = new Float32Array(n);
        for (let f = 0; f < frames; f++) {
            const want = mark[f] ? target : 1;
            g += (want < g ? down : up) * (want - g);
            const a = f * hop, b = Math.min(n, a + hop);
            for (let i = a; i < b; i++) gain[i] = g;
        }
        return {
            channels: channels.map((x) => {
                const y = new Float32Array(n);
                for (let i = 0; i < n; i++) y[i] = x[i] * gain[i];
                return y;
            }),
            applied: true, cutDb: o.cutDb, framesActive: active
        };
    }

    // ---------------------------------------------------------
    // Phrase-level level evening
    // Makes quieter lines closer to louder ones *before* the
    // compressors run, so the compressor does less pumping.
    // Only moves phrases a few dB; never touches true silence.
    // ---------------------------------------------------------

    function phraseEven(channels, sr, options) {
        const o = Object.assign({
            maxBoostDb: 3.0,   // was 4.5 — big lifts of quiet phrases raise noise with them
            maxCutDb: 2.5,
            minPhraseSec: 0.18,
            target: "median"   // median of phrase levels
        }, options || {});

        const n = channels[0].length;
        if (n < sr * 0.8) return { channels, applied: false, phrases: 0 };

        const hop = Math.max(1, Math.round(0.01 * sr));
        const frames = Math.ceil(n / hop);
        const mono = new Float32Array(n);
        for (let c = 0; c < channels.length; c++) {
            const x = channels[c];
            for (let i = 0; i < n; i++) mono[i] += x[i] / channels.length;
        }

        const rms = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            let e = 0;
            const a = f * hop, b = Math.min(n, a + hop);
            for (let i = a; i < b; i++) e += mono[i] * mono[i];
            rms[f] = Math.sqrt(e / Math.max(1, b - a));
        }

        const sorted = Float32Array.from(rms).sort();
        const loud = sorted[Math.min(frames - 1, Math.floor(frames * 0.9))] || 1e-6;
        const floor = sorted[Math.max(0, Math.floor(frames * 0.1))] || 1e-9;
        // Phrase gate: well above noise, under soft singing still counts
        const thr = Math.max(loud * 0.12, floor * 4, 1e-6);

        // Segment continuous runs above threshold
        const minF = Math.max(2, Math.round(o.minPhraseSec * sr / hop));
        const phrases = [];
        for (let f = 0; f < frames; ) {
            if (rms[f] < thr) { f++; continue; }
            let e = f;
            while (e < frames && rms[e] >= thr * 0.85) e++; // allow slight dips inside phrase
            // merge tiny gaps (<80 ms) into the phrase
            while (e < frames) {
                let g = e;
                while (g < frames && rms[g] < thr * 0.85) g++;
                if ((g - e) * hop < 0.08 * sr && g < frames && rms[g] >= thr * 0.85) {
                    e = g;
                    while (e < frames && rms[e] >= thr * 0.85) e++;
                } else break;
            }
            if (e - f >= minF) phrases.push({ start: f, end: e });
            f = Math.max(e, f + 1);
        }

        if (phrases.length < 2) return { channels, applied: false, phrases: phrases.length };

        // RMS of each phrase
        const levels = phrases.map((ph) => {
            let e = 0, cnt = 0;
            for (let f = ph.start; f < ph.end; f++) { e += rms[f] * rms[f]; cnt++; }
            return Math.sqrt(e / Math.max(1, cnt));
        });
        const levelDb = levels.map((v) => 20 * Math.log10(Math.max(v, 1e-12)));
        const sortedDb = levelDb.slice().sort((a, b) => a - b);
        const targetDb = sortedDb[sortedDb.length >> 1]; // median

        // Per-phrase gain (capped)
        const phraseGainDb = levelDb.map((db) => {
            let d = targetDb - db;
            if (d > o.maxBoostDb) d = o.maxBoostDb;
            if (d < -o.maxCutDb) d = -o.maxCutDb;
            // Ignore tiny moves
            if (Math.abs(d) < 0.4) d = 0;
            return d;
        });

        const moved = phraseGainDb.filter((d) => d !== 0).length;
        if (moved < 1) return { channels, applied: false, phrases: phrases.length };

        // Build smooth sample gain curve
        const gain = new Float32Array(n);
        for (let i = 0; i < n; i++) gain[i] = 1;

        const fadeF = Math.max(1, Math.round(0.04 * sr / hop)); // ~40 ms edges
        for (let p = 0; p < phrases.length; p++) {
            const db = phraseGainDb[p];
            if (db === 0) continue;
            const gLin = Math.pow(10, db / 20);
            const a = phrases[p].start;
            const b = phrases[p].end;
            for (let f = a; f < b; f++) {
                // Edge fade inside phrase so joins don't click
                let edge = 1;
                if (f - a < fadeF) edge = (f - a + 1) / (fadeF + 1);
                if (b - 1 - f < fadeF) edge = Math.min(edge, (b - f) / (fadeF + 1));
                const g = 1 + (gLin - 1) * edge;
                const s0 = f * hop, s1 = Math.min(n, s0 + hop);
                for (let i = s0; i < s1; i++) gain[i] = g;
            }
        }

        // One-pole smooth across whole take to kill any remaining steps
        const alpha = 1 - Math.exp(-hop / (0.025 * sr));
        let g = 1;
        for (let f = 0; f < frames; f++) {
            const s0 = f * hop;
            const target = gain[s0];
            g += alpha * (target - g);
            const s1 = Math.min(n, s0 + hop);
            for (let i = s0; i < s1; i++) gain[i] = g;
        }

        const out = channels.map((x) => {
            const y = new Float32Array(n);
            for (let i = 0; i < n; i++) y[i] = x[i] * gain[i];
            return y;
        });

        const maxBoost = Math.max(0, ...phraseGainDb);
        const maxCut = Math.max(0, ...phraseGainDb.map((d) => -d));
        return {
            channels: out,
            applied: true,
            phrases: phrases.length,
            adjusted: moved,
            maxBoostDb: Math.round(maxBoost * 10) / 10,
            maxCutDb: Math.round(maxCut * 10) / 10
        };
    }

    // ---------------------------------------------------------
    // The vocal polish pipeline (high-pass -> multiband -> breaths ->
    // de-ess -> auto-EQ -> phrase evening -> phrase gate).
    // No heavy spectral denoise here — that often adds "static".
    // ---------------------------------------------------------

    function prepareVocal(channels, sr, options) {

        const o = Object.assign({ highPassHz: 85, deEss: true, autoEq: true, breaths: true, gate: true }, options || {});
        const report = [];

        let ch = highPass(channels, sr, o.highPassHz);
        report.push(`Cleaned rumble below ${Math.round(o.highPassHz)} Hz.`);

        if (o.multiband !== false) {
            const mb = multibandClean(ch, sr, o.multibandOpts || undefined);
            ch = mb.channels;
            report.push(mb.applied
                ? `Cleared low-mid mud (multiband) by up to ${mb.maxCutDb} dB — only where it was clouding the voice.`
                : `Checked low-mid mud: already clear.`);
        }

        if (o.breaths !== false) {
            const b = reduceBreaths(ch, sr);
            ch = b.channels;
            report.push(b.applied
                ? `Softened breath noises by about ${b.cutDb} dB.`
                : `Checked for inhales/breaths: none that needed work.`);
        }

        let de = { applied: false, maxCutDb: 0 };
        if (o.deEss) {
            de = deEss(ch, sr);
            ch = de.channels;
            report.push(de.applied
                ? `Tamed harsh "s" / air only where it spiked (up to ${de.maxCutDb.toFixed(1)} dB) — rest of the voice left bright.`
                : `Checked for harsh "s" sounds: none that needed work.`);
        }

        // Is there strain in this take? If so, boost presence/air less: they would spotlight it.
        let strain = { applied: false, strength: 0 };
        let eqOpts = Object.assign({
            presenceDb: 0.9,
            airDb: 0.85,
            quietTake: !!o.quietTake
        }, o.eq || {});
        if (o.quietTake) {
            eqOpts.presenceDb = Math.min(eqOpts.presenceDb != null ? eqOpts.presenceDb : 0.9, 0.75);
            eqOpts.airDb = Math.min(eqOpts.airDb != null ? eqOpts.airDb : 0.85, 0.55);
            eqOpts.boostStrength = Math.min(eqOpts.boostStrength != null ? eqOpts.boostStrength : 0.35, 0.28);
            eqOpts.quietTake = true;
        }
        if (o.deStrain !== false) {
            const probe = deStrain(ch, sr, { analyzeOnly: true });
            strain = probe;
            if (probe.strength > 0) {
                const k = 1 - 0.75 * probe.strength;
                eqOpts = Object.assign({}, eqOpts);
                eqOpts.presenceDb = (eqOpts.presenceDb != null ? eqOpts.presenceDb : 0.9) * k;
                eqOpts.airDb = (eqOpts.airDb != null ? eqOpts.airDb : 0.85) * k;
            }
        }

        let eq = null;
        if (o.autoEq) {
            const spectrum = bandSpectrum(ch, sr);
            if (spectrum) {
                eq = planEq(spectrum, eqOpts, sr);
                ch = applyEq(ch, sr, eq);
                const moved = eq.bands.filter((b) => b.gainDb !== 0);
                const parts = moved.map((b) => `${b.gainDb > 0 ? "+" : ""}${b.gainDb.toFixed(1)} dB at ${b.f >= 1000 ? (b.f / 1000).toFixed(b.f % 1000 ? 1 : 0) + " kHz" : b.f + " Hz"}`);
                parts.push(`${eq.shelf.gainDb > 0 ? "+" : ""}${eq.shelf.gainDb.toFixed(1)} dB of air above 10 kHz`);
                report.push(`Balanced the tone: ${parts.join(", ")}.` + (eq.scaledBack || eq.confidence < 1 ? " (Held back, because this voice is unusual.)" : ""));
            } else {
                report.push("Not enough singing to judge the tone, so the EQ was skipped.");
            }
        }

        // room/mic resonances: persistent narrow peaks the EQ's broad bands cannot reach
        let resonance = { applied: false, bands: [] };
        if (o.deResonate !== false) {
            resonance = deResonate(ch, sr);
            if (resonance.applied) {
                ch = resonance.channels;
                report.push("Softened " + resonance.bands.length + " ringing frequenc" + (resonance.bands.length === 1 ? "y" : "ies") + " from the room and mic (" +
                    resonance.bands.map(b => `${b.hz} Hz −${b.cutDb} dB`).join(", ") + "), dipping only while they ring.");
            }
        }

        // after the EQ, before compression/saturation/limiting can make it louder
        if (o.deStrain !== false && strain.strength > 0) {
            const ds = deStrain(ch, sr);
            ch = ds.channels;
            strain = ds;
            report.push(ds.applied
                ? `Softened the strained moments (up to ${ds.peakCutDb.toFixed(1)} dB in the 1.6-3.5 kHz range, ${ds.activePct.toFixed(0)}% of the singing) and eased the presence boost so mastering does not spotlight them.`
                : `Checked for strained moments: none that needed work.`);
        } else if (o.deStrain !== false) {
            report.push("Checked for strained moments: none that needed work.");
        }

        if (o.phraseEven !== false) {
            const peOpts = Object.assign({}, o.phraseEvenOpts || {});
            if (o.quietTake) {
                peOpts.maxBoostDb = Math.min(peOpts.maxBoostDb != null ? peOpts.maxBoostDb : 3, 2.2);
                peOpts.maxCutDb = Math.min(peOpts.maxCutDb != null ? peOpts.maxCutDb : 2.5, 2.0);
            }
            const pe = phraseEven(ch, sr, peOpts);
            ch = pe.channels;
            report.push(pe.applied
                ? `Evened ${pe.adjusted} of ${pe.phrases} phrases (up to +${pe.maxBoostDb} / −${pe.maxCutDb} dB) so compressors work less hard.`
                : `Checked phrase levels: already even enough.`);
        }

        if (o.gate !== false) {
            const g = phraseGate(ch, sr);
            ch = g.channels;
            report.push(g.applied
                ? `Quieted gaps between phrases by ${g.depthDb} dB (cuts hiss/static in the silences)` + (g.depthDb < 6 ? ", gently, because the take sits fairly close to the room noise" : "") + "."
                : (g.skipped === "close-to-noise"
                    ? `Left the gaps between phrases alone: this take sits close to the room noise, and gating it would chop soft notes.`
                    : `Checked the gaps between phrases: already tight.`));
        }

        return { channels: ch, deEss: de, eq, strain, resonance, report };
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
                // Darker, smoother noise — bright noise tails read as radio static
                const bright = 0.55 - 0.48 * Math.min(1, t / (o.rt60 * 0.65));
                lp += bright * ((r() * 2 - 1) - lp);
                x[i] = lp * env;
            }
            // Extra one-pole darkening so tails aren't hissy
            {
                let y = 0;
                const a = 0.18;
                for (let i = 0; i < len; i++) {
                    y += a * (x[i] - y);
                    x[i] = y;
                }
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

    // Light bus glue only — heavy glue + hard limiting is what turns a
    // clean pre-master vocal into a thin / “cheap mic” sound after master.
    function glue(channels, sr, options) {

        const o = Object.assign({ ratio: 1.6, kneeDb: 8, attackSec: 0.04, releaseSec: 0.28, aboveLoudDb: 7 }, options || {});
        const n = channels[0].length;

        // threshold well above typical level so it only kisses peaks
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
    // Longer release = less pumping / less “crushed mic” texture on vocals.
    function limiter(channels, sr, ceilingDb, options) {

        const o = Object.assign({ lookaheadSec: 0.008, releaseSec: 0.22 }, options || {});
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

    // The whole master: clean the sub-bass, light glue, bring toward the
    // target loudness, and limit to a true-peak ceiling.
    // Defaults favour an open sound: if hitting the target needs heavy
    // limiting, we back off so the vocal keeps the character it had
    // before the master (no “cheap mic after master” collapse).
    function master(channels, sr, options) {

        const o = Object.assign({
            targetLufs: -14,
            ceilingDb: -1,
            glue: true,
            maxLimiterDb: 4.5,   // was 8 — hard limiting was the main quality killer
            meter: null
        }, options || {});
        if (!o.meter) throw new Error("master() needs a loudness meter");

        const measure = (c) => o.meter.integrated(o.meter.momentary(o.meter.hopPowers(c, sr)));

        const tidy = o.tidyLowEnd === false ? { channels: channels.map((x) => runBiquad(x, design.highpass(20, sr))), report: [] } : tidyLowEnd(channels, sr);
        let ch = tidy.channels;
        let glueInfo = { maxReductionDb: 0 };
        if (o.glue) { glueInfo = glue(ch, sr, o.glueOpts); ch = glueInfo.channels; }

        const before = measure(ch);
        // Quiet mixes (e.g. low vocal just matched to the beat) must not be
        // pushed hard: makeup + limiting is what turns them into “cheap mic”.
        const quietMix = before < -16;
        const maxRaise = quietMix ? 3.5 : 5.5;
        const limCap = quietMix ? Math.min(o.maxLimiterDb, 3.2) : o.maxLimiterDb;

        let gainDb = o.targetLufs - before;
        if (gainDb > maxRaise) gainDb = maxRaise;
        // Prefer a slightly quieter target over hard limiting on quiet mixes
        let effectiveTarget = o.targetLufs;
        if (quietMix && (o.targetLufs - before) > maxRaise) {
            effectiveTarget = before + maxRaise;
        }
        let best = null;

        for (let it = 0; it < 6; it++) {

            const k = Math.pow(10, gainDb / 20);
            const lim = limiter(ch.map((x) => x.map((v) => v * k)), sr, o.ceilingDb);

            if (lim.maxReductionDb > limCap) {
                gainDb -= (lim.maxReductionDb - limCap) + 0.3;
                continue;
            }

            const lufs = measure(lim.channels);
            best = { channels: lim.channels, lufs, limiterDb: lim.maxReductionDb, gainDb };
            const err = effectiveTarget - lufs;
            if (Math.abs(err) < 0.4) break;
            if (err > 0 && best.limiterDb > limCap * 0.55) break;
            gainDb += err * 0.8;
            if (gainDb > maxRaise) gainDb = maxRaise;
        }

        if (!best) {
            const lim = limiter(ch, sr, o.ceilingDb);
            best = { channels: lim.channels, lufs: measure(lim.channels), limiterDb: lim.maxReductionDb, gainDb: 0 };
        }

        // True-peak: never add more limiting than limCap — pull level instead
        let tp = truePeakDb(best.channels);
        for (let it = 0; it < 3 && tp > o.ceilingDb + 0.05; it++) {
            const over = tp - o.ceilingDb;
            if ((best.limiterDb || 0) >= limCap * 0.85) {
                // already near the cap: scale the whole mix down, no extra limiting
                const g = Math.pow(10, -(over + 0.1) / 20);
                best.channels = best.channels.map((x) => {
                    const y = new Float32Array(x.length);
                    for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
                    return y;
                });
            } else {
                const lim = limiter(best.channels, sr, o.ceilingDb - over - 0.05);
                best.channels = lim.channels;
                best.limiterDb = Math.max(best.limiterDb || 0, lim.maxReductionDb);
            }
            tp = truePeakDb(best.channels);
        }
        // Final safety: if limiting still over cap, scale down to free headroom
        if ((best.limiterDb || 0) > limCap + 0.15) {
            const pull = (best.limiterDb - limCap) + 0.2;
            const g = Math.pow(10, -pull / 20);
            best.channels = best.channels.map((x) => {
                const y = new Float32Array(x.length);
                for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
                return y;
            });
            best.limiterDb = limCap;
            tp = truePeakDb(best.channels);
        }
        best.lufs = measure(best.channels);

        return {
            channels: best.channels,
            report: {
                lowEnd: tidy.report,
                inputLufs: before,
                outputLufs: best.lufs,
                targetLufs: o.targetLufs,
                truePeakDb: tp,
                limiterMaxDb: best.limiterDb,
                glueMaxDb: glueInfo.maxReductionDb
            }
        };
    }


    // ---------------------------------------------------------
    // Beat enhance (full instrumental): listen across the spectrum
    // and only correct bands that are out of balance — kick, body,
    // chord/harmonic midrange, presence, hi-hats, and air.
    // Still one stereo file (not stem separation).
    // ---------------------------------------------------------

    function rmsDbOf(x) {
        let s = 0;
        for (let i = 0; i < x.length; i++) s += x[i] * x[i];
        return 10 * Math.log10(s / Math.max(1, x.length) + 1e-20);
    }

    function monoOf(channels) {
        const n = channels[0].length;
        const m = new Float32Array(n);
        const ch = channels.length;
        for (let i = 0; i < n; i++) {
            let v = 0;
            for (let c = 0; c < ch; c++) v += channels[c][i];
            m[i] = v / ch;
        }
        return m;
    }

    function bandRmsDb(mono, sr, fLo, fHi) {
        const filtered = runCascade(mono, [
            design.highpass(Math.max(20, fLo), sr, 0.7),
            design.lowpass(Math.min(sr * 0.45, fHi), sr, 0.7)
        ]);
        return rmsDbOf(filtered);
    }

    function peakAbs(channels) {
        let p = 0;
        for (const ch of channels) {
            for (let i = 0; i < ch.length; i++) {
                const a = Math.abs(ch[i]);
                if (a > p) p = a;
            }
        }
        return p;
    }

    /**
     * Soft curve: if relative level is below/above a target window, propose gain.
     * positive wantBoost when energy is low; negative when energy is high.
     */
    function bandCorrection(relDb, lowOk, highOk, maxBoost, maxCut) {
        if (relDb < lowOk) {
            return Math.min(maxBoost, (lowOk - relDb) * 0.55);
        }
        if (relDb > highOk) {
            return -Math.min(maxCut, (relDb - highOk) * 0.45);
        }
        return 0;
    }

    /**
     * Full-spectrum read of the instrumental vs its own midrange anchor.
     * Bands cover drums, bass weight, chord body, presence, hats, air.
     */
    function analyzeBeat(channels, sr) {
        const mono = monoOf(channels);
        const n = mono.length;
        const a0 = Math.floor(n * 0.08);
        const a1 = Math.floor(n * 0.92);
        const slice = mono.subarray(a0, Math.max(a0 + sr, a1)); // at least ~1s

        // Reference = musical midrange (where chords / leads often sit)
        const mid = bandRmsDb(slice, sr, 500, 2000);

        const bands = {
            sub:   bandRmsDb(slice, sr, 35, 70),      // sub / 808 floor
            kick:  bandRmsDb(slice, sr, 55, 100),     // kick fundamental
            body:  bandRmsDb(slice, sr, 100, 200),    // kick beater / low punch
            bass:  bandRmsDb(slice, sr, 90, 280),     // bass guitar / bassline body
            mud:   bandRmsDb(slice, sr, 200, 400),    // boxy low-mid
            chord: bandRmsDb(slice, sr, 350, 700),    // chord / pad body
            harm:  bandRmsDb(slice, sr, 700, 1400),   // harmonic definition
            pres:  bandRmsDb(slice, sr, 1800, 4000),  // attack, snare crack, lead edge
            hat:   bandRmsDb(slice, sr, 6000, 10000), // hi-hats
            air:   bandRmsDb(slice, sr, 10000, 14000) // top air
        };

        const rel = {};
        for (const k of Object.keys(bands)) rel[k] = bands[k] - mid;

        // Target windows: relative to mid (dB). Balanced club/pop instrumental.
        // Correct only outside the window.
        const corr = {
            sub:   bandCorrection(rel.sub,  -4.0,  6.0, 6.0, 2.5),
            kick:  bandCorrection(rel.kick, -3.5,  5.5, 7.0, 2.0),
            body:  bandCorrection(rel.body, -4.0,  4.5, 4.5, 2.0),
            bass:  bandCorrection(rel.bass, -2.5,  4.5, 4.5, 1.5),
            mud:   bandCorrection(rel.mud,  -5.0,  2.5, 1.5, 3.5), // mostly cut mud
            chord: bandCorrection(rel.chord,-4.5,  3.5, 3.5, 2.0),
            harm:  bandCorrection(rel.harm, -4.0,  3.0, 3.0, 2.0),
            pres:  bandCorrection(rel.pres, -5.0,  3.5, 3.0, 2.5),
            hat:   bandCorrection(rel.hat,  -7.0,  4.0, 4.0, 3.5),
            air:   bandCorrection(rel.air,  -9.0,  3.0, 3.0, 2.5)
        };

        // Prefer not to boost mud; if mud correction is positive, shrink it
        if (corr.mud > 0) corr.mud *= 0.35;

        let maxAbs = 0;
        for (const k of Object.keys(corr)) maxAbs = Math.max(maxAbs, Math.abs(corr[k]));
        const needed = maxAbs >= 0.55;

        return { bands, rel, corr, midDb: mid, needed, fullDb: rmsDbOf(slice) };
    }

    /**
     * Apply only the corrections analysis asked for.
     * Covers kick → chords → hats, not just low end.
     */
    function enhanceBeat(channels, sr, options) {
        const o = Object.assign({ strength: 1.0, maxBoostDb: 6.0, protectLows: true }, options || {});
        const analysis = analyzeBeat(channels, sr);
        const report = [];
        const c = analysis.corr;

        const scale = (v) => {
            const s = v * o.strength;
            if (s > 0) return Math.min(o.maxBoostDb, s);
            return -Math.min(4, -s);
        };

        const g = {
            sub: scale(c.sub),
            kick: scale(c.kick),
            body: scale(c.body),
            bass: scale(c.bass),
            mud: scale(c.mud),
            chord: scale(c.chord),
            harm: scale(c.harm),
            pres: scale(c.pres),
            hat: scale(c.hat),
            air: scale(c.air)
        };

        // Cap hat/air lifts — big top boosts make quiet-vocal noise and mic grit
        // obvious once the master raises overall level.
        if (g.hat > 2.0) g.hat = 2.0;
        if (g.air > 1.8) g.air = 1.8;
        if (g.pres > 2.2) g.pres = 2.2;

        // The target windows assume a balanced pop/club beat. Afrobeats, Amapiano and
        // similar styles carry deliberately heavy sub, log drum and kick, so the engine
        // may only lift a thin low end, never cut a strong one.
        if (o.protectLows) {
            g.sub = Math.max(0, g.sub);
            g.kick = Math.max(0, g.kick);
            g.body = Math.max(0, g.body);
            if (g.bass != null) g.bass = Math.max(0, g.bass);
        }

        const filters = [];

        // --- Lows / drums ---
        if (Math.abs(g.sub) >= 0.45) {
            filters.push(design.lowShelf(55, g.sub * 0.9, sr));
        }
        if (Math.abs(g.kick) >= 0.45) {
            filters.push(design.peaking(62, g.kick * 0.7, 0.9, sr));
            if (g.kick > 0) filters.push(design.lowShelf(75, g.kick * 0.35, sr));
        }
        if (Math.abs(g.body) >= 0.45) {
            filters.push(design.peaking(120, g.body, 0.8, sr));
        }

        // --- Bass guitar / bassline (melodic low end, not just kick) ---
        // Keep modest: huge low boost + full-mix peak scale was burying mids/highs
        if (g.bass != null && g.bass >= 0.5) {
            const b = Math.min(3.5, g.bass);
            filters.push(design.peaking(110, b * 0.75, 0.9, sr));
            filters.push(design.peaking(180, b * 0.55, 1.0, sr));
            filters.push(design.lowShelf(140, Math.min(2.0, b * 0.35), sr));
        }

        // --- Low-mid mud vs chord body ---
        if (Math.abs(g.mud) >= 0.45) {
            filters.push(design.peaking(280, g.mud, 0.85, sr));
        }
        if (Math.abs(g.chord) >= 0.45) {
            // harmonic / chord body — makes progressions feel fuller
            filters.push(design.peaking(480, g.chord * 0.85, 0.7, sr));
            filters.push(design.peaking(650, g.chord * 0.5, 0.9, sr));
        }
        if (Math.abs(g.harm) >= 0.45) {
            filters.push(design.peaking(1000, g.harm, 0.75, sr));
        }

        // --- Presence / attack ---
        if (Math.abs(g.pres) >= 0.45) {
            filters.push(design.peaking(2800, g.pres, 0.8, sr));
        }

        // --- Hi-hats & air ---
        if (Math.abs(g.hat) >= 0.45) {
            filters.push(design.peaking(8000, g.hat, 0.7, sr));
        }
        if (Math.abs(g.air) >= 0.45) {
            filters.push(design.highShelf(11000, g.air * 0.85, sr));
        }

        if (!filters.length) {
            report.push("Beat balance already sits well across kick, chords, and highs — left the instrumental alone.");
            return { channels, report, analysis: Object.assign({}, analysis, { gains: g }) };
        }

        const beforePeak = peakAbs(channels);
        let out = channels.map((ch) => runCascade(ch, filters));

        // Section-aware bassline: when the instrumental gets louder (typical
        // chorus / drop), give the bass guitar band a little extra presence.
        // No chorus labels — driven by overall energy only.
        if ((g.bass != null && g.bass >= 1.0) || (analysis.rel && analysis.rel.bass != null && analysis.rel.bass < -3.5)) {
            const mono = monoOf(out);
            const hop = Math.max(1, Math.round(0.05 * sr));
            const frames = Math.ceil(mono.length / hop);
            const e = new Float32Array(frames);
            for (let f = 0; f < frames; f++) {
                const a = f * hop, b = Math.min(mono.length, a + hop);
                let s = 0;
                for (let i = a; i < b; i++) s += mono[i] * mono[i];
                e[f] = Math.sqrt(s / Math.max(1, b - a));
            }
            const sorted = Float32Array.from(e).sort();
            const p60 = sorted[Math.min(frames - 1, Math.floor(frames * 0.6))] || 1e-9;
            const p85 = sorted[Math.min(frames - 1, Math.floor(frames * 0.85))] || p60;
            // Extra boost only on louder frames (0 dB quiet → up to ~2.5 dB hot)
            const baseLift = Math.min(3.5, 1.5 + Math.max(0, g.bass || 0) * 0.4);
            const bassFilters = [
                design.peaking(110, baseLift, 0.9, sr),
                design.peaking(180, baseLift * 0.85, 1.0, sr),
                design.peaking(240, baseLift * 0.55, 1.1, sr),
                design.lowShelf(135, Math.min(3.5, baseLift * 0.45), sr)
            ];
            const lifted = out.map((ch) => runCascade(ch, bassFilters));
            const next = out.map((ch) => new Float32Array(ch.length));
            for (let f = 0; f < frames; f++) {
                const loud = e[f] >= p60 * 0.95;
                const hot = e[f] >= p85 * 0.95;
                // blend: quiet=original EQ, mid=partial lift, hot=full lift
                let w = 0;
                if (hot) w = 1;
                else if (loud) w = 0.7 + 0.3 * Math.min(1, (e[f] - p60) / Math.max(1e-9, p85 - p60));
                else w = 0.65; // quiet parts still get some bass presence under the vocal
                const a = f * hop, b = Math.min(out[0].length, a + hop);
                for (let c = 0; c < out.length; c++) {
                    for (let i = a; i < b; i++) {
                        next[c][i] = out[c][i] * (1 - w) + lifted[c][i] * w;
                    }
                }
            }
            out = next;
            report.push("Lifted the bassline where the beat gets denser (verses a little, choruses more).");
        }

        const afterPeak = peakAbs(out);

        if (afterPeak > 1e-6 && beforePeak > 1e-6) {
            const rise = afterPeak / beforePeak;
            if (rise > 1.35) {
                const sc = 1.35 / rise;
                out = out.map((ch) => {
                    const y = new Float32Array(ch.length);
                    for (let i = 0; i < ch.length; i++) y[i] = ch[i] * sc;
                    return y;
                });
            }
        }

        const line = (label, val, detail) => {
            if (Math.abs(val) < 0.5) return;
            const dir = val > 0 ? "lifted" : "eased";
            report.push(`${label}: ${dir} ${Math.abs(val).toFixed(1)} dB${detail ? " (" + detail + ")" : ""}.`);
        };

        line("Sub / 808 weight", g.sub, "floor");
        line("Kick", g.kick, "thump");
        line("Punch", g.body, "~120 Hz");
        line("Low-mid mud", g.mud, "~280 Hz");
        line("Chord body", g.chord, "progressions / pads");
        line("Harmonic mid", g.harm, "definition");
        line("Presence", g.pres, "attack & edge");
        line("Hi-hats", g.hat, "6–10 kHz");
        line("Air", g.air, "top");

        if (!report.length) {
            report.push("Checked the full beat spectrum — no meaningful changes needed.");
        } else {
            report.unshift("Balanced the instrumental across the spectrum (only bands that needed it):");
        }

        return { channels: out, report, analysis: Object.assign({}, analysis, { gains: g }) };
    }

    return {
        fft, design, biquadMagDb, runBiquad, runCascade,
        highPass, deEss, deStrain, deResonate, tidyLowEnd, bandSpectrum, planEq, applyEq, saturate,
        prepareVocal, finishVocal,
        makeReverbIR, makeEcho, duckCurve, applyDuck, levelBelowVocal,
        glue, limiter, truePeakDb, master,
        analyzeBeat, enhanceBeat,
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

    function enhanceBeat(buffer, options) {
        const ch = channelsOf(buffer);
        const r = engine.enhanceBeat(ch, buffer.sampleRate, options);
        const out = new AudioBuffer({ numberOfChannels: r.channels.length, length: r.channels[0].length, sampleRate: buffer.sampleRate });
        for (let c = 0; c < r.channels.length; c++) out.copyToChannel(r.channels[c], c);
        return { buffer: out, report: r.report, analysis: r.analysis };
    }

    window.VocalVaultStudio = { engine, prepareVocal, finishVocal, renderFx, master, enhanceBeat };
}

if (typeof module !== "undefined") {
    module.exports = { createStudioEngine };
}