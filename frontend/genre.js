/**
 * Vocal Vault — genre sensor
 *
 * Listens to the beat (not the vocal) and says which style it most resembles, and how sure it is.
 * It measures things a producer would listen for, then scores them against a "fingerprint" for each style:
 *
 *   - tempo (folding half/double time: 70 BPM trap is the same music as 140)
 *   - where the kick falls in the bar: on the beat, or syncopated
 *   - where the clap / snare falls: beats 2 and 4, or half-time on 3
 *   - how busy the hats / shaker are, and whether they roll
 *   - hand percussion (congas, bongos)
 *   - whether the bass is short and plucky or a long sustained 808
 *
 * It returns a confidence, and when the beat is not clearly one style it says "Universal" instead of guessing.
 * The measuring is the fill engine's beat analysis (tempo grid, drum hits per bar), so the two always agree on the grid.
 */
(function (root) {
    "use strict";

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
    // 0 below lo, rises to 1 at a, stays 1 to b, falls to 0 at hi
    function trap(x, lo, a, b, hi) {
        if (x <= lo || x >= hi) return 0;
        if (x < a) return (x - lo) / (a - lo);
        if (x <= b) return 1;
        return (hi - x) / (hi - b);
    }
    function mean(a) { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : 0; }
    function percentile(arr, p) {
        if (!arr.length) return 0;
        const s = Float64Array.from(arr).sort();
        return s[clamp(Math.floor(p * (s.length - 1)), 0, s.length - 1)];
    }

    const LABELS = {
        afrobeats: "Afrobeats", amapiano: "Amapiano", trap: "Trap / Drill", rap: "Rap / Hip-Hop", rnb: "R&B / Melodic", universal: "Universal"
    };
    const STYLE_OF = { afrobeats: "afrobeats", amapiano: "afrobeats", trap: "trap", rap: "rap", rnb: "rnb", universal: "universal" };

    function createGenreEngine(fillEngine) {

        // How often a real hit lands on each of the 16 steps of the bar, over the bars where the groove is playing.
        // A "hit" has to multiply the band's energy within a few frames (the ripple of a low tone's tail does not count).
        function stepProfile(A, fl, be, bars) {
            const stepF = A.grid.periodFrames / 4, vals = [];
            for (const b of bars) {
                const row = new Float64Array(16);
                for (let s = 0; s < 16; s++) {
                    const c = Math.round(b.startFrame + s * stepF);
                    let m = 0, fm = -1;
                    for (let f = c - 2; f <= c + 2; f++) if (f >= 1 && f < fl.length && fl[f] > m) { m = fl[f]; fm = f; }
                    if (fm < 0) continue;
                    let pre = 0, pc = 0; for (let k = fm - 4; k < fm; k++) if (k >= 0) { pre += be[k]; pc++; }
                    let post = 0; for (let k = fm; k < Math.min(be.length, fm + 4); k++) if (be[k] > post) post = be[k];
                    row[s] = (pc && post > 2.2 * (pre / pc)) ? m : 0;
                }
                vals.push(row);
            }
            // ignore hits that are tiny next to the beat itself (a bass note leaking a little into the hat band is not a hat)
            let lvl = 0, lc = 0; for (const b of bars) { lvl += b.fullLin || 0; lc++; }
            const floor = 0.03 * (lvl / Math.max(1, lc));
            for (const r of vals) for (let s = 0; s < 16; s++) if (r[s] <= floor) r[s] = 0;
            const all = []; for (const r of vals) for (const v of r) if (v > 0) all.push(v);
            const p90 = percentile(all, 0.9) || 1e-9;
            const freq = new Float64Array(16);
            for (const r of vals) for (let s = 0; s < 16; s++) if (r[s] > 0.3 * p90) freq[s]++;
            for (let s = 0; s < 16; s++) freq[s] /= Math.max(1, vals.length);
            return freq;
        }

        // 0 (every note dies at once, a pluck) .. 1 (one long held note, an 808)
        function lowSustain(A, bars) {
            const out = [];
            for (const b of bars) {
                const v = []; for (let f = b.a; f < b.b; f++) v.push(A.E.low[f]);
                if (v.length < 20) continue;
                const hi = percentile(v, 0.9);
                if (hi <= 1e-6) continue;
                out.push(clamp(percentile(v, 0.3) / hi, 0, 1));
            }
            return out.length ? mean(out) : 0;
        }

        function tempoFit(bpm, lo, a, b, hi) {
            // also try half and double time, slightly less trusted
            return Math.max(trap(bpm, lo, a, b, hi), 0.85 * trap(bpm * 2, lo, a, b, hi), 0.85 * trap(bpm / 2, lo, a, b, hi));
        }

        function detect(beatChannels, sr, options) {

            const o = Object.assign({ bpm: 100 }, options || {});
            let A;
            try { A = fillEngine.analyze(beatChannels, sr, { bpm: o.bpm, skipHarmony: true }); } catch (e) { A = null; }
            const unknown = { genre: "universal", styleId: "universal", sub: null, label: LABELS.universal, confidence: 0, scores: {}, features: null, reasons: [], decided: false };
            if (!A) return unknown;

            let bars = A.bars.filter(b => b.groove);
            if (bars.length < 4) bars = A.bars.filter(b => b.on && b.j >= A.grooveStart);
            if (bars.length < 4) return unknown;

            const kickF = stepProfile(A, A.F.kick, A.E.kick, bars), snareF = stepProfile(A, A.F.snare, A.E.snareCombo, bars),
                hatF = stepProfile(A, A.F.hat, A.E.hat, bars), percF = stepProfile(A, A.F.perc, A.E.perc, bars);
            const sum = (a) => a.reduce((s, v) => s + v, 0);
            const onBeat = [0, 4, 8, 12];

            const bpm = A.grid.bpm;
            const kickMain = mean(onBeat.map(s => kickF[s]));
            const kickAll = sum(kickF) + 1e-9;
            let offSum = 0; for (let s = 0; s < 16; s++) if (s % 4 !== 0) offSum += kickF[s];
            const kickSync = offSum / kickAll;
            const backbeat = (snareF[4] + snareF[12]) / 2;
            const halfTime = snareF[8] - Math.max(snareF[4], snareF[12]);
            const hatDensity = mean(Array.from(hatF)), hat16 = mean([1, 3, 5, 7, 9, 11, 13, 15].map(s => hatF[s]));
            const percDensity = mean(Array.from(percF));
            const rolls = bars.filter(b => b.peaks && b.peaks.hat >= 20).length / bars.length;
            const sustain = lowSustain(A, bars);

            const f = { bpm, kickMain, kickSync, backbeat, halfTime, hatDensity, hat16, percDensity, rolls, sustain, bars: bars.length };

            // ---------- the fingerprints ----------
            const S = {};
            const parts = {};
            function score(name, items) {
                let total = 0, wsum = 0; parts[name] = [];
                for (const [label, w, v] of items) { total += w * v; wsum += w; parts[name].push({ label, w, v }); }
                S[name] = total / wsum;
            }

            score("afrobeats", [
                ["a tempo around " + Math.round(bpm) + " BPM that fits Afrobeats", 0.24, tempoFit(bpm, 84, 95, 114, 126)],
                ["a syncopated kick", 0.14, trap(kickSync, 0.15, 0.35, 1, 1.01)],
                ["a kick that is not four-on-the-floor", 0.12, 1 - clamp((kickMain - 0.55) / 0.3, 0, 1)],
                ["a steady 16th-note shaker", 0.18, trap(hat16, 0.3, 0.6, 1, 1.01)],
                ["a clap on beats 2 and 4", 0.14, trap(backbeat, 0.2, 0.5, 1, 1.01)],
                ["a short, plucky bass", 0.10, 1 - clamp((sustain - 0.25) / 0.4, 0, 1)],
                ["no half-time snare", 0.08, 1 - clamp(halfTime / 0.3, 0, 1)]
            ]);

            score("amapiano", [
                ["a tempo around " + Math.round(bpm) + " BPM that fits Amapiano", 0.28, tempoFit(bpm, 102, 108, 116, 122)],
                ["a soft four-on-the-floor kick", 0.30, trap(kickMain, 0.55, 0.8, 1, 1.01)],
                ["a steady 16th-note shaker", 0.16, trap(hat16, 0.3, 0.6, 1, 1.01)],
                ["a sparse clap", 0.10, 1 - clamp((backbeat - 0.4) / 0.4, 0, 1) * 0.5],
                ["a short, plucky low end (log drum)", 0.10, 1 - clamp((sustain - 0.3) / 0.4, 0, 1)],
                ["no half-time snare", 0.06, 1 - clamp(halfTime / 0.3, 0, 1)]
            ]);

            score("trap", [
                ["a tempo around " + Math.round(bpm) + " BPM (or half of it) that fits trap", 0.24, tempoFit(bpm, 125, 135, 172, 185)],
                ["fast 16th hats", 0.18, trap(hat16, 0.3, 0.6, 1, 1.01)],
                ["hat rolls", 0.10, clamp(rolls * 3, 0, 1)],
                ["a long sustained 808", 0.24, trap(sustain, 0.2, 0.45, 1, 1.01)],
                ["a half-time snare on beat 3", 0.14, trap(halfTime, 0.05, 0.35, 1, 1.01)],
                ["a sparse, syncopated kick", 0.10, trap(kickSync, 0.3, 0.55, 1, 1.01)]
            ]);

            score("rap", [
                ["a boom-bap tempo around " + Math.round(bpm) + " BPM", 0.24, tempoFit(bpm, 74, 82, 98, 108)],
                ["a snare on beats 2 and 4", 0.26, trap(backbeat, 0.4, 0.7, 1, 1.01)],
                ["a kick on the beat with a few pushes", 0.14, trap(kickMain, 0.1, 0.4, 0.9, 1.01)],
                ["steady 8th-note hats", 0.14, trap(hatDensity, 0.15, 0.35, 0.6, 0.8)],
                ["no fast 16th hats", 0.12, 1 - clamp((hat16 - 0.25) / 0.4, 0, 1)],
                ["a short-to-medium bass", 0.10, 1 - clamp((sustain - 0.45) / 0.4, 0, 1)]
            ]);

            score("rnb", [
                ["a slow tempo around " + Math.round(bpm) + " BPM", 0.34, tempoFit(bpm, 55, 65, 88, 98)],
                ["sparse hats", 0.20, trap(hatDensity, -0.01, 0.0, 0.45, 0.65)],
                ["a soft backbeat", 0.16, trap(backbeat, 0.2, 0.5, 1, 1.01)],
                ["a sustained low end", 0.18, trap(sustain, 0.15, 0.35, 0.9, 1.01)],
                ["a relaxed kick", 0.12, trap(kickSync, 0.1, 0.3, 0.7, 0.95)]
            ]);

            // Tempo is decisive: a style at a tempo it is never played at is cut down hard.
            const tempoGate = {
                afrobeats: tempoFit(bpm, 84, 95, 114, 126), amapiano: tempoFit(bpm, 102, 108, 116, 122), trap: tempoFit(bpm, 125, 135, 172, 185),
                rap: tempoFit(bpm, 74, 82, 98, 108), rnb: tempoFit(bpm, 55, 65, 88, 98)
            };
            for (const k in tempoGate) S[k] *= 0.5 + 0.5 * tempoGate[k];

            // A style needs positive evidence, not just the absence of other things: without a 16th-note shaker AND a clap
            // (Afrobeats) or a shaker AND a four-on-the-floor kick (Amapiano), the score is cut down.
            const c01 = (x) => clamp(x, 0, 1);
            S.afrobeats *= 0.45 + 0.55 * Math.min(c01(hat16 / 0.5), c01(backbeat / 0.5));
            S.amapiano *= 0.45 + 0.55 * Math.min(c01(hat16 / 0.5), c01(kickMain / 0.7));

            // the fallback: a plain 4/4 pop / dance / anything-else beat
            S.universal = 0.40 + 0.25 * trap(kickMain, 0.6, 0.85, 1, 1.01) * (1 - clamp(kickSync / 0.5, 0, 1)) + 0.10 * tempoFit(bpm, 96, 105, 130, 140);
            parts.universal = [{ label: "an ordinary 4/4 groove", w: 1, v: S.universal }];

            // ---------- decide ----------
            // Afrobeats and Amapiano are one family: how sure we are is judged against the OTHER styles,
            // then the two are told apart.
            const fam = { afrobeats: Math.max(S.afrobeats, S.amapiano), trap: S.trap, rap: S.rap, rnb: S.rnb, universal: S.universal };
            const order = Object.keys(fam).sort((a, b) => fam[b] - fam[a]);
            const top = order[0], second = order[1];
            const margin = fam[top] - fam[second];
            const confidence = clamp(fam[top] * (0.45 + 0.55 * clamp(margin / 0.18, 0, 1)), 0, 1);

            let genre = top, decided = true;
            if (genre !== "universal" && (fam[top] < 0.58 || margin < 0.06)) { genre = "universal"; decided = false; }
            if (genre === "afrobeats") genre = S.amapiano > S.afrobeats + 0.02 ? "amapiano" : "afrobeats";

            const reasons = (parts[genre] || []).filter(p => p.v >= 0.6).sort((a, b) => b.w * b.v - a.w * a.v).slice(0, 4).map(p => p.label);

            return {
                genre: genre,
                styleId: STYLE_OF[genre],
                sub: genre === "amapiano" ? "amapiano" : null,
                label: LABELS[genre],
                confidence: confidence,
                decided: decided,
                runnerUp: second,
                scores: S,
                features: f,
                reasons: reasons
            };
        }

        return { detect };
    }

    if (typeof window !== "undefined" && window.VocalVaultFill && window.VocalVaultFill.engine) {
        const eng = createGenreEngine(window.VocalVaultFill.engine);
        window.VocalVaultGenre = { detect: eng.detect, engine: eng, LABELS: LABELS };
    }
    if (typeof module !== "undefined") module.exports = { createGenreEngine: createGenreEngine, LABELS: LABELS };

})(typeof window !== "undefined" ? window : this);
