/* =========================================================
   VOCAL VAULT — AUDIO ANALYSIS ENGINE
   Step 1: BPM detection

   How it works
   1. Split the audio into short overlapping frames and take an FFT.
   2. Measure how much the spectrum "jumps" between frames (spectral
      flux). Drums and other hits show up as spikes.
   3. Look for repeating patterns in those spikes at every tempo from
      30 to 400 BPM (a Fourier tempogram, 0.1 BPM resolution).
   4. Score each candidate 60-200 BPM, giving credit to its double and
      half, then lean toward common tempos to avoid picking the wrong
      octave (e.g. 70 vs 140).

   detectBpm is fully self-contained so it can be stringified and run
   inside a Web Worker without a separate file (works from file://).
   ========================================================= */

function detectBpm(samples, sampleRate, options) {

    options = options || {};

    const FRAME = 2048;
    const HOP = 512;
    const fps = sampleRate / HOP;

    const frameCount = Math.floor((samples.length - FRAME) / HOP) + 1;

    if (frameCount < fps * 8) {
        return { bpm: null, confidence: 0, reason: "Audio is too short to analyze (needs at least 8 seconds)." };
    }

    // Normalise so quiet and loud files behave the same.
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const a = Math.abs(samples[i]);
        if (a > peak) peak = a;
    }
    if (peak === 0) {
        return { bpm: null, confidence: 0, reason: "The audio is silent." };
    }
    const gain = 1 / peak;

    // ---------- FFT setup ----------
    const N = FRAME;
    const levels = Math.round(Math.log2(N));
    const cosT = new Float64Array(N / 2);
    const sinT = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) {
        cosT[k] = Math.cos((2 * Math.PI * k) / N);
        sinT[k] = Math.sin((2 * Math.PI * k) / N);
    }
    const rev = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
        rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (levels - 1));
    }
    const hann = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    }

    function fft(re, im) {
        for (let i = 0; i < N; i++) {
            const j = rev[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let size = 2; size <= N; size <<= 1) {
            const half = size >> 1;
            const step = N / size;
            for (let i = 0; i < N; i += size) {
                for (let j = 0, k = 0; j < half; j++, k += step) {
                    const a = i + j;
                    const b = a + half;
                    const tr = re[b] * cosT[k] + im[b] * sinT[k];
                    const ti = im[b] * cosT[k] - re[b] * sinT[k];
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
        }
    }

    // ---------- Onset envelope (spectral flux) ----------
    const loBin = Math.max(1, Math.floor((30 * N) / sampleRate));
    const hiBin = Math.min(N / 2 - 1, Math.floor((8000 * N) / sampleRate));

    const prev = new Float64Array(hiBin - loBin + 1);
    const env = new Float64Array(frameCount);
    const re = new Float64Array(N);
    const im = new Float64Array(N);

    for (let f = 0; f < frameCount; f++) {

        const start = f * HOP;

        for (let i = 0; i < N; i++) {
            re[i] = samples[start + i] * gain * hann[i];
            im[i] = 0;
        }

        fft(re, im);

        let flux = 0;

        for (let k = loBin; k <= hiBin; k++) {
            const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
            const v = Math.log1p(mag);
            const d = v - prev[k - loBin];
            if (d > 0) flux += d;
            prev[k - loBin] = v;
        }

        env[f] = flux;
    }

    // Remove the slow-moving average so only sharp hits remain.
    const prefix = new Float64Array(frameCount + 1);
    for (let i = 0; i < frameCount; i++) prefix[i + 1] = prefix[i] + env[i];

    const radius = Math.round(fps * 0.25);
    const onset = new Float64Array(frameCount);

    for (let i = 0; i < frameCount; i++) {
        const a = Math.max(0, i - radius);
        const b = Math.min(frameCount, i + radius + 1);
        const mean = (prefix[b] - prefix[a]) / (b - a);
        onset[i] = Math.max(0, env[i] - mean);
    }

    // Keep the plain envelope: used later to check which tempo the
    // hits really line up with.
    const onsetRaw = Float64Array.from(onset);

    // Centre and window the envelope to reduce spectral leakage.
    let onsetMean = 0;
    for (let i = 0; i < frameCount; i++) onsetMean += onset[i];
    onsetMean /= frameCount;

    for (let i = 0; i < frameCount; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameCount - 1));
        onset[i] = (onset[i] - onsetMean) * w;
    }

    // ---------- Fourier tempogram ----------
    const MIN_BPM = 30;
    const MAX_BPM = 400;
    const STEP = 0.1;
    const bins = Math.round((MAX_BPM - MIN_BPM) / STEP) + 1;
    const magnitude = new Float64Array(bins);

    for (let b = 0; b < bins; b++) {

        const bpm = MIN_BPM + b * STEP;
        const w = (2 * Math.PI * (bpm / 60)) / fps;
        const cr = Math.cos(w);
        const ci = Math.sin(w);

        let pr = 1;
        let pi = 0;
        let sumR = 0;
        let sumI = 0;

        for (let t = 0; t < frameCount; t++) {
            const e = onset[t];
            sumR += e * pr;
            sumI += e * pi;
            const nr = pr * cr - pi * ci;
            pi = pr * ci + pi * cr;
            pr = nr;
        }

        magnitude[b] = Math.sqrt(sumR * sumR + sumI * sumI);
    }

    function mag(bpm) {
        const index = Math.round((bpm - MIN_BPM) / STEP);
        return index >= 0 && index < bins ? magnitude[index] : 0;
    }

    // ---------- Pick the best tempo ----------
    // A real tempo also shows energy at double and half its speed.
    // The prior favours everyday tempos so 70 BPM isn't reported as 140.
    const PRIOR_CENTRE = options.priorCentre || 100;
    const PRIOR_WIDTH = options.priorWidth || 0.5;    // in octaves
    const DOUBLE_WEIGHT = options.doubleWeight !== undefined ? options.doubleWeight : 0.5;
    const HALF_WEIGHT = options.halfWeight !== undefined ? options.halfWeight : 0.5;

    const scores = [];
    let gridConfidence = null;
    let bestScore = 0;
    let bestBpm = null;
    let scoreSum = 0;

    for (let bpm = 60; bpm <= 200.001; bpm += STEP) {

        const octaves = Math.log2(bpm / PRIOR_CENTRE) / PRIOR_WIDTH;
        const prior = Math.exp(-0.5 * octaves * octaves);

        const score = (mag(bpm) + DOUBLE_WEIGHT * mag(bpm * 2) + HALF_WEIGHT * mag(bpm / 2)) * prior;

        scores.push({ bpm, score });
        scoreSum += score;

        if (score > bestScore) {
            bestScore = score;
            bestBpm = bpm;
        }
    }

    if (bestBpm === null || bestScore === 0) {
        return { bpm: null, confidence: 0, reason: "No steady rhythm could be found." };
    }

    // ---------- Check the strongest candidates against the hits ----------
    // The tempogram can lock onto a harmonic of the real tempo when the
    // rhythm is syncopated (e.g. 117.5 for a beat that is really 94, because
    // 117.5 = 5/4 of 94). So take the strongest candidates plus their double
    // and half, and measure how well the actual hits land on each tempo's
    // beat grid. The real tempo's grid is the one the hits sit on.

    let rawMean = 0;
    for (let i = 0; i < frameCount; i++) rawMean += onsetRaw[i];
    rawMean /= frameCount;

    // Short windows, each free to find its own phase, so a little timing
    // wobble (or mp3 encoding) doesn't spoil a long-range grid.
    const WINDOW = Math.round(fps * 8);
    const windows = [];

    for (let w0 = 0; w0 + WINDOW <= frameCount; w0 += WINDOW) {
        let m = 0;
        for (let i = w0; i < w0 + WINDOW; i++) m += onsetRaw[i];
        m /= WINDOW;
        if (m > rawMean * 0.2) windows.push(w0);   // skip near-silence
    }

    function gridLift(bpm) {

        if (windows.length === 0 || rawMean === 0) return 0;

        const stepFrames = (fps * 60) / bpm;
        const beatsPerWindow = Math.floor((WINDOW - 2) / stepFrames);

        if (beatsPerWindow < 4) return 0;

        const phases = 48;
        let total = 0;

        for (const w0 of windows) {

            let best = 0;

            for (let p = 0; p < phases; p++) {

                const offset = (p / phases) * stepFrames;
                let sum = 0;

                for (let k = 0; k < beatsPerWindow; k++) {
                    const c = Math.round(w0 + 1 + offset + k * stepFrames);
                    // hits can sit a frame early or late
                    const a = onsetRaw[c - 1];
                    const b = onsetRaw[c];
                    const d = onsetRaw[c + 1];
                    sum += a > b ? (a > d ? a : d) : (b > d ? b : d);
                }

                if (sum > best) best = sum;
            }

            total += best / beatsPerWindow;
        }

        return total / windows.length / rawMean;
    }

    function priorAt(bpm) {
        const octaves = Math.log2(bpm / PRIOR_CENTRE) / PRIOR_WIDTH;
        return Math.exp(-0.5 * octaves * octaves);
    }

    // Candidates: strongest tempogram peaks, plus the double and half of the best few.
    const peaks = [];
    for (let b = 50; b <= 220; b += STEP) {
        const m0 = mag(b);
        if (m0 > mag(b - STEP) && m0 >= mag(b + STEP) && m0 > mag(b - 0.5) && m0 > mag(b + 0.5)) {
            peaks.push({ bpm: b, m: m0 });
        }
    }
    peaks.sort((x, y) => y.m - x.m);

    const candidates = [];

    function addCandidate(bpm) {
        if (bpm < 55 || bpm > 210) return;
        for (const c of candidates) {
            if (Math.abs(c - bpm) / bpm < 0.025) return;
        }
        candidates.push(bpm);
    }

    peaks.slice(0, 10).forEach(pk => addCandidate(pk.bpm));
    peaks.slice(0, 5).forEach(pk => { addCandidate(pk.bpm * 2); addCandidate(pk.bpm / 2); });
    addCandidate(bestBpm);

    // Fine-tune each candidate: tiny steps, because a grid is sharp.
    const checked = [];

    for (const c of candidates) {

        const scan = [];
        let bestLift = 0;
        let bestIndex = 0;

        for (let b = c * 0.985; b <= c * 1.015 + 1e-9; b += 0.1) {
            const lift = gridLift(b);
            scan.push({ b, lift });
            if (lift > bestLift) {
                bestLift = lift;
                bestIndex = scan.length - 1;
            }
        }

        // The true tempo sits in the middle of the plateau, not at its
        // first high point, so average the neighbours that score nearly as
        // well as the best one.
        let lo = bestIndex;
        let hi = bestIndex;
        while (lo > 0 && scan[lo - 1].lift >= bestLift * 0.93) lo--;
        while (hi < scan.length - 1 && scan[hi + 1].lift >= bestLift * 0.93) hi++;

        let weightSum = 0;
        let weighted = 0;
        for (let i = lo; i <= hi; i++) {
            weightSum += scan[i].lift;
            weighted += scan[i].b * scan[i].lift;
        }

        const bestAt = weighted / weightSum;

        checked.push({ bpm: bestAt, lift: bestLift, score: bestLift * priorAt(bestAt) });
    }

    checked.sort((x, y) => y.score - x.score);

    if (checked.length > 0 && checked[0].score > 0) {

        bestBpm = checked[0].bpm;
        bestScore = checked[0].score;

        // Confidence now means: the winner's grid beats every unrelated tempo's.
        let runner = 0;
        for (const c of checked) {
            if (Math.abs(c.bpm - bestBpm) / bestBpm > 0.06 && c.score > runner) runner = c.score;
        }

        const gridSeparation = 1 - runner / bestScore;
        const gridStrength = Math.max(0, Math.min(1, (checked[0].lift - 1) / 5));

        gridConfidence = 0.5 * gridSeparation + 0.5 * gridStrength;
    }

    // Confidence: how far the winner stands above the best unrelated tempo.
    let runnerUp = 0;
    for (const s of scores) {
        if (Math.abs(s.bpm - bestBpm) / bestBpm > 0.06 && s.score > runnerUp) {
            runnerUp = s.score;
        }
    }

    const separation = 1 - runnerUp / bestScore;
    const prominence = Math.min(1, (bestScore / (scoreSum / scores.length)) / 12);
    const confidence = gridConfidence !== null
        ? Math.max(0, Math.min(1, gridConfidence))
        : Math.max(0, Math.min(1, 0.6 * separation + 0.4 * prominence));

    const output = {
        bpm: Math.round(bestBpm * 10) / 10,
        confidence: Math.round(confidence * 100) / 100
    };

    if (options.debug) {
        output.checked = checked.map(c => ({ bpm: Math.round(c.bpm * 10) / 10, lift: Math.round(c.lift * 100) / 100, score: Math.round(c.score * 100) / 100 }));
    }

    // Optional: keep the full tempogram so a caller can look for the
    // tempo closest to a known target (used for the vocal vs the beat).
    if (options.returnTempogram) {
        output.tempogram = Float32Array.from(magnitude);
        output.tempogramMin = MIN_BPM;
        output.tempogramStep = STEP;
    }

    return output;
}


