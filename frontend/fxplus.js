/* =========================================================
   VOCAL VAULT — EXTRA PRODUCTION (all automatic)

   1. doubler       Two quiet, slightly detuned and delayed copies of the
                    voice, one left and one right. This is the classic
                    "double-tracked" width of a produced vocal.
   2. duckBeatMid   While the voice is singing, the beat's 1-4 kHz range
                    (where voice and snares/synths compete) dips by a few
                    dB. Kick and bass are untouched.
   3. echoTime      Picks an echo time that is a musical fraction of the
                    beat, instead of a fixed number of milliseconds.

   Needs the studio engine (studio.js) for its filter helpers.
   ========================================================= */

function createFxPlusEngine(studio) {

    const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
    const lin = (d) => Math.pow(10, d / 20);

    function toMono(channels) {
        if (channels.length === 1) return channels[0];
        const n = channels[0].length, out = new Float32Array(n);
        for (let c = 0; c < channels.length; c++) for (let i = 0; i < n; i++) out[i] += channels[c][i] / channels.length;
        return out;
    }

    // ---------------------------------------------------------
    // 1. Doubler
    // ---------------------------------------------------------

    // A delay line whose length wobbles slowly. A wobbling delay is a tiny pitch change:
    // depth 1.6 ms at 0.37 Hz is about +-6 cents, which is what makes a double sound like a second take.
    function wobbleDelay(x, sr, baseMs, depthMs, rateHz, phase) {
        const n = x.length, out = new Float32Array(n);
        const base = baseMs * sr / 1000, depth = depthMs * sr / 1000;
        for (let i = 0; i < n; i++) {
            const d = base + depth * Math.sin(2 * Math.PI * rateHz * i / sr + phase);
            const p = i - d, k = Math.floor(p), f = p - k;
            if (k >= 0 && k + 1 < n) out[i] = x[k] * (1 - f) + x[k + 1] * f;
        }
        return out;
    }

    // placed: the voice channels at their final level. Returns a stereo stem to add to the mix.
    function doubler(placed, sr, options) {

        const o = Object.assign({ belowDb: 13 }, options || {});
        const mono = toMono(placed);

        // only the body of the voice is doubled: no lows (mud) and no harsh top
        const band = studio.runCascade(mono, [studio.design.highpass(250, sr), studio.design.lowpass(9000, sr)]);

        const g = lin(-o.belowDb);
        const left = wobbleDelay(band, sr, 21, 1.6, 0.37, 0.0);
        const right = wobbleDelay(band, sr, 29, 1.9, 0.29, Math.PI);
        for (let i = 0; i < left.length; i++) { left[i] *= g; right[i] *= g; }

        return { channels: [left, right], belowDb: o.belowDb };
    }

    // ---------------------------------------------------------
    // 2. Dip the beat's mids while the voice is on
    // ---------------------------------------------------------

    // 0..1 per sample: how much the voice is "on". Opens in ~15 ms, closes in ~180 ms.
    function voiceActivity(vocalMono, sr) {

        const hop = Math.round(0.01 * sr), frames = Math.ceil(vocalMono.length / hop);
        const lev = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            let s = 0, c = 0;
            for (let i = f * hop; i < Math.min(vocalMono.length, (f + 1) * hop); i++) { s += vocalMono[i] ** 2; c++; }
            lev[f] = db(Math.sqrt(s / Math.max(1, c)));
        }

        // "singing" = within 30 dB of the voice's own loud parts (breaths and room noise stay below)
        const sorted = Float32Array.from(lev).sort();
        const loud = sorted[Math.floor(frames * 0.9)];
        const thr = loud - 30;

        const act = new Float32Array(frames);
        let y = 0;
        const up = 1 - Math.exp(-0.01 / 0.015), down = 1 - Math.exp(-0.01 / 0.18);
        for (let f = 0; f < frames; f++) {
            const target = Math.max(0, Math.min(1, (lev[f] - thr) / 6));
            y += (target > y ? up : down) * (target - y);
            act[f] = y;
        }
        return { act, hop };
    }

    // beatChannels: the beat on the song timeline; vocalMono: the placed voice on the same timeline.
    // The beat is crossfaded between itself and a copy with a broad EQ cut around 2 kHz, so the dip
    // is exactly as deep as the EQ curve says, and kick/bass/air are left alone.
    function duckBeatMid(beatChannels, vocalMono, sr, options) {

        const o = Object.assign({ depthDb: 2.5, centerHz: 2000, q: 0.6 }, options || {});
        const { act, hop } = voiceActivity(vocalMono, sr);

        let active = 0; for (const a of act) if (a > 0.5) active++;

        // the cut's centre is a little deeper than the nominal depth so the 1.5-3 kHz average lands on it
        const cut = studio.design.peaking(o.centerHz, -o.depthDb * 1.15, o.q, sr);

        const channels = beatChannels.map((x) => {
            const cutX = studio.runCascade(x, [cut]);
            const out = new Float32Array(x.length);
            for (let i = 0; i < x.length; i++) {
                const a = i < vocalMono.length ? act[Math.min(act.length - 1, Math.floor(i / hop))] : 0;
                out[i] = x[i] + a * (cutX[i] - x[i]);
            }
            return out;
        });

        return { channels, depthDb: o.depthDb, activeFraction: active / act.length };
    }

    // ---------------------------------------------------------
    // 3. Echo time from the tempo
    // ---------------------------------------------------------

    // Chooses an eighth, dotted-eighth, quarter or half note, whichever is closest to 0.3 s.
    function echoTime(bpm) {

        if (!(bpm > 40 && bpm < 240)) return null;

        const beat = 60 / bpm;
        const options = [
            { sec: beat / 2, label: "an eighth note" },
            { sec: beat * 0.75, label: "a dotted eighth note" },
            { sec: beat, label: "a quarter note" },
            { sec: beat * 2, label: "a half note" }
        ].filter(o => o.sec >= 0.18 && o.sec <= 0.55);

        if (!options.length) return null;
        options.sort((a, b) => Math.abs(a.sec - 0.3) - Math.abs(b.sec - 0.3));
        return options[0];
    }

    // ---------------------------------------------------------
    // 4. A small room around EVERYTHING
    //    A vocal with its own reverb on a completely dry beat sounds pasted on top. A little of one
    //    shared room around the whole mix makes both sound as if they were in the same place.
    // ---------------------------------------------------------

    // Schroeder-style room: parallel damped combs into two allpasses, different delays left and right.
    function room(channels, sr, options) {

        const o = Object.assign({ rt60: 0.45, belowDb: 22, damp: 0.35 }, options || {});
        const mono = toMono(channels), n = mono.length;
        const send = studio.runCascade(mono, [studio.design.highpass(250, sr), studio.design.lowpass(6000, sr)]);

        const combMs = [[29.7, 37.1, 41.1, 43.7], [31.3, 38.9, 42.7, 46.1]];
        const apMs = [[5.0, 1.7], [5.3, 1.9]];

        const wet = combMs.map((delays, side) => {
            const out = new Float32Array(n);
            const combs = delays.map(ms => {
                const d = Math.max(2, Math.round(ms * sr / 1000));
                return { d, buf: new Float32Array(d), pos: 0, lp: 0, g: Math.pow(10, -3 * (d / sr) / o.rt60) };
            });
            for (let i = 0; i < n; i++) {
                let s = 0;
                for (const c of combs) {
                    const y = c.buf[c.pos];
                    c.lp += (1 - o.damp) * (y - c.lp);                // darker with every trip round the loop
                    c.buf[c.pos] = send[i] + c.g * c.lp;
                    c.pos = (c.pos + 1) % c.d;
                    s += y;
                }
                out[i] = s * 0.25;
            }
            // two series allpasses smear it into a diffuse tail
            let sig = out;
            for (const ms of apMs[side]) {
                const d = Math.max(2, Math.round(ms * sr / 1000)), buf = new Float32Array(d), y = new Float32Array(n);
                let p = 0;
                for (let i = 0; i < n; i++) { const b = buf[p]; const v = sig[i] + 0.5 * b; y[i] = b - 0.5 * v; buf[p] = v; p = (p + 1) % d; }
                sig = y;
            }
            return sig;
        });

        // level: belowDb under the mix itself
        const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i += 2) s += x[i] * x[i]; return Math.sqrt(s / Math.ceil(x.length / 2)); };
        const g = lin(-o.belowDb) * rms(mono) / Math.max(1e-12, (rms(wet[0]) + rms(wet[1])) / 2);
        for (const w of wet) for (let i = 0; i < n; i++) w[i] *= g;

        return { channels: wet, rt60: o.rt60, belowDb: o.belowDb };
    }

    // A reverb tail that fits the tempo: long tails smear fast music and make it feel slow.
    function reverbTime(bpm) {
        if (!(bpm > 40 && bpm < 240)) return null;
        return Math.max(0.7, Math.min(1.4, 1.6 * 60 / bpm));
    }

    // ---------------------------------------------------------
    // 5. The harmony layer, ready to sit under the lead
    // ---------------------------------------------------------

    // placed: the harmony voice at its final level. Quiet, band-limited, a little to the right.
    function harmonyStem(placed, sr, options) {

        const o = Object.assign({ belowDb: 9 }, options || {});
        const mono = toMono(placed);
        const band = studio.runCascade(mono, [studio.design.highpass(250, sr), studio.design.lowpass(9000, sr)]);
        const g = lin(-o.belowDb), d = Math.round(0.011 * sr);
        const left = new Float32Array(band.length), right = new Float32Array(band.length);
        for (let i = 0; i < band.length; i++) { left[i] = band[i] * g * 0.6; if (i >= d) right[i] = band[i - d] * g; }
        return { channels: [left, right], belowDb: o.belowDb };
    }

    return { doubler, duckBeatMid, voiceActivity, echoTime, room, reverbTime, harmonyStem, toMono };
}

if (typeof window !== "undefined" && window.VocalVaultStudio) {
    window.VocalVaultFxPlus = { engine: createFxPlusEngine(window.VocalVaultStudio.engine) };
}

if (typeof module !== "undefined") {
    module.exports = { createFxPlusEngine };
}