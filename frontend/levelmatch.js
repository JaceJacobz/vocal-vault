/* =========================================================
   VOCAL VAULT — LEVEL MATCHING

   Decides how loud the vocal should sit against the beat, and WHEN to
   raise or lower it, then renders the balanced mix.

   1. measure   K-weighted loudness (ITU-R BS.1770 filter) of both tracks,
                100 ms hops, 400 ms momentary blocks.
   2. fixed     one gain for the whole song: the vocal's loudness lands
                `vocalAboveBeatDb` above the beat's.
   3. dynamic   the gain moves with the music, like an engineer riding a
                fader: up when the beat gets louder (chorus, drop) or the
                singer gets quieter, down in the opposite cases. Movements
                are smoothed, limited to +/- `rangeDb`, and never chase
                silence, breaths or noise.
   4. render    beat + gained vocal, with one master trim so the peak sits
                at `peakTargetDb` (headroom for mastering; no limiter here).

   Everything lives in createLevelEngine() on plain Float32Arrays, so it
   can be tested in Node. The browser wrapper at the bottom adapts
   AudioBuffers and exposes window.VocalVaultLevels.
   ========================================================= */

function createLevelEngine() {

    const HOP_SEC = 0.1;          // one loudness value every 100 ms
    const BLOCK_HOPS = 4;         // 400 ms momentary block
    const BLOCK_CENTER = 0.2;     // seconds from a block's start to its middle

    const DEFAULTS = {
        mode: "dynamic",          // "dynamic" | "fixed" | "off"
        vocalAboveBeatDb: 1.5,    // how far the vocal sits above the beat (LU)
        rangeDb: 6,               // dynamic: furthest the fader moves either way
        strength: 1,              // dynamic: 0 = fixed, 1 = full ride
        beatWindowSec: 3,         // dynamic: how slowly it follows the beat's sections
        vocalWindowSec: 1,        // dynamic: how fast it follows the singer's phrases
        smoothSec: 0.4,           // dynamic: fader smoothing
        peakTargetDb: -3          // mix peak after the master trim
    };

    const toDb = (power) => (power > 1e-12 ? -0.691 + 10 * Math.log10(power) : -120);
    const fromDb = (lu) => Math.pow(10, (lu + 0.691) / 10);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    // ---------------------------------------------------------
    // K-weighting filter (two biquads), coefficients for any rate
    // ---------------------------------------------------------

    function kWeightCoefficients(sr) {

        // Stage 1: high shelf, +4 dB above ~1.7 kHz
        let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
        let K = Math.tan(Math.PI * f0 / sr);
        const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
        let a0 = 1 + K / Q + K * K;
        const shelf = {
            b0: (Vh + Vb * K / Q + K * K) / a0,
            b1: 2 * (K * K - Vh) / a0,
            b2: (Vh - Vb * K / Q + K * K) / a0,
            a1: 2 * (K * K - 1) / a0,
            a2: (1 - K / Q + K * K) / a0
        };

        // Stage 2: high-pass at ~38 Hz
        f0 = 38.13547087602444; Q = 0.5003270373238773;
        K = Math.tan(Math.PI * f0 / sr);
        a0 = 1 + K / Q + K * K;
        const hp = {
            b0: 1, b1: -2, b2: 1,
            a1: 2 * (K * K - 1) / a0,
            a2: (1 - K / Q + K * K) / a0
        };

        return { shelf, hp };
    }

    // Mean-square of the K-weighted signal in each 100 ms hop,
    // summed over channels. A mono track counts twice (it is played
    // from both speakers), so mono and stereo compare fairly.
    function hopPowers(channels, sr) {

        const hop = Math.round(HOP_SEC * sr);
        const n = channels[0].length;
        const hops = Math.ceil(n / hop);
        const out = new Float64Array(hops);
        const { shelf, hp } = kWeightCoefficients(sr);
        const weight = channels.length === 1 ? 2 : 1;

        for (const x of channels) {

            let s1 = 0, s2 = 0, h1 = 0, h2 = 0;       // filter memories

            for (let h = 0; h < hops; h++) {

                const i0 = h * hop, i1 = Math.min(n, i0 + hop);
                let acc = 0;

                for (let i = i0; i < i1; i++) {
                    // shelf (transposed direct form II)
                    const v = x[i];
                    const y1 = shelf.b0 * v + s1;
                    s1 = shelf.b1 * v - shelf.a1 * y1 + s2;
                    s2 = shelf.b2 * v - shelf.a2 * y1;
                    // high-pass
                    const y2 = hp.b0 * y1 + h1;
                    h1 = hp.b1 * y1 - hp.a1 * y2 + h2;
                    h2 = hp.b2 * y1 - hp.a2 * y2;
                    acc += y2 * y2;
                }

                out[h] += weight * acc / Math.max(1, i1 - i0);
            }
        }
        return out;
    }

    // 400 ms momentary power at every hop (window starts at that hop)
    function momentary(hp) {
        const n = hp.length, out = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let s = 0, c = 0;
            for (let k = 0; k < BLOCK_HOPS && i + k < n; k++) { s += hp[i + k]; c++; }
            out[i] = c ? s / c : 0;
        }
        return out;
    }

    // BS.1770 gated integrated loudness of a power series
    function integrated(power) {
        const abs = [];
        for (const p of power) if (toDb(p) > -70) abs.push(p);
        if (!abs.length) return -120;
        const mean1 = abs.reduce((a, b) => a + b, 0) / abs.length;
        const rel = toDb(mean1) - 10;
        let s = 0, c = 0;
        for (const p of abs) if (toDb(p) > rel) { s += p; c++; }
        return c ? toDb(s / c) : toDb(mean1);
    }

    // ---------------------------------------------------------
    // Smoothing helpers
    // ---------------------------------------------------------

    // centred moving average of power over `win` hops
    function movingAverage(values, valid, win) {
        const n = values.length, half = Math.max(1, Math.round(win / 2));
        const out = new Float64Array(n);
        const sum = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) {
            sum[i + 1] = sum[i] + (valid[i] ? values[i] : 0);
            cnt[i + 1] = cnt[i] + (valid[i] ? 1 : 0);
        }
        for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
            const c = cnt[b] - cnt[a];
            out[i] = c > 0 ? (sum[b] - sum[a]) / c : NaN;
        }
        return out;
    }

    // zero-phase one-pole smoothing (forward then backward)
    function smoothTwoWay(values, seconds) {
        const a = 1 - Math.exp(-HOP_SEC / Math.max(0.02, seconds));
        const n = values.length, out = Float64Array.from(values);
        for (let i = 1; i < n; i++) out[i] = out[i - 1] + a * (out[i] - out[i - 1]);
        for (let i = n - 2; i >= 0; i--) out[i] = out[i + 1] + a * (out[i] - out[i + 1]);
        return out;
    }

    // ---------------------------------------------------------
    // The plan
    // ---------------------------------------------------------

    function plan(vocalChannels, beatChannels, sr, offsetSec, options) {

        const o = Object.assign({}, DEFAULTS, options || {});

        const beatSamples = beatChannels[0].length;
        const vocalSamples = vocalChannels[0].length;
        const totalSec = Math.max(beatSamples / sr, offsetSec + vocalSamples / sr);
        const N = Math.max(1, Math.ceil(totalSec / HOP_SEC));

        // Loudness of each track, on the BEAT's timeline
        const beatPow = momentary(hopPowers(beatChannels, sr));
        const vocalPowOwn = momentary(hopPowers(vocalChannels, sr));

        const beatP = new Float64Array(N), vocalP = new Float64Array(N);
        const shift = Math.round(offsetSec / HOP_SEC);
        for (let j = 0; j < N; j++) {
            if (j < beatPow.length) beatP[j] = beatPow[j];
            const v = j - shift;
            if (v >= 0 && v < vocalPowOwn.length) vocalP[j] = vocalPowOwn[v];
        }

        const beatDb = Float32Array.from(beatP, toDb);
        const vocalDb = Float32Array.from(vocalP, toDb);

        // Where is the singer actually singing? Quiet blocks (breaths,
        // room noise, bleed) must never steer the fader.
        const loud = [];
        for (const d of vocalDb) if (d > -65) loud.push(d);
        loud.sort((a, b) => a - b);
        const top = loud.length ? loud[Math.floor(loud.length * 0.95)] : -120;
        const gate = Math.max(-65, top - 22);
        const active = new Uint8Array(N);
        let activeCount = 0;
        for (let j = 0; j < N; j++) if (vocalDb[j] >= gate) { active[j] = 1; activeCount++; }

        const result = {
            mode: o.mode,
            options: o,
            hopSec: HOP_SEC,
            blockCenterSec: BLOCK_CENTER,
            offsetSec,
            totalSec,
            beatLufs: integrated(beatP),
            vocalLufs: -120,
            fixedGainDb: 0,
            vocalGainDb: new Float32Array(N),      // the fader, per hop, on the beat's timeline
            beatDb, vocalDb, active,
            events: [],
            warning: null
        };

        if (!activeCount) {
            result.warning = "No clear singing was found in the vocal, so its level was left alone.";
            return result;
        }

        // ---- FIXED balance: one gain for the song
        const activePow = [];
        for (let j = 0; j < N; j++) if (active[j]) activePow.push(vocalP[j]);
        result.vocalLufs = toDb(activePow.reduce((a, b) => a + b, 0) / activePow.length);

        const fixed = clamp(result.beatLufs + o.vocalAboveBeatDb - result.vocalLufs, -30, 30);
        result.fixedGainDb = o.mode === "off" ? 0 : fixed;
        result.vocalGainDb.fill(result.fixedGainDb);

        if (o.mode !== "dynamic" || o.strength <= 0) return result;

        // ---- DYNAMIC ride (added on top of the fixed gain)
        const beatS = movingAverage(beatP, new Uint8Array(N).fill(1), o.beatWindowSec / HOP_SEC);
        const vocalS = movingAverage(vocalP, active, o.vocalWindowSec / HOP_SEC);

        const beatSdb = Float64Array.from(beatS, toDb);
        const vocalSdb = Float64Array.from(vocalS, (p) => (isNaN(p) ? NaN : toDb(p)));

        // Centre both on their averages over the singing, so the ride is
        // purely "more / less than usual" and the overall balance stays put.
        let mb = 0, mv = 0, c = 0;
        for (let j = 0; j < N; j++) if (active[j] && !isNaN(vocalSdb[j])) { mb += beatSdb[j]; mv += vocalSdb[j]; c++; }
        mb /= c; mv /= c;

        const fromBeat = new Float64Array(N), fromVocal = new Float64Array(N), ride = new Float64Array(N);
        const known = new Uint8Array(N);

        for (let j = 0; j < N; j++) {
            if (active[j] && !isNaN(vocalSdb[j])) {
                fromBeat[j] = beatSdb[j] - mb;          // beat louder than usual -> raise vocal
                fromVocal[j] = -(vocalSdb[j] - mv);     // singer quieter than usual -> raise vocal
                ride[j] = fromBeat[j] + fromVocal[j];
                known[j] = 1;
            }
        }

        // Across silences, glide between the neighbouring values (hold at the ends)
        let last = -1;
        for (let j = 0; j < N; j++) {
            if (!known[j]) continue;
            if (last === -1) { for (let k = 0; k < j; k++) { ride[k] = ride[j]; fromBeat[k] = fromBeat[j]; fromVocal[k] = fromVocal[j]; } }
            else if (j - last > 1) {
                for (let k = last + 1; k < j; k++) {
                    const t = (k - last) / (j - last);
                    ride[k] = ride[last] + t * (ride[j] - ride[last]);
                    fromBeat[k] = fromBeat[last] + t * (fromBeat[j] - fromBeat[last]);
                    fromVocal[k] = fromVocal[last] + t * (fromVocal[j] - fromVocal[last]);
                }
            }
            last = j;
        }
        if (last >= 0) for (let k = last + 1; k < N; k++) { ride[k] = ride[last]; fromBeat[k] = fromBeat[last]; fromVocal[k] = fromVocal[last]; }

        const smooth = smoothTwoWay(ride, o.smoothSec);

        for (let j = 0; j < N; j++) {
            const move = clamp(smooth[j] * o.strength, -o.rangeDb, o.rangeDb);
            result.vocalGainDb[j] = result.fixedGainDb + move;
        }

        // ---- Explain it: where does the fader move, and why?
        const runs = [];
        let run = null;
        for (let j = 0; j < N; j++) {
            const move = result.vocalGainDb[j] - result.fixedGainDb;
            const sign = Math.abs(move) >= 1 ? Math.sign(move) : 0;
            if (run && sign === run.sign && sign !== 0) {
                run.end = j; run.sumB += Math.abs(fromBeat[j]); run.sumV += Math.abs(fromVocal[j]);
                if (Math.abs(move) > Math.abs(run.peak)) run.peak = move;
            } else {
                if (run && run.sign !== 0) runs.push(run);
                run = sign !== 0 ? { sign, start: j, end: j, peak: move, sumB: Math.abs(fromBeat[j]), sumV: Math.abs(fromVocal[j]) } : { sign: 0 };
            }
        }
        if (run && run.sign !== 0) runs.push(run);

        result.events = runs
            .filter((r) => (r.end - r.start + 1) * HOP_SEC >= 1)
            .map((r) => ({
                startSec: r.start * HOP_SEC,
                endSec: (r.end + 1) * HOP_SEC,
                peakDb: r.peak,
                reason: r.sumB >= r.sumV
                    ? (r.sign > 0 ? "the beat gets louder" : "the beat gets quieter")
                    : (r.sign > 0 ? "the vocal gets quieter" : "the vocal gets louder")
            }))
            .sort((a, b) => Math.abs(b.peakDb) * (b.endSec - b.startSec) - Math.abs(a.peakDb) * (a.endSec - a.startSec))
            .slice(0, 8)
            .sort((a, b) => a.startSec - b.startSec);

        return result;
    }

    // ---------------------------------------------------------
    // Mix: beat + gained vocal, then one master trim for headroom
    // ---------------------------------------------------------

    function resample(x, from, to) {
        if (from === to) return x;
        const n = Math.round(x.length * to / from), out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const p = i * from / to, i0 = Math.floor(p), f = p - i0;
            out[i] = x[Math.min(x.length - 1, i0)] * (1 - f) + x[Math.min(x.length - 1, i0 + 1)] * f;
        }
        return out;
    }

    // The vocal on the beat's timeline, with the plan's fader applied
    // (linear in amplitude between hops). Returns [L, R].
    function placeVocal(vocalChannels, sr, thePlan, length) {

        const L = new Float32Array(length), R = new Float32Array(length);
        const offsetSamples = Math.round(thePlan.offsetSec * sr);
        const vl = vocalChannels[0], vr = vocalChannels[1] || vocalChannels[0];
        const lin = Float64Array.from(thePlan.vocalGainDb, (d) => Math.pow(10, d / 20));
        const hop = HOP_SEC * sr, centre = BLOCK_CENTER * sr;

        for (let i = 0; i < vl.length; i++) {

            const k = i + offsetSamples;
            if (k < 0 || k >= length) continue;

            const u = clamp((k - centre) / hop, 0, lin.length - 1);
            const i0 = Math.floor(u), i1 = Math.min(lin.length - 1, i0 + 1), f = u - i0;
            const g = lin[i0] * (1 - f) + lin[i1] * f;

            L[k] = vl[i] * g;
            R[k] = vr[i] * g;
        }
        return [L, R];
    }

    // beat + gained vocal (+ optional extra stems such as reverb), then, unless
    // skipTrim is set, one trim so the peak sits at peakTargetDb.
    //   opts.extras   [[L, R], ...] stems on the same timeline
    //   opts.tailSec  extra time at the end, so effect tails are not cut off
    //   opts.skipTrim leave the level alone (a mastering stage follows)
    function mix(vocalChannels, beatChannels, sr, thePlan, opts) {

        const o = opts || {};
        const peakTarget = o.peakTargetDb !== undefined ? o.peakTargetDb : thePlan.options.peakTargetDb;
        const length = Math.ceil(thePlan.totalSec * sr) + Math.round((o.tailSec || 0) * sr);
        const L = new Float32Array(length), R = new Float32Array(length);

        // beat (mono is centred)
        const bl = beatChannels[0], br = beatChannels[1] || beatChannels[0];
        for (let i = 0; i < bl.length && i < length; i++) { L[i] = bl[i]; R[i] = br[i]; }

        const placed = placeVocal(vocalChannels, sr, thePlan, length);
        for (let i = 0; i < length; i++) { L[i] += placed[0][i]; R[i] += placed[1][i]; }

        for (const e of (o.extras || [])) {
            const el = e[0], er = e[1] || e[0], n = Math.min(length, el.length);
            for (let i = 0; i < n; i++) { L[i] += el[i]; R[i] += er[i]; }
        }

        if (o.skipTrim) return { channels: [L, R], masterTrimDb: 0, peakBeforeDb: null };

        let peak = 0;
        for (let i = 0; i < length; i++) {
            const a = Math.abs(L[i]), b = Math.abs(R[i]);
            if (a > peak) peak = a;
            if (b > peak) peak = b;
        }

        const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
        const trimDb = peak > 0 ? peakTarget - peakDb : 0;
        const trim = Math.pow(10, trimDb / 20);

        for (let i = 0; i < length; i++) { L[i] *= trim; R[i] *= trim; }

        return { channels: [L, R], masterTrimDb: trimDb, peakBeforeDb: peakDb };
    }

    return { DEFAULTS, plan, mix, placeVocal, hopPowers, momentary, integrated, toDb, resample };
}