/* =========================================================
   BROWSER WRAPPER
   Mixes the beat to mono, then runs detectBpm off the main thread.
   ========================================================= */

function analyzeBpm(audioBuffer) {

    const sampleRate = audioBuffer.sampleRate;

    // Analyse up to 90 seconds. For long tracks skip the first 10 seconds
    // so a quiet intro doesn't dominate.
    const startSeconds = audioBuffer.duration > 110 ? 10 : 0;
    const startSample = Math.floor(startSeconds * sampleRate);
    const length = Math.min(
        audioBuffer.length - startSample,
        Math.floor(90 * sampleRate)
    );

    const mono = new Float32Array(length);

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const channel = audioBuffer.getChannelData(c);
        for (let i = 0; i < length; i++) {
            mono[i] += channel[startSample + i] / audioBuffer.numberOfChannels;
        }
    }

    return new Promise((resolve, reject) => {

        let worker;

        try {

            const source =
                "const detectBpm = " + detectBpm.toString() + ";\n" +
                "self.onmessage = function (e) {\n" +
                "  try {\n" +
                "    self.postMessage({ result: detectBpm(e.data.samples, e.data.sampleRate) });\n" +
                "  } catch (err) {\n" +
                "    self.postMessage({ error: String(err) });\n" +
                "  }\n" +
                "};";

            const url = URL.createObjectURL(
                new Blob([source], { type: "text/javascript" })
            );

            worker = new Worker(url);

            worker.onmessage = (event) => {
                URL.revokeObjectURL(url);
                worker.terminate();

                if (event.data.error) {
                    reject(new Error(event.data.error));
                } else {
                    resolve(event.data.result);
                }
            };

            worker.onerror = (event) => {
                URL.revokeObjectURL(url);
                worker.terminate();
                reject(new Error(event.message || "Analysis worker failed."));
            };

            worker.postMessage({ samples: mono, sampleRate }, [mono.buffer]);

        } catch (error) {

            // Workers unavailable: fall back to the main thread.
            try {
                resolve(detectBpm(mono, sampleRate));
            } catch (fallbackError) {
                reject(fallbackError);
            }

        }
    });
}

