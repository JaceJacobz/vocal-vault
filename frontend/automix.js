/**
 * automix.js - Vocal Vault Automated Processing Engine
 *
 * Everything is decided from the audio itself, so the user never sets
 * anything. Rendered offline, so it is deterministic.
 *
 *   VOCAL     high-pass -> de-esser -> auto-EQ          (studio.js)
 *             -> two-stage compression                   (this file)
 *             -> warmth                                  (studio.js)
 *   LEVEL     the vocal fader rides the song: up when the beat gets louder
 *             or the singer softer, down when not        (levelmatch.js)
 *   SPACE     reverb + a short echo, ducking under the singing (studio.js)
 *   MASTER    glue, loudness target, true-peak limiter   (studio.js)
 *
 * Missing modules are skipped gracefully: without studio.js you still get
 * compression + level matching; without levelmatch.js, one fixed balance.
 *
 * Entry point used by the Automix button:
 *     window.VocalVaultAutomix.process(window.VocalVaultState) -> AudioBuffer
 *
 * Optional settings on the state object:
 *     state.masterTargetLufs   loudness target, default -12
 */

(function () {

/**
 * 1. Measures peak and loudness of an AudioBuffer.
 *    rmsDb is the loudness of the SINGING only: quiet gaps between
 *    phrases are left out, otherwise they drag the average down and the
 *    vocal ends up far too loud. All channels are measured.
 */
function analyzeAudioBuffer(audioBuffer) {
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));

  const n = audioBuffer.length;
  const block = Math.max(1, Math.round(audioBuffer.sampleRate * 0.05));   // 50 ms blocks
  const blockPower = [];
  let peak = 0;

  for (let start = 0; start < n; start += block) {
    const end = Math.min(n, start + block);
    let sum = 0;
    for (const x of channels) {
      for (let i = start; i < end; i++) {
        const v = x[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
    }
    blockPower.push(sum / ((end - start) * channels.length));
  }

  // Singing = blocks within 30 dB of the loudest block (and not near-silent).
  const maxPower = Math.max(...blockPower, 1e-12);
  const gate = Math.max(maxPower * 1e-3, 1e-10);
  let sumActive = 0, active = 0;
  for (const p of blockPower) if (p >= gate) { sumActive += p; active++; }
  const meanPower = active ? sumActive / active : maxPower;

  const rms = Math.sqrt(meanPower);
  const peakDb = 20 * Math.log10(Math.max(peak, 0.00001));
  const rmsDb = 20 * Math.log10(Math.max(rms, 0.00001));

  return { peakDb, rmsDb, peak, rms };
}

/**
 * 2. Calculates mixing parameters from vocal + beat measurements.
 */
function calculateAutoMixParams(vocalBuffer, beatBuffer, metadata = {}) {
  const vocalStats = analyzeAudioBuffer(vocalBuffer);
  const beatStats = analyzeAudioBuffer(beatBuffer);

  // A. Auto High-Pass Cutoff (placed 25Hz below the vocal's lowest note)
  const lowestPitch = metadata.minPitchHz || 110;
  const hpfCutoff = Math.max(75, Math.min(150, lowestPitch - 25));

  // B. Auto Compressor Thresholds (calibrated to the singing's own level)
  const peakThresh = Math.max(-36, vocalStats.peakDb - 7);    // Clamps top 7dB spikes
  const levelerThresh = Math.max(-48, vocalStats.rmsDb - 3);  // Smooths average body

  // C. Fixed fallback balance (sits vocal ~2.5dB above beat loudness).
  //    Only used when levelmatch.js is missing; it cannot know what the
  //    compressors will do to the level, so the normal path measures the
  //    processed vocal instead.
  const targetVocalRmsDb = beatStats.rmsDb + 2.5;
  const requiredGainDb = targetVocalRmsDb - vocalStats.rmsDb;
  const vocalGainMultiplier = Math.pow(10, requiredGainDb / 20);

  return {
    hpfCutoff,
    peakThresh,
    levelerThresh,
    vocalGainMultiplier,
    vocalStats,
    beatStats
  };
}

/**
 * Vocal processing chain: high-pass -> peak catcher -> leveler.
 * Returns { input, output } so it can be wired to any source and target.
 */
function createVocalChain(audioCtx, mixParams, options) {
  // 1. High-Pass Filter (Low-end mud cleanup). Skipped when studio.js has already done it.
  const useHpf = !(options && options.highpass === false);
  const hpf = useHpf ? audioCtx.createBiquadFilter() : null;
  if (hpf) {
    hpf.type = 'highpass';
    hpf.frequency.value = mixParams.hpfCutoff;
  }

  // 2. Serial Compression - Stage 1 (Fast Peak Catcher)
  const peakComp = audioCtx.createDynamicsCompressor();
  peakComp.threshold.value = mixParams.peakThresh;
  peakComp.knee.value = 4;
  peakComp.ratio.value = 6;
  peakComp.attack.value = 0.005;  // 5ms
  peakComp.release.value = 0.050; // 50ms

  // 3. Serial Compression - Stage 2 (Smooth Leveler)
  const levelerComp = audioCtx.createDynamicsCompressor();
  levelerComp.threshold.value = mixParams.levelerThresh;
  levelerComp.knee.value = 12;
  levelerComp.ratio.value = 2.5;
  levelerComp.attack.value = 0.030;  // 30ms
  levelerComp.release.value = 0.200; // 200ms

  if (hpf) hpf.connect(peakComp);
  peakComp.connect(levelerComp);

  return { input: hpf || peakComp, output: levelerComp, hpf, peakComp, levelerComp };
}

/**
 * 3. Builds the full Web Audio graph (vocal chain + gain + beat + limiter).
 *    Kept for the fixed-balance fallback. `destination` defaults to the
 *    speakers; pass an OfflineAudioContext's destination to render.
 */
function createAutomatedMixGraph(audioCtx, vocalSource, beatSource, mixParams, destination) {
  const chain = createVocalChain(audioCtx, mixParams);

  // 4. Auto Gain Balancing Node
  const vocalGain = audioCtx.createGain();
  vocalGain.gain.value = mixParams.vocalGainMultiplier;

  // 5. Master Brickwall Limiter (Prevents clipping on export/playback)
  const masterLimiter = audioCtx.createDynamicsCompressor();
  masterLimiter.threshold.value = -0.5; // Ceiling at -0.5dB
  masterLimiter.knee.value = 0;
  masterLimiter.ratio.value = 20;
  masterLimiter.attack.value = 0.001;  // 1ms
  masterLimiter.release.value = 0.050; // 50ms

  // Vocal Signal Flow: Vocal -> HPF -> Peak Comp -> Leveler -> Gain Node
  vocalSource.connect(chain.input);
  chain.output.connect(vocalGain);

  // Combine Vocal and Beat into Master Limiter
  vocalGain.connect(masterLimiter);
  beatSource.connect(masterLimiter);

  masterLimiter.connect(destination || audioCtx.destination);

  return {
    hpfNode: chain.hpf,
    peakCompNode: chain.peakComp,
    levelerCompNode: chain.levelerComp,
    vocalGainNode: vocalGain,
    masterLimiterNode: masterLimiter
  };
}

// ------------------------------------------------------------
// Offline rendering helpers
// ------------------------------------------------------------

/** How much delay do the two compressors add? (Measured, so it holds in any browser.) */
async function measureChainLatency(sampleRate) {
  const length = Math.round(sampleRate * 0.3);
  const ctx = new OfflineAudioContext(1, length, sampleRate);
  const buf = ctx.createBuffer(1, length, sampleRate);
  const at = Math.round(sampleRate * 0.1);
  buf.getChannelData(0)[at] = 0.5;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  let node = src;
  for (let i = 0; i < 2; i++) {            // same two compressors, set to do nothing
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = 0; c.ratio.value = 1; c.knee.value = 0;
    node.connect(c);
    node = c;
  }
  node.connect(ctx.destination);
  src.start();

  const out = (await ctx.startRendering()).getChannelData(0);
  let peak = 0, where = at;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > peak) { peak = Math.abs(out[i]); where = i; }
  return Math.max(0, where - at);
}

/** Renders the vocal through the chain and returns a time-aligned AudioBuffer. */
async function renderVocalChain(vocalBuffer, mixParams, options) {
  const sr = vocalBuffer.sampleRate;
  const latency = await measureChainLatency(sr);
  const length = vocalBuffer.length + latency + Math.round(sr * 0.25);   // room for the release tail

  const ctx = new OfflineAudioContext(vocalBuffer.numberOfChannels, length, sr);
  const src = ctx.createBufferSource();
  src.buffer = vocalBuffer;

  const chain = createVocalChain(ctx, mixParams, options);
  src.connect(chain.input);
  chain.output.connect(ctx.destination);
  src.start();

  const rendered = await ctx.startRendering();

  // Drop the delay so the vocal lines up with the beat again.
  const out = new OfflineAudioContext(vocalBuffer.numberOfChannels, vocalBuffer.length, sr)
    .createBuffer(vocalBuffer.numberOfChannels, vocalBuffer.length, sr);
  for (let c = 0; c < out.numberOfChannels; c++) {
    out.copyToChannel(rendered.getChannelData(c).subarray(latency, latency + vocalBuffer.length), c);
  }
  return out;
}

/** Fixed-balance fallback: the original single-gain design, rendered offline. */
async function renderFixedMix(vocalBuffer, beatBuffer, offsetSec, mixParams) {
  const sr = beatBuffer.sampleRate;
  const length = Math.ceil(Math.max(beatBuffer.duration, offsetSec + vocalBuffer.duration) * sr);
  const ctx = new OfflineAudioContext(2, length, sr);

  const vocal = ctx.createBufferSource(); vocal.buffer = vocalBuffer;
  const beat = ctx.createBufferSource(); beat.buffer = beatBuffer;

  createAutomatedMixGraph(ctx, vocal, beat, mixParams);

  beat.start(0);
  if (offsetSec >= 0) vocal.start(offsetSec, 0);
  else vocal.start(0, -offsetSec);

  const rendered = await ctx.startRendering();

  // A compressor node is not a true brickwall: it can let peaks through.
  // Pull the whole mix down if it would clip (-1 dBFS ceiling).
  let peak = 0;
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    const d = rendered.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
  }
  const ceiling = Math.pow(10, -1 / 20);
  if (peak > ceiling) {
    const k = ceiling / peak;
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const d = rendered.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return rendered;
}

// ------------------------------------------------------------
// Entry point
// ------------------------------------------------------------

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 20));   // lets the page repaint between stages

