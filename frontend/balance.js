/**
 * Vocal Vault — instrument balance (the beat's own instruments vs the vocal)
 *
 * The mix balances voice against beat by OVERALL loudness. A beat's loudness is mostly kick and bass, so the piano, keys,
 * guitars, pads and strings (a small part of that loudness) can sit far under the voice in the 300 Hz - 4 kHz range where they
 * live, and the voice, which is dense in exactly that range, buries them. "I can feel the beat but cannot hear the piano."
 *
 * What a mix engineer does: raise those instruments until they are audible next to the voice, not louder than it.
 * We only have the finished beat (no separate tracks), so:
 *
 *   1. Split the beat, in the frequency domain, into what is SUSTAINED and TONAL (piano, keys, guitars, pads, strings, synths:
 *      steady across time) and what is PERCUSSIVE (snares, claps, hats: steady across frequency, short in time). This is the
 *      classic harmonic / percussive separation (median filters along time and along frequency, then soft masks).
 *   2. Measure how far each group sits under the vocal while the singer is singing, in the range where they compete.
 *   3. Lift each group by just enough to reach the chosen distance under the voice (Subtle / Balanced / Full), never more than
 *      a limit, a little more while the voice is on (when they are masked) and half as much in the gaps.
 *
 * It only ADDS a bounded amount of the separated parts on top of the beat, it never replaces the beat, and bins outside the
 * bands pass through exactly. Kick and bass (below ~150 Hz) are not touched. Where nothing needs lifting, nothing changes.
 */