/* =========================================================
   VOCAL TEMPO
   A vocal has no drums, so its tempo is read from where syllables
   start. That is much less reliable than reading a beat, so the
   result is always judged against the beat's BPM:

   - analyzeVocalTempo()  runs the rhythm engine on the vocal once
                          (in a worker) and keeps the full tempogram.
   - findTempoNear()      reads that tempogram around a target BPM.
                          Instant, so it can be re-run whenever the
                          user changes the beat BPM (÷2 / ×2).
   Searching near the beat's tempo also settles the half/double-time
   question, because only one octave is looked at.
   ========================================================= */

function analyzeVocalTempo(audioBuffer) {

    const sampleRate = audioBuffer.sampleRate;
    const total = audioBuffer.length;

    // Mix to mono.
    const full = new Float32Array(total);

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const channel = audioBuffer.getChannelData(c);
        for (let i = 0; i < total; i++) {
            full[i] += channel[i] / audioBuffer.numberOfChannels;
        }
    }

    // Skip leading silence so a long quiet intro doesn't waste the window.
    let peak = 0;
    for (let i = 0; i < total; i++) {
        const a = Math.abs(full[i]);
        if (a > peak) peak = a;
    }

    let start = 0;
    const block = 512;

    for (let i = 0; i + block <= total && peak > 0; i += block) {
        let sum = 0;
        for (let j = 0; j < block; j++) sum += full[i + j] * full[i + j];
        if (Math.sqrt(sum / block) > peak * 0.03) {
            start = Math.max(0, i - Math.floor(0.1 * sampleRate));
            break;
        }
    }

    // Analyse up to two minutes of performance.
    const length = Math.min(total - start, Math.floor(120 * sampleRate));
    const mono = full.slice(start, start + length);

    const options = { returnTempogram: true };

    return new Promise((resolve, reject) => {

        let worker;

        try {

            const source =
                "const detectBpm = " + detectBpm.toString() + ";\n" +
                "self.onmessage = function (e) {\n" +
                "  try {\n" +
                "    self.postMessage({ result: detectBpm(e.data.samples, e.data.sampleRate, e.data.options) });\n" +
                "  } catch (err) {\n" +
                "    self.postMessage({ error: String(err) });\n" +
                "  }\n" +
                "};";

            const url = URL.createObjectURL(
                new Blob([source], { type: "text/javascript" })
            );

            worker = new Worker(url);

            worker.onmessage = (event) => {
                URL.revokeObjectURL(url);
                worker.terminate();

                if (event.data.error) {
                    reject(new Error(event.data.error));
                } else {
                    resolve(event.data.result);
                }
            };

            worker.onerror = (event) => {
                URL.revokeObjectURL(url);
                worker.terminate();
                reject(new Error(event.message || "Vocal tempo worker failed."));
            };

            worker.postMessage({ samples: mono, sampleRate, options }, [mono.buffer]);

        } catch (error) {

            // Workers unavailable: fall back to the main thread.
            try {
                resolve(detectBpm(mono, sampleRate, options));
            } catch (fallbackError) {
                reject(fallbackError);
            }

        }
    });
}