// ============================================================
// BROWSER WRAPPER
// ============================================================

if (typeof window !== "undefined") {

    const engine = createLevelEngine();

    const channelsOf = (buffer) => {
        const out = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
        return out;
    };

    // Plan only (no audio rendered): cheap, used to draw and explain.
    function planLevels(vocalBuffer, beatBuffer, offsetSec, options) {
        const vocal = channelsOf(vocalBuffer).map((c) => engine.resample(c, vocalBuffer.sampleRate, beatBuffer.sampleRate));
        return engine.plan(vocal, channelsOf(beatBuffer), beatBuffer.sampleRate, offsetSec || 0, options);
    }

    // Same signature as VocalVaultAutomix.process(state): returns an AudioBuffer.
    async function processLevels(state, options, vocalOverride) {

        if (!options && window.VocalVaultLevels && window.VocalVaultLevels.readOptions) options = window.VocalVaultLevels.readOptions();

        const beat = state.beatBuffer;
        // vocalOverride: a vocal that has already been through EQ/compression
        const vocalBuffer = vocalOverride || state.tunedVocal || state.preparedVocal || state.vocalBuffer;

        if (!beat || !vocalBuffer) throw new Error("Both a vocal and a beat are needed.");

        const sr = beat.sampleRate;
        const vocal = channelsOf(vocalBuffer).map((c) => engine.resample(c, vocalBuffer.sampleRate, sr));

        const thePlan = engine.plan(vocal, channelsOf(beat), sr, state.vocalOffset || 0, options);
        const mixed = engine.mix(vocal, channelsOf(beat), sr, thePlan, options);

        const ctx = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
        const out = ctx.createBuffer(2, mixed.channels[0].length, sr);
        out.copyToChannel(mixed.channels[0], 0);
        out.copyToChannel(mixed.channels[1], 1);

        thePlan.masterTrimDb = mixed.masterTrimDb;
        thePlan.peakBeforeDb = mixed.peakBeforeDb;
        state.levelPlan = thePlan;
        window.dispatchEvent(new Event("vv-levels-updated"));

        return out;
    }

    window.VocalVaultLevels = {
        defaults: engine.DEFAULTS,
        plan: planLevels,
        process: processLevels,
        engine
    };


    // ---------------------------------------------------------
    // Panel: controls, a chart of what the fader does, and why.
    // Placed just above #automix-button when that exists.
    // ---------------------------------------------------------

    const STYLE = `
    .level-panel{margin:18px 0;padding:18px;background:var(--panel-light,#1c1c21);border:1px solid var(--border,#34343c);border-radius:var(--radius-md,14px);color:var(--text,#f2f2f4)}
    .level-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 16px}
    .level-head span{color:var(--muted,#9a9aa3);font-size:11px;font-weight:700;letter-spacing:.08em}
    .level-head small{flex:1 1 280px;color:var(--muted,#9a9aa3);font-size:13px;line-height:1.5}
    .level-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px 18px;margin-top:14px}
    .level-controls label{display:grid;gap:6px;color:var(--muted,#9a9aa3);font-size:12px;font-weight:700}
    .level-controls output{color:var(--text,#f2f2f4);font-weight:700}
    .level-controls select{min-height:38px;padding:0 10px;background:var(--panel,#141418);border:1px solid var(--border,#34343c);border-radius:8px;color:inherit;font:inherit}
    .level-chart{display:block;width:100%;height:190px;margin-top:14px;background:var(--bg,#0e0e11);border:1px solid var(--border,#34343c);border-radius:8px}
    .level-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;color:var(--muted,#9a9aa3);font-size:12px}
    .level-legend i{display:inline-block;width:14px;height:3px;margin-right:6px;border-radius:2px;vertical-align:3px}
    .level-events{margin:12px 0 0;padding:0;list-style:none;display:grid;gap:6px;font-size:13px}
    .level-events li{display:flex;gap:12px;padding:8px 12px;background:var(--panel,#141418);border:1px solid var(--border,#34343c);border-radius:8px}
    .level-events b{min-width:96px;font-variant-numeric:tabular-nums}
    .level-events em{min-width:64px;font-style:normal;font-weight:700}
    .level-events .up{color:#4fd18b}.level-events .down{color:#e0a030}
    .level-events span{color:var(--muted,#9a9aa3)}`;

    function setupPanel() {

        const anchor = document.getElementById("automix-button");
        const S = window.VocalVaultState;

        if (!anchor || !S || document.getElementById("level-panel")) return;

        const style = document.createElement("style");
        style.textContent = STYLE;
        document.head.appendChild(style);

        const d = engine.DEFAULTS;
        const panel = document.createElement("div");
        panel.id = "level-panel";
        panel.className = "level-panel hidden";
        panel.innerHTML = `
            <div class="level-head"><span>LEVEL MATCHING</span><small id="level-summary"></small></div>
            <div class="level-controls">
                <label>Mode
                    <select id="level-mode">
                        <option value="dynamic">Dynamic: ride the fader</option>
                        <option value="fixed">Fixed: one balance</option>
                        <option value="off">Off</option>
                    </select>
                </label>
                <label>Vocal above the beat <output id="level-above-out"></output>
                    <input id="level-above" type="range" min="-6" max="8" step="0.5" value="${d.vocalAboveBeatDb}">
                </label>
                <label>Fader range, either way <output id="level-range-out"></output>
                    <input id="level-range" type="range" min="0" max="12" step="0.5" value="${d.rangeDb}">
                </label>
                <label>Ride strength <output id="level-strength-out"></output>
                    <input id="level-strength" type="range" min="0" max="100" step="5" value="${d.strength * 100}">
                </label>
            </div>
            <canvas id="level-chart" class="level-chart"></canvas>
            <div class="level-legend">
                <span><i style="background:#7896be"></i>beat loudness</span>
                <span><i style="background:#ff5433"></i>vocal loudness after the fader</span>
                <span><i style="background:#ffffff"></i>fader (dB)</span>
            </div>
            <ul id="level-events" class="level-events"></ul>`;
        anchor.parentNode.insertBefore(panel, anchor);

        const $ = (id) => document.getElementById(id);
        const el = { mode: $("level-mode"), above: $("level-above"), range: $("level-range"), strength: $("level-strength") };

        const readouts = () => {
            $("level-above-out").textContent = (el.above.value > 0 ? "+" : "") + el.above.value + " LU";
            $("level-range-out").textContent = "±" + el.range.value + " dB";
            $("level-strength-out").textContent = el.strength.value + "%";
            const dyn = el.mode.value === "dynamic";
            el.range.disabled = !dyn; el.strength.disabled = !dyn;
            el.above.disabled = el.mode.value === "off";
        };

        const readOptions = () => ({
            mode: el.mode.value,
            vocalAboveBeatDb: parseFloat(el.above.value),
            rangeDb: parseFloat(el.range.value),
            strength: parseFloat(el.strength.value) / 100
        });
        window.VocalVaultLevels.readOptions = readOptions;

        const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
        let lastKey = null, timer = 0;

        function draw(p) {

            const cv = $("level-chart"), dpr = window.devicePixelRatio || 1;
            const w = cv.clientWidth, h = cv.clientHeight;
            cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
            const g = cv.getContext("2d");
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, w, h);

            const L = 40, R = 8, split = Math.round(h * 0.58);
            const n = p.beatDb.length, x = (j) => L + (j / Math.max(1, n - 1)) * (w - L - R);

            // top: loudness
            let lo = Infinity, hi = -Infinity;
            for (let j = 0; j < n; j++) {
                const a = p.beatDb[j]; if (a > -70) { lo = Math.min(lo, a); hi = Math.max(hi, a); }
                if (p.active[j]) { const v = p.vocalDb[j] + p.vocalGainDb[j]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
            }
            if (!isFinite(lo)) { lo = -40; hi = -10; }
            lo = Math.floor(lo - 2); hi = Math.ceil(hi + 2);
            const yA = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (split - 14);

            g.font = "10px system-ui, sans-serif"; g.textBaseline = "middle";
            g.strokeStyle = "rgba(255,255,255,0.08)"; g.fillStyle = "#9a9aa3"; g.lineWidth = 1;
            for (let v = Math.ceil(lo / 6) * 6; v <= hi; v += 6) {
                g.beginPath(); g.moveTo(L, yA(v)); g.lineTo(w - R, yA(v)); g.stroke();
                g.fillText(String(v), 6, yA(v));
            }

            g.lineWidth = 1.6; g.strokeStyle = "#7896be"; g.beginPath();
            for (let j = 0; j < n; j++) { const y = yA(Math.max(lo, p.beatDb[j])); j ? g.lineTo(x(j), y) : g.moveTo(x(j), y); }
            g.stroke();

            g.strokeStyle = "#ff5433"; g.beginPath(); let pen = false;
            for (let j = 0; j < n; j++) {
                if (!p.active[j]) { pen = false; continue; }
                const y = yA(p.vocalDb[j] + p.vocalGainDb[j]);
                if (pen) g.lineTo(x(j), y); else { g.moveTo(x(j), y); pen = true; }
            }
            g.stroke();

            // bottom: the fader
            const fTop = split + 10, fBot = h - 8;
            let fmin = Infinity, fmax = -Infinity;
            for (const v of p.vocalGainDb) { fmin = Math.min(fmin, v); fmax = Math.max(fmax, v); }
            const mid = p.fixedGainDb, span = Math.max(3, Math.abs(fmax - mid), Math.abs(fmin - mid)) + 1;
            const yF = (v) => fTop + (1 - ((v - (mid - span)) / (2 * span))) * (fBot - fTop);

            g.strokeStyle = "rgba(255,255,255,0.18)"; g.setLineDash([4, 4]);
            g.beginPath(); g.moveTo(L, yF(mid)); g.lineTo(w - R, yF(mid)); g.stroke(); g.setLineDash([]);
            g.fillStyle = "#9a9aa3"; g.fillText((mid >= 0 ? "+" : "") + mid.toFixed(1), 4, yF(mid));
            g.fillText("fader", 4, fTop - 1);

            g.strokeStyle = "#ffffff"; g.lineWidth = 1.8; g.beginPath();
            for (let j = 0; j < n; j++) { const y = yF(p.vocalGainDb[j]); j ? g.lineTo(x(j), y) : g.moveTo(x(j), y); }
            g.stroke();

            // moments the fader moves
            for (const e of p.events) {
                g.fillStyle = e.peakDb > 0 ? "rgba(79,209,139,0.14)" : "rgba(224,160,48,0.14)";
                g.fillRect(x(e.startSec / p.hopSec), 0, x(e.endSec / p.hopSec) - x(e.startSec / p.hopSec), h);
            }

            // time labels
            g.fillStyle = "#9a9aa3"; g.textBaseline = "bottom";
            const step = p.totalSec > 240 ? 60 : p.totalSec > 90 ? 30 : 10;
            for (let t = 0; t <= p.totalSec; t += step) { const lx = x(t / p.hopSec) + 2; if (lx < w - 34) g.fillText(fmt(t), lx, h - 1); }
        }

        function show(p, usedTuned, rendered) {

            panel.classList.remove("hidden");
            draw(p);

            const sign = (v) => (v >= 0 ? "+" : "") + v.toFixed(1);
            let text;
            if (p.warning) text = p.warning;
            else if (p.mode === "off") text = "Levels are left as they are.";
            else {
                text = `The vocal sits ${sign(p.options.vocalAboveBeatDb)} LU against the beat (fader ${sign(p.fixedGainDb)} dB` +
                    (p.mode === "dynamic" ? `, riding up to ±${p.options.rangeDb} dB with the music).` : `, one balance for the whole song).`);
            }
            if (rendered && rendered.masterTrimDb !== undefined) text += ` The mix was trimmed ${sign(rendered.masterTrimDb)} dB so its peak is ${p.options.peakTargetDb} dBFS, leaving room for mastering.`;
            text += usedTuned ? " Using the corrected vocal."
                : S.preparedVocal ? " Using the cleaned-up vocal (no pitch correction yet)."
                : " Using the original vocal. Run pitch correction first to use the corrected one.";
            $("level-summary").textContent = text;

            const list = $("level-events");
            list.innerHTML = "";
            if (p.mode === "dynamic" && !p.warning) {
                if (!p.events.length) list.innerHTML = "<li><span>The fader barely moves: the beat and the vocal stay at steady levels.</span></li>";
                for (const e of p.events) {
                    const li = document.createElement("li");
                    li.innerHTML = `<b>${fmt(e.startSec)} – ${fmt(e.endSec)}</b><em class="${e.peakDb > 0 ? "up" : "down"}">${e.peakDb > 0 ? "▲" : "▼"} ${sign(e.peakDb)} dB</em><span>${e.peakDb > 0 ? "Vocal raised" : "Vocal lowered"} because ${e.reason}.</span>`;
                    list.appendChild(li);
                }
            }
        }

        function refresh() {
            const vocal = S.tunedVocal || S.preparedVocal || S.vocalBuffer;
            if (!vocal || !S.beatBuffer) return;
            const identity = [S.beatBuffer, vocal];
            if (refresh.last && refresh.last[0] === identity[0] && refresh.last[1] === identity[1] && lastKey === JSON.stringify([S.vocalOffset, readOptions()])) return;
            refresh.last = identity;
            lastKey = JSON.stringify([S.vocalOffset, readOptions()]);
            const p = planLevels(vocal, S.beatBuffer, S.vocalOffset || 0, readOptions());
            show(p, !!S.tunedVocal, null);
        }

        const soon = () => { readouts(); clearTimeout(timer); timer = setTimeout(refresh, 250); };
        [el.mode, el.above, el.range, el.strength].forEach((c) => c.addEventListener("input", soon));
        window.addEventListener("resize", () => { if (S.levelPlan && !panel.classList.contains("hidden")) draw(S.levelPlan); });
        window.addEventListener("vv-levels-updated", () => {
            const p = S.levelPlan; if (!p) return;
            show(p, !!S.tunedVocal, { masterTrimDb: p.masterTrimDb });
        });

        readouts();
        setInterval(refresh, 1500);    // picks up a new beat, vocal, offset or corrected vocal
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupPanel);
    else setupPanel();

    // If no automix stage is loaded yet, offer this one under its name.
    // (A real automix.js loaded later simply replaces it and can call
    // VocalVaultLevels.process from inside.)
    if (!window.VocalVaultAutomix) {
        window.VocalVaultAutomix = { process: processLevels };
    }
}

if (typeof module !== "undefined") {
    module.exports = { createLevelEngine };
}