(function (root) {
    "use strict";

    const PRESETS = {
        subtle:   { label: "Subtle",   gapDb: 10, maxDb: 3.0 },
        balanced: { label: "Balanced", gapDb: 8,  maxDb: 4.5 },
        full:     { label: "Full",     gapDb: 6,  maxDb: 6.0 }
    };
    const FOLLOW = 0.5;          // share of the lift that follows the singing (the rest is always on)

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
    const dbOf = (p) => 10 * Math.log10(Math.max(p, 1e-30));

    function createBalanceEngine(studio) {

        const fft = studio.fft;

        function monoOf(ch) {
            if (ch.length === 1) return ch[0];
            const n = ch[0].length, m = new Float32Array(n);
            for (let c = 0; c < ch.length; c++) { const x = ch[c]; for (let i = 0; i < n; i++) m[i] += x[i] / ch.length; }
            return m;
        }

        function median(a, len) {                                  // insertion sort of a small window
            for (let i = 1; i < len; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
            return a[len >> 1];
        }

        function rampWeight(hz, lo0, lo1, hi0, hi1) {             // 0 below lo0, up to 1 at lo1, flat to hi0, down to 0 at hi1
            if (hz <= lo0 || hz >= hi1) return 0;
            if (hz < lo1) return 0.5 - 0.5 * Math.cos(Math.PI * (hz - lo0) / (lo1 - lo0));
            if (hz <= hi0) return 1;
            return 0.5 + 0.5 * Math.cos(Math.PI * (hz - hi0) / (hi1 - hi0));
        }

        // beatChannels and vocalMono are on the same song timeline. Returns { channels, applied, report, info }.
        function balanceBeat(beatChannels, vocalMono, sr, options) {

            const o = Object.assign({ preset: "balanced" }, options || {});
            const P = o.custom || PRESETS[o.preset];            // o.custom: {gapDb, maxDb} (used by the tests)
            const none = (why) => ({ channels: beatChannels, applied: false, report: why ? [why] : [], info: { skipped: why || "off" } });
            if (!P) return none(null);

            const n = beatChannels[0].length;
            if (n < sr * 3 || !vocalMono || vocalMono.length < sr) return none("Instrument balance skipped: not enough music or singing to judge.");
            let vpk = 0; for (let i = 0; i < vocalMono.length; i += 7) { const a = Math.abs(vocalMono[i]); if (a > vpk) vpk = a; }
            if (vpk < 0.0005) return none("Instrument balance skipped: not enough singing to judge.");

            const N = sr > 60000 ? 4096 : 2048, H = N / 2, bin = sr / N, frames = Math.ceil(n / H) + 1;
            const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
            const kLo = Math.floor(100 / bin), kHi = Math.min(H - 1, Math.ceil(10000 / bin)), nb = kHi - kLo + 1;
            const inBand = (k, a, b) => { const hz = k * bin; return hz >= a && hz <= b; };

            const mono = monoOf(beatChannels);
            const re = new Float64Array(N), im = new Float64Array(N);
            const S = new Float32Array(frames * nb);
            const evM = new Float64Array(frames), evD = new Float64Array(frames);

            // ---- pass A: magnitudes of the beat, band power of the vocal ----
            for (let f = 0; f < frames; f++) {
                const start = (f - 1) * H;
                for (let i = 0; i < N; i++) { const idx = start + i; re[i] = idx >= 0 && idx < n ? mono[idx] * win[i] : 0; im[i] = 0; }
                fft(re, im);
                for (let k = kLo; k <= kHi; k++) S[f * nb + k - kLo] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
                for (let i = 0; i < N; i++) { const idx = start + i; re[i] = idx >= 0 && idx < vocalMono.length ? vocalMono[idx] * win[i] : 0; im[i] = 0; }
                fft(re, im);
                let pm = 0, pd = 0;
                for (let k = kLo; k <= kHi; k++) {
                    const p = re[k] * re[k] + im[k] * im[k];
                    if (inBand(k, 300, 4000)) pm += p;
                    if (inBand(k, 1000, 8000)) pd += p;
                }
                evM[f] = pm; evD[f] = pd;
            }

            // ---- harmonic / percussive soft masks ----
            const Mh = new Float32Array(frames * nb);
            const tw = new Float64Array(9), fw = new Float64Array(17);
            for (let f = 0; f < frames; f++) {
                for (let k = 0; k < nb; k++) {
                    let c = 0; for (let d = -4; d <= 4; d++) { const g = f + d; tw[c++] = S[(g < 0 ? 0 : (g >= frames ? frames - 1 : g)) * nb + k]; }
                    const hm = median(tw, 9);
                    c = 0; for (let d = -8; d <= 8; d++) { const g = k + d; fw[c++] = S[f * nb + (g < 0 ? 0 : (g >= nb ? nb - 1 : g))]; }
                    const pm = median(fw, 17);
                    Mh[f * nb + k] = (hm * hm) / (hm * hm + pm * pm + 1e-20);
                }
            }

            // ---- measure: how far under the voice does each group sit, while the singer is singing? ----
            const lev = Float64Array.from(evM, dbOf), sorted = Float64Array.from(lev).sort();
            const loud = sorted[Math.floor((frames - 1) * 0.9)], thr = loud - 28;
            const singing = new Uint8Array(frames); let nSing = 0;
            for (let f = 0; f < frames; f++) if (lev[f] > thr) { singing[f] = 1; nSing++; }
            if (nSing < 20) return none("Instrument balance skipped: not enough singing to judge.");

            const EH = new Float64Array(frames), EP = new Float64Array(frames);
            for (let f = 0; f < frames; f++) {
                let h = 0, p = 0;
                for (let k = kLo; k <= kHi; k++) {
                    const s = S[f * nb + k - kLo], m = Mh[f * nb + k - kLo];
                    if (inBand(k, 300, 4000)) h += s * s * m * m;
                    if (inBand(k, 1000, 8000)) p += s * s * (1 - m) * (1 - m);
                }
                EH[f] = h; EP[f] = p;
            }
            let sv = 0, svd = 0, sh = 0, sp = 0;
            for (let f = 0; f < frames; f++) if (singing[f]) { sv += evM[f]; svd += evD[f]; sh += EH[f]; sp += EP[f]; }
            const gapH = dbOf(sv / nSing) - dbOf(sh / nSing), gapP = dbOf(svd / nSing) - dbOf(sp / nSing);

            const gapDrums = P.gapDb + 4, maxDrums = Math.max(0, P.maxDb - 1.5);
            // Only lift what is really there: a group more than ~22 dB (tonal) / ~24 dB (percussive) under the voice is not a
            // buried instrument, it is leakage (a kick's tail, a snare's body), and lifting it would only add noise.
            const bH = (sh / nSing > 1e-12 && gapH < 22) ? clamp(gapH - P.gapDb, 0, P.maxDb) : 0;
            const bP = (sp / nSing > 1e-12 && gapP < 24) ? clamp(gapP - gapDrums, 0, maxDrums) : 0;
            const info = { preset: o.custom ? "custom" : o.preset, melodicGapDb: gapH, drumsGapDb: gapP, melodicBoostDb: bH, drumsBoostDb: bP, targetGapDb: P.gapDb, singingPct: 100 * nSing / frames };
            const minLift = o.minLiftDb != null ? o.minLiftDb : 0.3;        // lifts smaller than this are not worth a pass
            if (bH < minLift && bP < minLift) {
                return { channels: beatChannels, applied: false, info,
                    report: [gapH >= 22
                        ? "Checked the instrument balance: this beat has no piano, keys or other tonal instruments to bring out, so nothing was lifted."
                        : `Checked the instrument balance: the piano, keys and other instruments already sit ${gapH.toFixed(1)} dB under the voice, close enough to be heard, so nothing was lifted.`] };
            }

            // ---- per-frame gains: full lift while the voice is on, half in the gaps; smooth, so nothing pumps ----
            const gH = new Float32Array(frames), gP = new Float32Array(frames);
            let act = 0;
            const up = 1 - Math.exp(-1 / 4), down = 1 - Math.exp(-1 / 12);
            for (let f = 0; f < frames; f++) {
                act += ((singing[f] ? 1 : 0) > act ? up : down) * ((singing[f] ? 1 : 0) - act);
                const m = (1 - FOLLOW) + FOLLOW * act;
                gH[f] = Math.pow(10, bH * m / 20); gP[f] = Math.pow(10, bP * m / 20);
            }
            const wH = new Float32Array(nb), wP = new Float32Array(nb);
            for (let k = 0; k < nb; k++) {
                const hz = (k + kLo) * bin;
                wH[k] = rampWeight(hz, 150, 260, 4500, 6500);       // piano / keys / guitars / pads / strings body and clarity
                wP[k] = rampWeight(hz, 500, 1200, 8000, 10000);     // snare crack, claps, hats
            }

            // ---- pass B: apply it to each channel (bins outside the bands pass through exactly) ----
            const channels = beatChannels.map((x) => {
                const out = new Float32Array(n);
                for (let f = 0; f < frames; f++) {
                    const start = (f - 1) * H;
                    if (gH[f] === 1 && gP[f] === 1) {                // nothing to do: same samples the transform would give back
                        for (let i = 0; i < N; i++) { const idx = start + i; if (idx >= 0 && idx < n) out[idx] += x[idx] * win[i] * win[i]; }
                        continue;
                    }
                    for (let i = 0; i < N; i++) { const idx = start + i; re[i] = idx >= 0 && idx < n ? x[idx] * win[i] : 0; im[i] = 0; }
                    fft(re, im);
                    const dh = gH[f] - 1, dp = gP[f] - 1;
                    for (let k = 0; k < nb; k++) {
                        const m = Mh[f * nb + k], fac = 1 + dh * m * wH[k] + dp * (1 - m) * wP[k];
                        if (fac === 1) continue;
                        const kk = k + kLo;
                        re[kk] *= fac; im[kk] *= fac;
                        if (kk > 0 && kk < H) { re[N - kk] *= fac; im[N - kk] *= fac; }
                    }
                    for (let i = 0; i < N; i++) im[i] = -im[i];       // inverse via conjugation
                    fft(re, im);
                    for (let i = 0; i < N; i++) { const idx = start + i; if (idx >= 0 && idx < n) out[idx] += re[i] / N * win[i]; }
                }
                return out;
            });

            const names = [];
            if (bH >= minLift) names.push(`the piano, keys, guitars, pads and other tonal instruments by up to ${bH.toFixed(1)} dB (they sat ${gapH.toFixed(1)} dB under the voice in the 300 Hz - 4 kHz range, now about ${Math.max(P.gapDb, gapH - bH).toFixed(1)} dB)`);
            if (bP >= minLift) names.push(`the snare, claps and hats by up to ${bP.toFixed(1)} dB`);
            return {
                channels, applied: true, info,
                report: [`Instrument balance (${P.label || "custom"}): lifted ${names.join(", and ")}, mostly while you sing, so you can hear them under the voice. The kick and bass were not touched.`]
            };
        }

        return { balanceBeat, PRESETS };
    }

    if (typeof window !== "undefined" && window.VocalVaultStudio && window.VocalVaultStudio.engine) {
        const eng = createBalanceEngine(window.VocalVaultStudio.engine);
        window.VocalVaultBalance = { balanceBeat: eng.balanceBeat, PRESETS: eng.PRESETS, engine: eng };
    }
    if (typeof module !== "undefined") module.exports = { createBalanceEngine: createBalanceEngine, PRESETS: PRESETS };

})(typeof window !== "undefined" ? window : this);