// Reads the vocal's tempogram around targetBpm (default +/-20%).
// Returns { bpm, confidence, atEdge } or null if there is no tempogram.
function findTempoNear(result, targetBpm, range) {

    if (!result || !result.tempogram || !targetBpm) return null;

    range = range || 0.2;

    const mags = result.tempogram;
    const min = result.tempogramMin;
    const step = result.tempogramStep;

    function mag(bpm) {
        const index = Math.round((bpm - min) / step);
        return index >= 0 && index < mags.length ? mags[index] : 0;
    }

    // Same idea as detectBpm: a real tempo also shows energy at 2x and 1/2x.
    function score(bpm) {
        return mag(bpm) + 0.5 * mag(bpm * 2) + 0.5 * mag(bpm / 2);
    }

    // Typical score across everyday tempos, to judge how much the peak stands out.
    let referenceSum = 0;
    let referenceCount = 0;

    for (let b = 60; b <= 200.001; b += step) {
        referenceSum += score(b);
        referenceCount++;
    }

    const reference = referenceSum / referenceCount;

    const low = targetBpm * (1 - range);
    const high = targetBpm * (1 + range);

    const candidates = [];
    let best = null;

    for (let b = low; b <= high + 1e-9; b += step) {
        const s = score(b);
        candidates.push({ bpm: b, score: s });
        if (!best || s > best.score) best = { bpm: b, score: s };
    }

    if (!best || best.score <= 0) return null;

    // Best peak that isn't just the same peak (more than 4% away).
    let runnerUp = 0;

    for (const c of candidates) {
        if (Math.abs(c.bpm - best.bpm) / best.bpm > 0.04 && c.score > runnerUp) {
            runnerUp = c.score;
        }
    }

    // How far the peak rises above a typical tempo. Measured on synthetic
    // vocals: rhythmic ones sit at about 2.9x to 5x, vocals with no steady
    // pulse at about 1.4x to 2.2x. So 1.5x counts as nothing, 4.5x as certain.
    const ratio = best.score / reference;
    const prominence = Math.max(0, Math.min(1, (ratio - 1.5) / 3));
    const separation = 1 - runnerUp / best.score;
    const confidence = Math.max(0, Math.min(1, 0.65 * prominence + 0.35 * separation));

    // A winner sitting on the edge is usually the slope of a peak outside the range.
    const atEdge =
        best.bpm - low < targetBpm * 0.01 ||
        high - best.bpm < targetBpm * 0.01;

    return {
        bpm: Math.round(best.bpm * 10) / 10,
        confidence: Math.round(confidence * 100) / 100,
        atEdge
    };
}

/* =========================================================
   VOCAL PITCH WRAPPER
   detectVocalPitch is heavy (autocorrelation on every frame), so it
   runs in a Web Worker. Running it on the main thread froze the page
   and made the "Continue to Analysis" button look dead.
   ========================================================= */

function analyzeVocalPitch(audioBuffer) {

    // Mix to mono here so only one array is sent to the worker.
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const mono = new Float32Array(length);

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const channel = audioBuffer.getChannelData(c);
        for (let i = 0; i < length; i++) {
            mono[i] += channel[i] / audioBuffer.numberOfChannels;
        }
    }

    // Minimal stand-in for an AudioBuffer (mono, already mixed).
    function asBuffer(samples, rate) {
        return {
            sampleRate: rate,
            length: samples.length,
            numberOfChannels: 1,
            getChannelData: () => samples
        };
    }

    return new Promise((resolve, reject) => {

        let worker;

        try {

            const source =
                "const detectVocalPitch = " + detectVocalPitch.toString() + ";\n" +
                "self.onmessage = function (e) {\n" +
                "  try {\n" +
                "    const s = e.data.samples;\n" +
                "    const buf = { sampleRate: e.data.sampleRate, length: s.length, numberOfChannels: 1, getChannelData: function () { return s; } };\n" +
                "    self.postMessage({ result: detectVocalPitch(buf) });\n" +
                "  } catch (err) {\n" +
                "    self.postMessage({ error: String(err) });\n" +
                "  }\n" +
                "};";

            const url = URL.createObjectURL(
                new Blob([source], { type: "text/javascript" })
            );

            worker = new Worker(url);

            worker.onmessage = (event) => {
                URL.revokeObjectURL(url);
                worker.terminate();

                if (event.data.error) {
                    reject(new Error(event.data.error));
                } else {
                    resolve(event.data.result);
                }
            };

            worker.onerror = (event) => {
                URL.revokeObjectURL(url);
                worker.terminate();
                reject(new Error(event.message || "Pitch worker failed."));
            };

            worker.postMessage({ samples: mono, sampleRate }, [mono.buffer]);

        } catch (error) {

            // Workers unavailable: fall back to the main thread.
            try {
                resolve(detectVocalPitch(asBuffer(mono, sampleRate)));
            } catch (fallbackError) {
                reject(fallbackError);
            }

        }
    });
}