function setStatus(text) {
  const el = typeof document !== "undefined" && document.getElementById("automix-status");
  if (el) el.textContent = text;
}

// A short, plain-language list of what was done, under the status line.
function showReport(lines) {
  if (typeof document === "undefined") return;
  const status = document.getElementById("automix-status");
  if (!status) return;

  let list = document.getElementById("automix-report");
  if (!list) {
    list = document.createElement("ul");
    list.id = "automix-report";
    list.style.cssText = "margin:12px 0 0;padding-left:20px;font-size:13px;line-height:1.7;opacity:.85";
    status.parentNode.insertBefore(list, status.nextSibling);
  }
  list.innerHTML = "";
  for (const line of lines) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
}

const channelsOf = (buffer) => {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
};

const signed = (v) => (v >= 0 ? "+" : "") + v.toFixed(1);

/**
 * Listen to the dry vocal (and the beat) and decide how much space it can take.
 * Rough / already-wet / noisy vocals get almost no reverb. Clean dry vocals get more.
 * Dense beats also push space down so the vocal stays clear.
 */
function measureSpaceBudget(placedChannels, beatChannels, sr, bpm) {

  const mono = placedChannels.length === 1
    ? placedChannels[0]
    : (() => {
        const n = placedChannels[0].length, o = new Float32Array(n);
        for (let c = 0; c < placedChannels.length; c++)
          for (let i = 0; i < n; i++) o[i] += placedChannels[c][i] / placedChannels.length;
        return o;
      })();

  const n = mono.length;
  const hop = Math.max(1, Math.round(0.02 * sr));
  const frames = Math.ceil(n / hop);
  const rms = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    let s = 0;
    const a = f * hop, b = Math.min(n, a + hop);
    for (let i = a; i < b; i++) s += mono[i] * mono[i];
    rms[f] = Math.sqrt(s / Math.max(1, b - a));
  }

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(frames * 0.10)] || 1e-6;
  const loud = sorted[Math.floor(frames * 0.90)] || floor * 10;
  const noiseDb = 20 * Math.log10(Math.max(floor, 1e-9));
  const loudDb = 20 * Math.log10(Math.max(loud, 1e-9));
  const gap = loudDb - noiseDb;   // how much headroom above the floor

  // How much energy lingers just after a loud phrase? High = already wet / roomy.
  let lingerSum = 0, lingerN = 0;
  for (let f = 2; f < frames - 2; f++) {
    if (rms[f - 1] > loud * 0.5 && rms[f] < loud * 0.2) {
      // look 80–160 ms after the drop
      const k = Math.min(frames - 1, f + Math.round(0.12 / 0.02));
      lingerSum += rms[k] / Math.max(floor, 1e-9);
      lingerN++;
    }
  }
  const linger = lingerN ? lingerSum / lingerN : 1;

  // Beat density in the vocal band (1–4 kHz proxy via overall RMS of beat)
  let beatMean = 0;
  if (beatChannels && beatChannels[0]) {
    const b = beatChannels[0];
    const step = Math.max(1, Math.floor(b.length / 2000));
    let s = 0, c = 0;
    for (let i = 0; i < b.length; i += step) { s += b[i] * b[i]; c++; }
    beatMean = Math.sqrt(s / Math.max(1, c));
  }
  const beatDb = 20 * Math.log10(Math.max(beatMean, 1e-9));
  const denseBeat = beatDb > -22;

  // Score 0 = needs to stay dry, 1 = can take normal space
  let dryness = 1;
  if (gap < 18) dryness -= 0.45;             // noisy floor
  else if (gap < 24) dryness -= 0.25;
  if (linger > 4) dryness -= 0.35;           // already rings after phrases
  else if (linger > 2.5) dryness -= 0.2;
  if (noiseDb > -40) dryness -= 0.2;         // absolute floor is high
  if (denseBeat) dryness -= 0.15;
  if (bpm > 140) dryness -= 0.1;
  dryness = Math.max(0, Math.min(1, dryness));

  // Map dryness → effect amounts (higher belowDb = quieter effect)
  const reverbBelowDb = Math.round(16 + (1 - dryness) * 14);   // 16 … 30
  const echoBelowDb = Math.round(20 + (1 - dryness) * 10);     // 20 … 30
  const reverbSecMax = 0.55 + dryness * 0.85;                  // 0.55 … 1.4
  const useDoubler = dryness > 0.4;
  const doublerBelowDb = Math.round(12 + (1 - dryness) * 8);
  const useRoom = dryness > 0.35;
  const roomBelowDb = Math.round(20 + (1 - dryness) * 10);
  const roomRt60 = 0.28 + dryness * 0.22;
  const midDuckDb = denseBeat ? 3.5 : 2.5;
  const duckDepth = 0.45 + (1 - dryness) * 0.2;
  const harmonyBelowDb = Math.round(9 + (1 - dryness) * 6);

  let reason;
  if (dryness < 0.35) {
    reason = `Listened to the vocal: it is already noisy or wet (noise floor ${noiseDb.toFixed(0)} dBFS, only ${gap.toFixed(0)} dB above the floor), so space is kept very small so it stays clear.`;
  } else if (dryness < 0.65) {
    reason = `Listened to the vocal: moderate room/noise in the take, so reverb and width are held back.`;
  } else {
    reason = `Listened to the vocal: relatively dry and clean, so a normal amount of space is safe.`;
  }
  if (denseBeat) reason += " The beat is dense in the mids, so the vocal is kept more forward.";

  return {
    dryness, reverbBelowDb, echoBelowDb, reverbSecMax,
    useDoubler, doublerBelowDb, useRoom, roomBelowDb, roomRt60,
    midDuckDb, duckDepth, harmonyBelowDb, reason,
    noiseDb, gapDb: gap
  };
}

