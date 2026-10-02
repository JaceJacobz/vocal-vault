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

async function processAutomix(state, options) {
  const opt = Object.assign({ polish: true, effects: true, master: true }, options || {});
  const vocal = state.tunedVocal || state.vocalBuffer;   // corrected vocal when there is one
  const beat = state.beatBuffer;
  const offset = state.vocalOffset || 0;

  if (!vocal || !beat) throw new Error("Both a vocal and a beat are needed.");

  const Levels = window.VocalVaultLevels;
  const Studio = window.VocalVaultStudio;

  const metadata = {};
  if (state.vocalPitch && state.vocalPitch.minMidi != null) {
    metadata.minPitchHz = 440 * Math.pow(2, (state.vocalPitch.minMidi - 69) / 12);
  }

  const first = calculateAutoMixParams(vocal, beat, metadata);

  // No level-matching module: fall back to one fixed balance.
  if (!Levels) return renderFixedMix(vocal, beat, offset, first);

  const lines = [];
  const polish = !!(Studio && opt.polish);

  // 1. Vocal polish: high-pass, de-ess, auto-EQ
  let working = vocal;
  let params = first;
  if (polish) {
    setStatus("Cleaning up and balancing the vocal…");
    await nextFrame();
    const prepared = Studio.prepareVocal(vocal, { highPassHz: first.hpfCutoff });
    lines.push(...prepared.report);
    working = prepared.buffer;
    // compressor settings follow the vocal as it is NOW (after the de-esser and EQ)
    params = Object.assign(calculateAutoMixParams(working, beat, metadata), { hpfCutoff: first.hpfCutoff });
  } else {
    lines.push(`Cleaned rumble below ${Math.round(first.hpfCutoff)} Hz.`);
  }

  // 2. Compression (your two-stage chain), then warmth
  setStatus("Evening out the vocal…");
  await nextFrame();
  let finished = await renderVocalChain(working, params, { highpass: !polish });
  lines.push("Evened out loud and quiet words with two-stage compression.");
  if (polish) {
    const warm = Studio.finishVocal(finished);
    finished = warm.buffer;
    lines.push(...warm.report);
  }

  // 3. Level matching: measure the finished vocal against the beat
  setStatus("Balancing the vocal against the beat…");
  await nextFrame();
  const engine = Levels.engine;
  const sr = beat.sampleRate;
  const levelOptions = (options && options.levels) || (Levels.readOptions && Levels.readOptions()) || undefined;
  const vocalChannels = channelsOf(finished).map((c) => engine.resample(c, finished.sampleRate, sr));
  const beatChannels = channelsOf(beat);
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

  // 4. Space: reverb + echo, placed using the vocal's own fader
  let fx = null;
  if (opt.effects) {
    setStatus("Adding space…");
    await nextFrame();
    const placed = engine.placeVocal(vocalChannels, sr, plan, Math.ceil(plan.totalSec * sr));
    fx = await Studio.renderFx(placed, sr);
    lines.push(...fx.report);
  }

  // 5. Mix
  setStatus("Mixing…");
  await nextFrame();
  const mixed = engine.mix(vocalChannels, beatChannels, sr, plan, {
    extras: fx ? [fx.channels] : [],
    tailSec: fx ? fx.tailSec : 0,
    skipTrim: true
  });
  let channels = mixed.channels;

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
  } else {
    // safety: never hand back a mix that clips
    let peak = 0;
    for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    if (peak > 0.707) { const k = 0.707 / peak; for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= k; }
  }

  const out = new AudioBuffer({ numberOfChannels: 2, length: channels[0].length, sampleRate: sr });
  out.copyToChannel(channels[0], 0);
  out.copyToChannel(channels[1], 1);

  state.autoMixParams = params;
  state.levelPlan = plan;
  state.mixReport = { lines, master: masterInfo, polish: polish };
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