if (typeof window !== "undefined") {
    window.VocalVaultAnalysis = {
        analyzeBpm,
        detectKey,
        detectVocalPitch: analyzeVocalPitch,  // async, runs in a worker
        analyzeVocalTempo,                    // async, runs in a worker
        findTempoNear                         // instant, reads the tempogram
    };
}

if (typeof module !== "undefined") {
    module.exports = { detectBpm, findTempoNear };
}
// ============================================================
// BEAT KEY + SCALE DETECTION
// ============================================================
// Detects the musical key of an audio buffer using chroma
// analysis. The result is something like:
//
//     C Major
//     F# Minor
//     Bb Major
//
// This works by:
// 1. Converting the beat to mono.
// 2. Breaking it into short FFT windows.
// 3. Measuring energy across the 12 pitch classes.
// 4. Comparing the resulting chroma profile against
//    major and minor key profiles.
// ============================================================

    function detectKey(audioBuffer) {

    if (!audioBuffer) {
        return {
            key: null,
            scale: null,
            confidence: 0,
            reason: "No audio available."
        };
    }

    const sampleRate = audioBuffer.sampleRate;

    // --------------------------------------------------------
    // Convert the audio to mono.
    // --------------------------------------------------------

    const length = audioBuffer.length;
    const channels = audioBuffer.numberOfChannels;

    const mono = new Float32Array(length);

    for (let channel = 0; channel < channels; channel++) {

        const data = audioBuffer.getChannelData(channel);

        for (let i = 0; i < length; i++) {
            mono[i] += data[i] / channels;
        }

    }

    // --------------------------------------------------------
    // Limit analysis to the first 90 seconds.
    // This keeps the analysis reasonably fast.
    // --------------------------------------------------------

    const maxSeconds = 90;

    const analysisLength = Math.min(
        length,
        Math.floor(sampleRate * maxSeconds)
    );

    // --------------------------------------------------------
    // FFT settings.
    // --------------------------------------------------------

    const fftSize = 8192;
    const hopSize = 4096;

    const chroma = new Float64Array(12);

    let analysedFrames = 0;

    // Hann window.
    const window = new Float64Array(fftSize);

    for (let i = 0; i < fftSize; i++) {

        window[i] =
            0.5 *
            (
                1 -
                Math.cos(
                    (2 * Math.PI * i) /
                    (fftSize - 1)
                )
            );

    }

    // --------------------------------------------------------
    // FFT implementation.
    // --------------------------------------------------------

    function fft(real, imag) {

        const n = real.length;

        // Bit reversal.
        let j = 0;

        for (let i = 1; i < n; i++) {

            let bit = n >> 1;

            while (j & bit) {
                j ^= bit;
                bit >>= 1;
            }

            j ^= bit;

            if (i < j) {

                const tempReal = real[i];
                real[i] = real[j];
                real[j] = tempReal;

                const tempImag = imag[i];
                imag[i] = imag[j];
                imag[j] = tempImag;

            }

        }

        // Cooley-Tukey FFT.
        for (let size = 2; size <= n; size <<= 1) {

            const halfSize = size >> 1;

            const angle =
                -2 * Math.PI / size;

            const phaseStepReal = Math.cos(angle);
            const phaseStepImag = Math.sin(angle);

            let currentReal = 1;
            let currentImag = 0;

            for (let i = 0; i < halfSize; i++) {

                for (
                    let j = i;
                    j < n;
                    j += size
                ) {

                    const k = j + halfSize;

                    const tempReal =
                        currentReal * real[k] -
                        currentImag * imag[k];

                    const tempImag =
                        currentReal * imag[k] +
                        currentImag * real[k];

                    real[k] =
                        real[j] - tempReal;

                    imag[k] =
                        imag[j] - tempImag;

                    real[j] += tempReal;
                    imag[j] += tempImag;

                }

                const nextReal =
                    currentReal * phaseStepReal -
                    currentImag * phaseStepImag;

                const nextImag =
                    currentReal * phaseStepImag +
                    currentImag * phaseStepReal;

                currentReal = nextReal;
                currentImag = nextImag;

            }

        }

    }

    // --------------------------------------------------------
    // Convert frequency into one of the 12 pitch classes.
    //
    // MIDI:
    // C  = 0
    // C# = 1
    // D  = 2
    // ...
    // B  = 11
    // --------------------------------------------------------

    function frequencyToPitchClass(frequency) {

        if (frequency <= 0) {
            return -1;
        }

        const midi =
            69 +
            12 *
            Math.log2(frequency / 440);

        const roundedMidi =
            Math.round(midi);

        return (
            (roundedMidi % 12) + 12
        ) % 12;

    }

    // --------------------------------------------------------
    // Analyse each FFT frame.
    // --------------------------------------------------------

    for (
        let start = 0;
        start + fftSize <= analysisLength;
        start += hopSize
    ) {

        const real =
            new Float64Array(fftSize);

        const imag =
            new Float64Array(fftSize);

        // Apply Hann window.
        for (let i = 0; i < fftSize; i++) {

            real[i] =
                mono[start + i] *
                window[i];

        }

        fft(real, imag);

        // ----------------------------------------------------
        // Convert spectral energy into chroma.
        // We focus primarily on the musical range.
        // ----------------------------------------------------

        for (
            let bin = 1;
            bin < fftSize / 2;
            bin++
        ) {

            const frequency =
                bin * sampleRate / fftSize;

            // Ignore sub-bass and extremely high frequencies.
            if (
                frequency < 110 ||
                frequency > 2000
            ) {
                continue;
            }

            const magnitude =
                Math.sqrt(
                    real[bin] * real[bin] +
                    imag[bin] * imag[bin]
                );

            if (magnitude <= 0) {
                continue;
            }

            const prevMag = Math.hypot(real[bin - 1], imag[bin - 1]);
            const nextMag = Math.hypot(real[bin + 1], imag[bin + 1]);

            if (magnitude < prevMag || magnitude < nextMag) {
                continue;
            }

            const pitchClass =
                frequencyToPitchClass(frequency);

            if (pitchClass < 0) {
                continue;
            }

            // Give stronger partials more influence,
            // while preventing very loud frequencies
            // from completely dominating the profile.
            const weight =
                Math.pow(magnitude, 0.5);

            chroma[pitchClass] += weight;

        }

        analysedFrames++;

    }

    // --------------------------------------------------------
    // Make sure enough audio was actually analysed.
    // --------------------------------------------------------

    if (
        analysedFrames === 0 ||
        chroma.every(value => value === 0)
    ) {

        return {
            key: null,
            scale: null,
            confidence: 0,
            reason: "Not enough tonal information."
        };

    }

    // --------------------------------------------------------
    // Normalise chroma.
    // --------------------------------------------------------

    let chromaTotal = 0;

    for (let i = 0; i < 12; i++) {
        chromaTotal += chroma[i];
    }

    if (chromaTotal === 0) {

        return {
            key: null,
            scale: null,
            confidence: 0,
            reason: "Could not detect musical notes."
        };

    }

    for (let i = 0; i < 12; i++) {
        chroma[i] /= chromaTotal;
    }

    // --------------------------------------------------------
    // Standard key profiles.
    //
    // These represent the expected distribution of pitch
    // classes in major and minor tonalities.
    // --------------------------------------------------------

    const majorProfile = [
        6.35,
        2.23,
        3.48,
        2.33,
        4.38,
        4.09,
        2.52,
        5.19,
        2.39,
        3.66,
        2.29,
        2.88
    ];

    const minorProfile = [
        6.33,
        2.68,
        3.52,
        5.38,
        2.60,
        3.53,
        2.54,
        4.75,
        3.98,
        2.69,
        3.34,
        3.17
    ];

    const noteNames = [
        "C",
        "C#",
        "D",
        "D#",
        "E",
        "F",
        "F#",
        "G",
        "G#",
        "A",
        "A#",
        "B"
    ];

    // --------------------------------------------------------
    // Pearson correlation.
    //
    // We rotate the key profile through all 12 possible
    // root notes and compare it to the detected chroma.
    // --------------------------------------------------------

    function correlation(a, b) {

        let meanA = 0;
        let meanB = 0;

        for (let i = 0; i < 12; i++) {
            meanA += a[i];
            meanB += b[i];
        }

        meanA /= 12;
        meanB /= 12;

        let numerator = 0;
        let denominatorA = 0;
        let denominatorB = 0;

        for (let i = 0; i < 12; i++) {

            const x = a[i] - meanA;
            const y = b[i] - meanB;

            numerator += x * y;
            denominatorA += x * x;
            denominatorB += y * y;

        }

        const denominator =
            Math.sqrt(
                denominatorA *
                denominatorB
            );

        if (denominator === 0) {
            return 0;
        }

        return numerator / denominator;

    }

    // --------------------------------------------------------
    // Find the best matching key.
    // --------------------------------------------------------

    let bestScore = -Infinity;
    let secondBestScore = -Infinity;

    let bestRoot = 0;
    let bestScale = "Major";

    for (let root = 0; root < 12; root++) {

        const rotatedMajor = [];
        const rotatedMinor = [];

        for (let i = 0; i < 12; i++) {

            rotatedMajor.push(
                majorProfile[
                    (i - root + 12) % 12
                ]
            );

            rotatedMinor.push(
                minorProfile[
                    (i - root + 12) % 12
                ]
            );

        }

        const majorScore =
            correlation(
                chroma,
                rotatedMajor
            );

        const minorScore =
            correlation(
                chroma,
                rotatedMinor
            );

        const candidates = [
            {
                score: majorScore,
                scale: "Major"
            },
            {
                score: minorScore,
                scale: "Minor"
            }
        ];

        for (const candidate of candidates) {

            if (candidate.score > bestScore) {

                secondBestScore = bestScore;

                bestScore =
                    candidate.score;

                bestRoot = root;
                bestScale = candidate.scale;

            } else if (
                candidate.score >
                secondBestScore
            ) {

                secondBestScore =
                    candidate.score;

            }

        }

    }

    // --------------------------------------------------------
    // Confidence is based on how clearly the winning key
    // separates itself from the second-best candidate.
    // --------------------------------------------------------

    const separation =
        Math.max(
            0,
            bestScore - secondBestScore
        );

    const confidence =
        Math.max(
            0,
            Math.min(
                1,
                separation / 0.20
            )
        );

    return {
        key: noteNames[bestRoot],
        scale: bestScale,
        confidence,
        score: bestScore
    };
}


    // ============================================================