async function processAutomix(state, options) {
  const opt = Object.assign({ polish: true, effects: true, master: true, beatEnhance: true, style: "universal", polishLevel: "radio" }, options || {});
  const vocal = state.tunedVocal || state.preparedVocal || state.vocalBuffer;   // corrected, else cleaned-up, else as recorded
  const beat = state.beatBuffer;
  const offset = state.vocalOffset || 0;

  if (!vocal || !beat) throw new Error("Both a vocal and a beat are needed.");

  const Levels = window.VocalVaultLevels;
  const Studio = window.VocalVaultStudio;
  const Presets = window.VocalVaultPresets;
  const recipe = Presets && Presets.resolve
    ? Presets.resolve(opt.style || "universal", opt.polishLevel || "radio")
    : null;

  const metadata = {};
  if (state.vocalPitch && state.vocalPitch.minMidi != null) {
    metadata.minPitchHz = 440 * Math.pow(2, (state.vocalPitch.minMidi - 69) / 12);
  }

  const first = calculateAutoMixParams(vocal, beat, metadata);

  // No level-matching module: fall back to one fixed balance.
  if (!Levels) return renderFixedMix(vocal, beat, offset, first);

  const lines = [];
  const polish = !!(Studio && opt.polish);

  if (recipe) {
    lines.push(`Style: ${recipe.styleLabel} · Polish: ${recipe.polishLabel} — ${recipe.blurb}`);
  }

  // 1. Vocal polish: high-pass, de-ess, auto-EQ
  let working = vocal;
  let params = first;
  if (polish) {
    setStatus("Cleaning up and balancing the vocal…");
    await nextFrame();
    const prepOpts = { highPassHz: first.hpfCutoff };
    if (recipe) prepOpts.eq = recipe.eq;
    const prepared = Studio.prepareVocal(vocal, prepOpts);
    lines.push(...prepared.report);
    working = prepared.buffer;
    // compressor settings follow the vocal as it is NOW (after the de-esser and EQ)
    params = Object.assign(calculateAutoMixParams(working, beat, metadata), { hpfCutoff: first.hpfCutoff });
  } else {
    lines.push(`Cleaned rumble below ${Math.round(first.hpfCutoff)} Hz.`);
  }

  // Style/polish: tighten or loosen compression thresholds
  if (recipe && recipe.compressTightenDb) {
    const t = recipe.compressTightenDb;
    if (typeof params.peakThresh === "number") params.peakThresh -= t;
    if (typeof params.levelerThresh === "number") params.levelerThresh -= t * 0.55;
  }

  // 2. Compression (your two-stage chain), then warmth
  setStatus("Evening out the vocal…");
  await nextFrame();
  let finished = await renderVocalChain(working, params, { highpass: !polish });
  lines.push("Evened out loud and quiet words with two-stage compression.");
  if (polish) {
    const warmOpts = recipe ? { sat: recipe.sat } : undefined;
    const warm = Studio.finishVocal(finished, warmOpts);
    finished = warm.buffer;
    lines.push(...warm.report);
  }

  // 3. Level matching: measure the finished vocal against the beat
  setStatus("Balancing the vocal against the beat…");
  await nextFrame();
  const engine = Levels.engine;
  const sr = beat.sampleRate;
  let levelOptions = (options && options.levels) || (Levels.readOptions && Levels.readOptions()) || undefined;
  if (recipe) {
    levelOptions = Object.assign({}, levelOptions || {}, {
      vocalAboveBeatDb: recipe.vocalAboveBeatDb
    });
  }
  const vocalChannels = channelsOf(finished).map((c) => engine.resample(c, finished.sampleRate, sr));
  let beatChannels = channelsOf(beat);

  // Auto beat enhance: only acts when kick/low end is thin vs the mids
  if (Studio && opt.beatEnhance !== false && Studio.engine && Studio.engine.enhanceBeat) {
    setStatus("Balancing the beat (kick, chords, hats)…");
    await nextFrame();
    const enhOpts = recipe ? { strength: recipe.beatEnhanceStrength } : undefined;
    const enh = Studio.engine.enhanceBeat(beatChannels, sr, enhOpts);
    beatChannels = enh.channels;
    lines.push(...enh.report);
    state.beatEnhance = enh.analysis;
  }

  const plan = engine.plan(vocalChannels, beatChannels, sr, offset, levelOptions);

  if (plan.warning) lines.push(plan.warning);
  else if (plan.mode === "off") lines.push("Left the vocal and beat levels as they are.");
  else {
    lines.push(`Set the voice ${signed(plan.options.vocalAboveBeatDb)} LU against the beat` +
      (plan.mode === "dynamic" ? ` and rides it up to ±${plan.options.rangeDb} dB as the music changes (${plan.events.length} moves).` : "."));
  }

  // Without the studio stages, mix the levelled vocal and finish (the older path).
  if (!Studio || (!opt.effects && !opt.master)) {
    const out = await Levels.process(state, levelOptions, finished);
    state.autoMixParams = params;
    state.mixReport = { lines };
    showReport(lines);
    return out;
  }

  // 4. Space: reverb + echo, placed using the vocal's own fader.
  // Amounts are NOT fixed — they come from listening to how dry/rough the
  // vocal already is and how dense the beat is.
  const Fx = window.VocalVaultFxPlus && window.VocalVaultFxPlus.engine;
  let fx = null, stems = [], beatForMix = beatChannels;
  let space = null;
  if (opt.effects) {
    setStatus("Adding space…");
    await nextFrame();
    const placed = engine.placeVocal(vocalChannels, sr, plan, Math.ceil(plan.totalSec * sr));

    // ---- Listen: how much space can this vocal take before it gets rough? ----
    space = measureSpaceBudget(placed, beatChannels, sr, state.beatBpm);
    if (recipe) {
      space = Object.assign({}, space);
      space.reverbBelowDb = Math.max(8, (space.reverbBelowDb || 16) + recipe.reverbBelowAdd);
      space.echoBelowDb = Math.max(10, (space.echoBelowDb || 22) + recipe.echoBelowAdd);
      space.reverbSecMax = Math.max(0.35, (space.reverbSecMax || 1.4) * recipe.reverbScale);
      space.midDuckDb = Math.max(0, (space.midDuckDb || 0) * recipe.midDuckScale);
      if (recipe.preferDoubler === true) space.useDoubler = true;
      if (recipe.preferDoubler === false) space.useDoubler = false;
      if (recipe.forceMinimalFx) {
        space.useDoubler = false;
        space.useRoom = false;
        space.reverbBelowDb = Math.max(space.reverbBelowDb, 24);
        space.echoBelowDb = Math.max(space.echoBelowDb, 26);
        space.reverbSecMax = Math.min(space.reverbSecMax, 0.7);
      }
    }
    lines.push(space.reason);

    // the echo repeats on a musical fraction of the beat when the tempo is known
    const synced = Fx ? Fx.echoTime(state.beatBpm) : null;
    // and the reverb tail shortens with the tempo: long tails smear fast music and make it feel slow
    const tail = Fx ? Fx.reverbTime(state.beatBpm) : null;
    const fxOptions = {
      reverbBelowDb: space.reverbBelowDb,
      echoBelowDb: space.echoBelowDb,
      duckDepth: space.duckDepth
    };
    if (synced) fxOptions.echoSec = synced.sec;
    // Cap reverb length when the vocal is already wet/rough
    if (tail) fxOptions.reverbSec = Math.min(tail, space.reverbSecMax);
    else fxOptions.reverbSec = space.reverbSecMax;

    if (space.reverbBelowDb >= 28) {
      // Essentially dry: skip reverb, keep only a tiny echo if any
      fxOptions.reverb = false;
    }

    fx = await Studio.renderFx(placed, sr, fxOptions);
    if (synced) {
      const echoDb = space.echoBelowDb;
      fx.report = fx.report.map((l) => l.startsWith("Added a short echo")
        ? `Added an echo timed to ${synced.label} of the beat (${Math.round(synced.sec * 1000)} ms), ${echoDb} dB below the voice, dipping out of the way while you sing.`
        : l);
    }
    // Rewrite reverb report line with the adaptive level
    fx.report = fx.report.map((l) => {
      if (l.startsWith("Added a ") && l.includes("plate-style reverb")) {
        return `Added a ${Number(fxOptions.reverbSec).toFixed(1)} second plate-style reverb for depth, ${space.reverbBelowDb} dB below the voice, dipping out of the way while you sing.`;
      }
      return l;
    });
    if (space.reverbBelowDb >= 28) {
      fx.report = fx.report.filter((l) => !l.includes("plate-style reverb"));
      fx.report.unshift("Kept the vocal dry: this take is already wet or noisy, so reverb would make it rougher.");
    }
    lines.push(...fx.report);

    if (Fx) {
      setStatus("Widening the voice and making room in the beat…");
      await nextFrame();
      // optional: a higher harmony layer, built from the finished vocal and kept inside the key
      const degrees = state.harmonyDegrees || 0;
      const Tune = window.VocalVaultTune;
      if (degrees && Tune && Tune.harmonizeVocal) {
        const keyOpts = state.tuneOptions || (state.beatKey && state.beatKey.key
          ? { rootPc: Tune.noteNames.indexOf(state.beatKey.key), scale: String(state.beatKey.scale).toLowerCase(), refCents: 0 } : null);
        if (keyOpts) {
          setStatus("Building the harmony…");
          await nextFrame();
          try {
            const h = await Tune.harmonizeVocal(vocalChannels, sr, Object.assign({}, keyOpts, { degrees }), (f) => setStatus(`Building the harmony… ${Math.round(f * 100)}%`));
            const hPlaced = engine.placeVocal(h.audio.harmony, sr, plan, Math.ceil(plan.totalSec * sr));
            const stem = Fx.harmonyStem(hPlaced, sr, { belowDb: space.harmonyBelowDb });
            stems.push(stem.channels);
            const names = { 2: "a third", 4: "a fifth", 7: "an octave" };
            lines.push(`Added a harmony ${names[degrees] || "above"} above the lead, in the beat's key, ${stem.belowDb} dB below the voice.`);
          } catch (error) {
            console.error(error);
            lines.push("Skipped the harmony: it could not be built for this vocal.");
          }
        } else {
          lines.push("Skipped the harmony: the beat's key is not known yet.");
        }
      }

      // Doubler only when the vocal is clean enough to take width
      if (space.useDoubler) {
        const dbl = Fx.doubler(placed, sr, { belowDb: space.doublerBelowDb });
        stems.push(dbl.channels);
        lines.push(`Added a subtle double (two copies a few cents apart, ${dbl.belowDb} dB below the voice) for width.`);
      } else {
        lines.push("Skipped the double: the vocal is already thick or noisy, so width would blur it.");
      }

      const dip = Fx.duckBeatMid(beatChannels, Fx.toMono(placed), sr, { depthDb: space.midDuckDb });
      beatForMix = dip.channels;
      lines.push(`Dipped the beat's mids by up to ${Number(dip.depthDb).toFixed(1)} dB around 2 kHz while you sing, so the voice sits in the beat instead of on top of it. This dip leaves the low end alone.`);
    }
  }

  // 5. Mix
  setStatus("Mixing…");
  await nextFrame();
  const mixed = engine.mix(vocalChannels, beatForMix, sr, plan, {
    extras: (fx ? [fx.channels] : []).concat(stems),
    tailSec: fx ? fx.tailSec : 0,
    skipTrim: true
  });
  let channels = mixed.channels;

  // One small room around the whole mix — only when the vocal can take it.
  if (Fx && opt.effects && space && space.useRoom) {
    setStatus("Gluing the voice and beat together…");
    await nextFrame();
    const rm = Fx.room(channels, sr, { rt60: space.roomRt60, belowDb: space.roomBelowDb });
    for (let c = 0; c < channels.length; c++) {
      const w = rm.channels[c] || rm.channels[0], x = channels[c];
      for (let i = 0; i < x.length && i < w.length; i++) x[i] += w[i];
    }
    lines.push(`Put a little of one small room (${rm.rt60.toFixed(2)} s, ${rm.belowDb} dB below the mix) around both the voice and the beat, so they sound like they were recorded in the same space.`);
  } else if (Fx && opt.effects && space && !space.useRoom) {
    lines.push("Skipped the shared room: the vocal needs to stay dry and forward.");
  }

  // 6. Master
  let masterInfo = null;
  if (opt.master) {
    setStatus("Mastering…");
    await nextFrame();
    const target = typeof state.masterTargetLufs === "number" ? state.masterTargetLufs : -12;
    const m = Studio.master(channels, sr, { targetLufs: target });
    channels = m.channels;
    masterInfo = m.report;
    lines.push(`Mastered to ${masterInfo.outputLufs.toFixed(1)} LUFS (was ${masterInfo.inputLufs.toFixed(1)}), true peak ${masterInfo.truePeakDb.toFixed(1)} dBTP` +
      (masterInfo.limiterMaxDb >= 0.5 ? `, limiter working up to ${masterInfo.limiterMaxDb.toFixed(1)} dB.` : ", limiter barely needed."));
    if (masterInfo.outputLufs < target - 0.6) {
      lines.push(`Stopped ${(target - masterInfo.outputLufs).toFixed(1)} LU short of the ${target} LUFS target: getting there would take more than 8 dB of limiting on this track, which would squash the drums. Choose a quieter target for a more open sound.`);
    }
  } else {
    // safety: never hand back a mix that clips
    let peak = 0;
    for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    if (peak > 0.707) { const k = 0.707 / peak; for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= k; }
  }

  // Always end on the beat's exact length. FX are rendered with a short tail so
  // reverb doesn't click off; we then trim so 2:09 stays 2:09.
  const targetLen = beat.length;
  if (channels[0].length !== targetLen) {
    const trimmed = [new Float32Array(targetLen), new Float32Array(targetLen)];
    const copyLen = Math.min(targetLen, channels[0].length);
    const fadeSamples = Math.min(Math.round(0.08 * sr), copyLen);
    for (let c = 0; c < 2; c++) {
      const src = channels[c] || channels[0];
      for (let i = 0; i < copyLen; i++) trimmed[c][i] = src[i];
      // fade only when we are cutting a longer buffer
      if (src.length > targetLen) {
        for (let i = 0; i < fadeSamples; i++) {
          trimmed[c][targetLen - fadeSamples + i] *= (fadeSamples - i) / fadeSamples;
        }
      }
    }
    channels = trimmed;
  }

  // Soft floor: pull residual FX hiss/static in near-silence down so the
  // final product doesn't sound grainy between phrases.
  {
    let peak = 0;
    for (const ch of channels) for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]); if (a > peak) peak = a;
    }
    const thr = peak * 0.0035;
    const floorG = 0.25;
    if (peak > 1e-6) {
      for (const ch of channels) {
        for (let i = 0; i < ch.length; i++) {
          const a = Math.abs(ch[i]);
          if (a < thr && a > 0) {
            const t = a / thr;
            ch[i] *= floorG + (1 - floorG) * t * t;
          }
        }
      }
    }
  }

  const out = new AudioBuffer({ numberOfChannels: 2, length: targetLen, sampleRate: sr });
  out.copyToChannel(channels[0], 0);
  out.copyToChannel(channels[1], 1);

  state.autoMixParams = params;
  state.levelPlan = plan;
  state.mixRecipe = recipe;
  state.mixReport = { lines, master: masterInfo, polish: polish, recipe: recipe };
  window.dispatchEvent(new Event("vv-levels-updated"));
  showReport(lines);

  return out;
}

window.VocalVaultAutomix = {
  process: processAutomix,
  analyzeAudioBuffer,
  calculateAutoMixParams,
  createVocalChain,
  createAutomatedMixGraph,
  renderVocalChain,
  measureChainLatency
};

})();