// VOCAL PITCH DETECTION
// ============================================================
// Detects the fundamental frequency (F0) of the vocal over time.
//
// Output example:
//
// {
//     time: 1.25,
//     frequency: 261.63,
//     midi: 60,
//     note: "C4",
//     confidence: 0.91
// }
//
// The detector uses normalized autocorrelation. This is much
// more appropriate for monophonic vocals than simply looking
// for the loudest FFT frequency.
// ============================================================

function detectVocalPitch(audioBuffer) {

    if (!audioBuffer) {

        return {
            frames: [],
            minMidi: null,
            maxMidi: null,
            noteRange: null,
            confidence: 0,
            reason: "No vocal audio available."
        };

    }

    const sampleRate = audioBuffer.sampleRate;

    // --------------------------------------------------------
    // Convert vocal to mono.
    // --------------------------------------------------------

    const length = audioBuffer.length;
    const channels = audioBuffer.numberOfChannels;

    const mono = new Float32Array(length);

    for (let channel = 0; channel < channels; channel++) {

        const data =
            audioBuffer.getChannelData(channel);

        for (let i = 0; i < length; i++) {

            mono[i] +=
                data[i] / channels;

        }

    }

    // --------------------------------------------------------
    // Pitch range.
    //
    // 70Hz  ≈ C#2
    // 1000Hz ≈ B5
    //
    // This covers a very wide practical vocal range.
    // --------------------------------------------------------

    const minFrequency = 70;
    const maxFrequency = 1000;

    const minLag =
        Math.floor(
            sampleRate / maxFrequency
        );

    const maxLag =
        Math.floor(
            sampleRate / minFrequency
        );

    // --------------------------------------------------------
    // Analysis settings.
    // --------------------------------------------------------

    const frameSize = 4096;
    const hopSize = 1024;

    // --------------------------------------------------------
    // Fast autocorrelation setup (FFT based).
    // The old version compared every lag sample-by-sample, which
    // was thousands of times slower than this.
    // --------------------------------------------------------

    const acN = frameSize * 2;                  // zero-padded FFT size
    const acLevels = Math.round(Math.log2(acN));
    const acRe = new Float64Array(acN);
    const acIm = new Float64Array(acN);
    const acCos = new Float64Array(acN / 2);
    const acSin = new Float64Array(acN / 2);
    const acRev = new Uint16Array(acN);
    const acCorr = new Float64Array(maxLag + 2);
    const acSq = new Float64Array(frameSize + 1);

    for (let k = 0; k < acN / 2; k++) {
        acCos[k] = Math.cos((2 * Math.PI * k) / acN);
        acSin[k] = Math.sin((2 * Math.PI * k) / acN);
    }

    for (let i = 0; i < acN; i++) {
        acRev[i] = (acRev[i >> 1] >> 1) | ((i & 1) << (acLevels - 1));
    }

    function acFft(re, im) {

        for (let i = 0; i < acN; i++) {
            const j = acRev[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }

        for (let size = 2; size <= acN; size <<= 1) {
            const half = size >> 1;
            const step = acN / size;
            for (let i = 0; i < acN; i += size) {
                for (let j = 0, k = 0; j < half; j++, k += step) {
                    const a = i + j;
                    const b = a + half;
                    const tr = re[b] * acCos[k] + im[b] * acSin[k];
                    const ti = im[b] * acCos[k] - re[b] * acSin[k];
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
        }
    }

    const frames = [];

    let totalConfidence = 0;
    let voicedFrames = 0;

    // --------------------------------------------------------
    // Helper: convert frequency to MIDI.
    // --------------------------------------------------------

    function frequencyToMidi(frequency) {

        return (
            69 +
            12 *
            Math.log2(
                frequency / 440
            )
        );

    }

    // --------------------------------------------------------
    // Helper: MIDI to note name.
    // --------------------------------------------------------

    const noteNames = [
        "C",
        "C#",
        "D",
        "D#",
        "E",
        "F",
        "F#",
        "G",
        "G#",
        "A",
        "A#",
        "B"
    ];

    function midiToNote(midi) {

        const rounded =
            Math.round(midi);

        const note =
            noteNames[
                ((rounded % 12) + 12) % 12
            ];

        const octave =
            Math.floor(
                rounded / 12
            ) - 1;

        return `${note}${octave}`;

    }

    // --------------------------------------------------------
    // Analyse each frame.
    // --------------------------------------------------------

    for (
        let start = 0;
        start + frameSize <= length;
        start += hopSize
    ) {

        const frame =
            new Float32Array(frameSize);

        let energy = 0;

        for (let i = 0; i < frameSize; i++) {

            const sample =
                mono[start + i];

            frame[i] = sample;

            energy +=
                sample * sample;

        }

        // ----------------------------------------------------
        // RMS amplitude.
        // Used to reject silence/background noise.
        // ----------------------------------------------------

        const rms =
            Math.sqrt(
                energy / frameSize
            );

        if (rms < 0.008) {

            frames.push({
                time: start / sampleRate,
                frequency: null,
                midi: null,
                note: null,
                confidence: 0
            });

            continue;

        }

        // ----------------------------------------------------
        // Remove the DC component.
        // ----------------------------------------------------

        let mean = 0;

        for (let i = 0; i < frameSize; i++) {
            mean += frame[i];
        }

        mean /= frameSize;

        for (let i = 0; i < frameSize; i++) {
            frame[i] -= mean;
        }

        // ----------------------------------------------------
        // Find the strongest autocorrelation peak.
        // ----------------------------------------------------

        // Autocorrelation via FFT: r = IFFT(|FFT(frame)|^2)
        for (let i = 0; i < frameSize; i++) {
            acRe[i] = frame[i];
        }
        for (let i = frameSize; i < acN; i++) {
            acRe[i] = 0;
        }
        acIm.fill(0);

        acFft(acRe, acIm);

        for (let k = 0; k < acN; k++) {
            acRe[k] = acRe[k] * acRe[k] + acIm[k] * acIm[k];
            acIm[k] = 0;
        }

        acFft(acRe, acIm);      // power spectrum is real + symmetric, so a forward FFT works as the inverse

        // Running energy so each lag can be normalised.
        acSq[0] = 0;
        for (let i = 0; i < frameSize; i++) {
            acSq[i + 1] = acSq[i] + frame[i] * frame[i];
        }

        let maxCorrelation = 0;

        for (let lag = minLag; lag <= maxLag + 1; lag++) {

            const energyA = acSq[frameSize - lag];
            const energyB = acSq[frameSize] - acSq[lag];
            const denominator = Math.sqrt(energyA * energyB);

            const c = denominator === 0
                ? 0
                : (acRe[lag] / acN) / denominator;

            acCorr[lag] = c;

            if (lag <= maxLag && c > maxCorrelation) {
                maxCorrelation = c;
            }
        }

        // Prefer the SHORTEST lag that is nearly as strong as the best one.
        // Multiples of the true period correlate almost as well, which is
        // what caused octave errors (e.g. reporting D2 for a 220 Hz voice).
        let bestLag = -1;
        let bestCorrelation = 0;

        const threshold = maxCorrelation * 0.85;

        for (let lag = minLag; lag <= maxLag; lag++) {

            const c = acCorr[lag];

            if (
                c >= threshold &&
                c >= acCorr[lag - 1] &&
                c >= acCorr[lag + 1]
            ) {

                bestLag = lag;
                bestCorrelation = c;

                // Parabolic interpolation for sub-sample accuracy.
                const y1 = acCorr[lag - 1];
                const y2 = c;
                const y3 = acCorr[lag + 1];
                const curve = y1 - 2 * y2 + y3;

                if (curve < 0) {
                    bestLag = lag + 0.5 * (y1 - y3) / curve;
                }

                break;
            }
        }

        // ----------------------------------------------------
        // Reject weak / unreliable pitch candidates.
        // ----------------------------------------------------

        if (
            bestLag === -1 ||
            bestCorrelation < 0.30
        ) {

            frames.push({
                time: start / sampleRate,
                frequency: null,
                midi: null,
                note: null,
                confidence: 0
            });

            continue;

        }

        // ----------------------------------------------------
        // Convert period to frequency.
        // ----------------------------------------------------

        const frequency =
            sampleRate / bestLag;

        if (
            frequency < minFrequency ||
            frequency > maxFrequency
        ) {

            frames.push({
                time: start / sampleRate,
                frequency: null,
                midi: null,
                note: null,
                confidence: 0
            });

            continue;

        }

        const midi =
            frequencyToMidi(
                frequency
            );

        const note =
            midiToNote(midi);

        frames.push({
            time: start / sampleRate,
            frequency,
            midi,
            note,
            confidence: bestCorrelation
        });

        totalConfidence +=
            bestCorrelation;

        voicedFrames++;

    }

    // --------------------------------------------------------
    // No usable vocal pitch found.
    // --------------------------------------------------------

    if (voicedFrames === 0) {

        return {
            frames,
            minMidi: null,
            maxMidi: null,
            noteRange: null,
            confidence: 0,
            reason:
                "Could not detect a clear vocal pitch."
        };

    }

    // --------------------------------------------------------
    // Remove isolated pitch glitches.
    //
    // A single frame that is wildly different from the
    // surrounding vocal pitch is usually an octave error,
    // consonant, breath, or noise.
    // --------------------------------------------------------

    for (
        let i = 1;
        i < frames.length - 1;
        i++
    ) {

        const previous =
            frames[i - 1];

        const current =
            frames[i];

        const next =
            frames[i + 1];

        if (
            current.midi === null ||
            previous.midi === null ||
            next.midi === null
        ) {
            continue;
        }

        const previousDistance =
            Math.abs(
                current.midi -
                previous.midi
            );

        const nextDistance =
            Math.abs(
                current.midi -
                next.midi
            );

        // A jump greater than roughly a perfect fifth
        // in a single frame is suspicious.
        if (
            previousDistance > 7 &&
            nextDistance > 7
        ) {

            current.frequency =
                (
                    previous.frequency +
                    next.frequency
                ) / 2;

            current.midi =
                (
                    previous.midi +
                    next.midi
                ) / 2;

            current.note =
                midiToNote(
                    current.midi
                );

        }

    }

    // --------------------------------------------------------
    // Determine the usable vocal range.
    // --------------------------------------------------------

    // A single glitch frame (breath, noise, octave jump) used to stretch
    // the range by several octaves. Instead, take the 5th and 95th
    // percentile of the reliable frames, so a few bad frames are ignored.
    let pool = [];

    for (const frame of frames) {
        if (frame.midi !== null && frame.confidence >= 0.6) {
            pool.push(frame.midi);
        }
    }

    // Quiet or rough vocals: fall back to every voiced frame.
    if (pool.length < 20) {
        pool = [];
        for (const frame of frames) {
            if (frame.midi !== null) {
                pool.push(frame.midi);
            }
        }
    }

    pool.sort((x, y) => x - y);

    const trim = Math.floor(pool.length * 0.05);

    const minMidi = pool[trim];
    const maxMidi = pool[pool.length - 1 - trim];

    const roundedMinMidi =
        Math.round(minMidi);

    const roundedMaxMidi =
        Math.round(maxMidi);

    const noteRange =
        `${midiToNote(roundedMinMidi)} – ${midiToNote(roundedMaxMidi)}`;

    const confidence =
        totalConfidence /
        voicedFrames;

    return {
        frames,
        minMidi: roundedMinMidi,
        maxMidi: roundedMaxMidi,
        noteRange,
        confidence
    };

}