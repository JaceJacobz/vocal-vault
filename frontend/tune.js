/* =========================================================
   VOCAL VAULT — STEP 4: PITCH CORRECTION (UI)
   Needs pitchcorrect.js (window.VocalVaultTune) and the shared state
   that script.js exposes as window.VocalVaultState.
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {

    const $ = (id) => document.getElementById(id);

    const section = $("tune-section");
    const continueButton = $("continue-tune-button");
    const rootSelect = $("tune-root");
    const scaleSelect = $("tune-scale");
    const keyNote = $("tune-key-note");
    const refValue = $("tune-ref");
    const refNote = $("tune-ref-note");
    const strengthSlider = $("tune-strength");
    const retuneSlider = $("tune-retune");
    const flattenSlider = $("tune-flatten");
    const testBox = $("tune-test");
    const runButton = $("tune-run-button");
    const statusLine = $("tune-status");
    const results = $("tune-results");
    const statsBody = $("tune-stats-body");
    const resultNote = $("tune-result-note");
    const canvas = $("tune-contour");
    const scrollSlider = $("tune-scroll");
    const playButtons = document.querySelectorAll("[data-tune-play]");
    const stopButton = $("tune-stop");
    const downloadLink = $("tune-download");

    if (!section || !window.VocalVaultTune) return;

    const NOTE_NAMES = window.VocalVaultTune.noteNames;
    const S = window.VocalVaultState;

    let beatTuningCents = 0;
    let lastResult = null;
    let audioBuffers = {};          // original / detuned / tuned as AudioBuffers
    let running = false;

    NOTE_NAMES.forEach((name, i) => {
        const option = document.createElement("option");
        option.value = i;
        option.textContent = name;
        rootSelect.appendChild(option);
    });

    // -----------------------------------------------------
    // Slider read-outs
    // -----------------------------------------------------

    function bindReadout(slider, outputId, format) {
        const out = $(outputId);
        const update = () => { out.textContent = format(parseFloat(slider.value)); };
        slider.addEventListener("input", update);
        update();
    }

    bindReadout(strengthSlider, "tune-strength-value", v => `${Math.round(v)}%`);
    bindReadout(retuneSlider, "tune-retune-value", v => (v === 0 ? "Instant" : `${Math.round(v)} ms`));
    bindReadout(flattenSlider, "tune-flatten-value", v => `${Math.round(v)}%`);

    // -----------------------------------------------------
    // Open the step
    // -----------------------------------------------------

    continueButton.addEventListener("click", () => {

        section.classList.remove("hidden");
        section.scrollIntoView({ behavior: "smooth", block: "start" });

        const key = S && S.beatKey;

        if (key && key.key) {
            rootSelect.value = String(NOTE_NAMES.indexOf(key.key));
            scaleSelect.value = key.scale.toLowerCase();
            keyNote.textContent = `Detected from the beat · ${Math.round(key.confidence * 100)}% confidence`;
        } else {
            keyNote.textContent = "Key not detected yet. Choose it by hand.";
        }

        // How far the beat's tuning is from A = 440 Hz.
        try {
            const t = window.VocalVaultTune.estimateBeatTuning(S.beatBuffer);
            if (t.strength >= 0.35) {
                beatTuningCents = t.cents;
                refValue.textContent = `${t.cents >= 0 ? "+" : ""}${t.cents.toFixed(0)} cents`;
                refNote.textContent = "The vocal is tuned to the beat, not to A = 440";
            } else {
                beatTuningCents = 0;
                refValue.textContent = "A = 440";
                refNote.textContent = "Beat tuning unclear, using standard";
            }
        } catch (error) {
            console.error(error);
            beatTuningCents = 0;
            refValue.textContent = "A = 440";
            refNote.textContent = "Could not measure the beat tuning";
        }
    });

    // -----------------------------------------------------
    // Run
    // -----------------------------------------------------

    runButton.addEventListener("click", async () => {

        if (running || !S || !S.vocalBuffer) return;

        running = true;
        runButton.disabled = true;
        stopPitchPlayback();
        statusLine.textContent = "Starting…";

        const vocal = S.vocalBuffer;
        const channels = [];
        for (let c = 0; c < vocal.numberOfChannels; c++) channels.push(vocal.getChannelData(c));

        const options = {
            rootPc: parseInt(rootSelect.value, 10),
            scale: scaleSelect.value,
            refCents: beatTuningCents,
            strength: parseFloat(strengthSlider.value) / 100,
            retuneMs: parseFloat(retuneSlider.value),
            flatten: parseFloat(flattenSlider.value) / 100,
            testDetune: testBox.checked
        };

        try {

            const result = await window.VocalVaultTune.tuneVocal(
                channels, vocal.sampleRate, options,
                (fraction, label) => {
                    statusLine.textContent = `${label}… ${Math.round(fraction * 100)}%`;
                }
            );

            lastResult = result;
            buildBuffers(result, vocal);
            showResults(result);
            statusLine.textContent = "";

        } catch (error) {

            console.error(error);
            statusLine.textContent = "Pitch correction failed. See the console for details.";

        } finally {

            running = false;
            runButton.disabled = false;

        }
    });

    function buildBuffers(result, vocal) {

        const ctx = S.audioContext;
        audioBuffers = { original: vocal };

        for (const name of ["detuned", "tuned"]) {

            const data = result.audio[name];
            if (!data) continue;

            const buffer = ctx.createBuffer(data.length, data[0].length, vocal.sampleRate);
            data.forEach((channel, c) => buffer.copyToChannel(channel, c));
            audioBuffers[name] = buffer;
        }

        // Hand the corrected vocal to the mix stage (level matching, automix).
        S.tunedVocal = audioBuffers.tuned || null;

        // Download link for the tuned vocal
        if (downloadLink.dataset.url) URL.revokeObjectURL(downloadLink.dataset.url);
        const url = URL.createObjectURL(toWav(result.audio.tuned, vocal.sampleRate));
        downloadLink.href = url;
        downloadLink.dataset.url = url;
    }

    // -----------------------------------------------------
    // Results
    // -----------------------------------------------------

    function showResults(result) {

        results.classList.remove("hidden");

        const rows = [["original", "Original"]];
        if (result.stats.detuned) rows.push(["detuned", "Detuned (test)"]);
        rows.push(["tuned", "Corrected"]);

        statsBody.innerHTML = "";

        for (const [key, label] of rows) {
            const s = result.stats[key];
            const tr = document.createElement("tr");
            if (key === "tuned") tr.className = "is-result";
            tr.innerHTML =
                `<th scope="row">${label}</th>` +
                `<td>${s.inKeyPct.toFixed(1)}%</td>` +
                `<td>${s.medianCents.toFixed(1)}</td>` +
                `<td>${s.within25Pct.toFixed(1)}%</td>` +
                `<td>${s.notesOutOfKey} / ${s.notes}</td>`;
            statsBody.appendChild(tr);
        }

        document.querySelector(".swatch-detuned").classList.toggle("hidden", !result.audio.detuned);
        $("tune-legend-detuned").classList.toggle("hidden", !result.audio.detuned);

        // The "Detuned Test" button only exists when test mode made a detuned version.
        const detunedButton = $("mode-detuned-btn");
        if (detunedButton) detunedButton.classList.toggle("hidden", !result.audio.detuned);

        // Don't stay stuck on a version that this run did not produce.
        if (pitchMode === "detuned" && !audioBuffers.detuned) switchPitchMode("tuned");

        // Warn when the vocal clearly belongs to a different key than the one chosen
        const warning = $("tune-key-warning");
        const fit = result.keyFit;
        warning.classList.add("hidden");

        if (fit && fit.selectedPct < fit.bestPct - 0.05) {
            const names = fit.best.map(k => `${NOTE_NAMES[k.root]} ${k.scale}`).join(" / ");
            const chosen = `${NOTE_NAMES[result.options.rootPc]} ${result.options.scale}`;
            warning.textContent =
                `Check the key: ${Math.round(fit.bestPct * 100)}% of this vocal's notes fit ${names}, ` +
                `but only ${Math.round(fit.selectedPct * 100)}% fit ${chosen}. ` +
                `If the beat's key was detected wrongly, pick the right one above and run again, ` +
                `otherwise notes that were right will be moved.`;
            warning.classList.remove("hidden");
        }

        const t = result.stats.tuned;
        let text = result.corrected === 0
            ? "No note was more than 15 cents off the scale, so only fine tightening was applied. "
            : `${result.corrected} of ${result.notes} notes were more than 15 cents off and were pulled onto the scale. `;

        if (result.detuneEvents) {
            const wrong = result.detuneEvents.filter(e => e.kind === "wrong-note").length;
            text += `Test mode detuned ${result.detuneEvents.length} notes ` +
                `(${wrong} pushed a semitone out of key). ` +
                `A note pushed more than about 50 cents, or a wrong note sitting between two scale notes, ` +
                `is snapped to the nearest valid note, which is not always the one the singer meant.`;
        }

        resultNote.textContent = text;

        const first = result.contours.original.findIndex(v => !isNaN(v));
        const hopSec = result.hop / result.sampleRate;
        const duration = result.contours.original.length * hopSec;
        scrollSlider.max = String(Math.max(0, duration - WINDOW_SECONDS).toFixed(2));
        scrollSlider.value = String(Math.max(0, first * hopSec - 0.5).toFixed(2));

        drawContour();
    }

    // -----------------------------------------------------
    // Pitch contour chart
    // -----------------------------------------------------

    const WINDOW_SECONDS = 12;

    scrollSlider.addEventListener("input", drawContour);
    window.addEventListener("resize", () => { if (lastResult) drawContour(); });

    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function drawContour() {

        if (!lastResult) return;

        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width) return;

        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);

        const g = canvas.getContext("2d");
        g.scale(dpr, dpr);
        g.clearRect(0, 0, width, height);

        const hopSec = lastResult.hop / lastResult.sampleRate;
        const t0 = parseFloat(scrollSlider.value) || 0;
        const k0 = Math.floor(t0 / hopSec);
        const k1 = Math.min(lastResult.contours.original.length, Math.floor((t0 + WINDOW_SECONDS) / hopSec));

        const series = [
            ["original", "#8a8a94"],
            ["detuned", cssVar("--vocal") || "#0099cc"],
            ["tuned", cssVar("--accent") || "#ff5433"]
        ].filter(([name]) => lastResult.contours[name]);

        // Vertical range: what is on screen, padded
        let lo = Infinity, hi = -Infinity;
        for (const [name] of series) {
            const c = lastResult.contours[name];
            for (let k = k0; k < k1; k++) if (!isNaN(c[k])) { lo = Math.min(lo, c[k]); hi = Math.max(hi, c[k]); }
        }
        if (!isFinite(lo)) { lo = 55; hi = 70; }
        lo = Math.floor(lo - 1.5);
        hi = Math.ceil(hi + 1.5);

        const left = 34, pad = 6;
        const y = (m) => pad + (1 - (m - lo) / (hi - lo)) * (height - 2 * pad);
        const x = (k) => left + ((k - k0) / Math.max(1, k1 - k0)) * (width - left - pad);

        // Scale notes as guide lines
        const o = lastResult.options;
        const ref = o.refCents / 100;
        const degrees = o.scale === "minor" ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
        g.font = "11px system-ui, sans-serif";
        g.textBaseline = "middle";

        for (let m = lo; m <= hi; m++) {
            const pc = ((m % 12) + 12) % 12;
            if (!degrees.some(d => (o.rootPc + d) % 12 === pc)) continue;
            const yy = y(m + ref);
            g.strokeStyle = (pc === o.rootPc) ? "rgba(255,84,51,0.45)" : "rgba(255,255,255,0.10)";
            g.lineWidth = 1;
            g.beginPath(); g.moveTo(left, yy); g.lineTo(width - pad, yy); g.stroke();
            g.fillStyle = "#9a9aa3";
            g.fillText(NOTE_NAMES[pc], 4, yy);
        }

        // Contours
        for (const [name, colour] of series) {
            const c = lastResult.contours[name];
            g.strokeStyle = colour;
            g.lineWidth = name === "tuned" ? 2 : 1.25;
            g.globalAlpha = name === "tuned" ? 1 : 0.8;
            g.beginPath();
            let pen = false;
            for (let k = k0; k < k1; k++) {
                if (isNaN(c[k])) { pen = false; continue; }
                if (pen) g.lineTo(x(k), y(c[k])); else { g.moveTo(x(k), y(c[k])); pen = true; }
            }
            g.stroke();
        }
        g.globalAlpha = 1;
    }

// =====================================================
// ENHANCED PITCH CORRECTION TRANSPORT
// =====================================================
//
// Features:
// - Play / Pause
// - Stop
// - Original / Corrected A-B switching
// - -5 second rewind
// - -2 second rewind
// - +5 second forward
// - 4-second loop
// - Position display
// - Keeps vocal aligned to the beat
// =====================================================


const pitchPlayBtn =
    $("pitch-play-btn");

const pitchStopBtn =
    $("pitch-stop-btn");

const modeCorrectedBtn =
    $("mode-corrected-btn");

const modeOriginalBtn =
    $("mode-original-btn");

const modeDetunedBtn =
    $("mode-detuned-btn");

const rewind5sBtn =
    $("pitch-rewind-5s");

const rewind2sBtn =
    $("pitch-rewind-2s");

const forward5sBtn =
    $("pitch-forward-5s");

const pitchLoopToggle =
    $("pitch-loop-toggle");

const pitchPositionDisplay =
    $("pitch-position");


let pitchNodes = [];

let pitchPlaying = false;

let pitchMode = "tuned";

let pitchPosition = 0;

let pitchStartedAt = 0;

let pitchStartPosition = 0;

let pitchAnimationFrame = null;

let pitchLoopStart = 0;


// =====================================================
// FORMAT TIME
// =====================================================

function formatPitchTime(seconds) {

    seconds = Math.max(
        0,
        seconds || 0
    );

    const minutes =
        Math.floor(seconds / 60);

    const secs =
        Math.floor(seconds % 60)
            .toString()
            .padStart(2, "0");

    return `${minutes}:${secs}`;
}


// =====================================================
// UPDATE POSITION DISPLAY
// =====================================================

function updatePitchPosition(time) {

    pitchPosition =
        Math.max(
            0,
            time || 0
        );

    if (pitchPositionDisplay) {

        pitchPositionDisplay.textContent =
            formatPitchTime(pitchPosition);

    }

    // Keep the pitch contour view following playback.
    if (lastResult && scrollSlider) {

        const maxScroll =
            parseFloat(scrollSlider.max) || 0;

        const desired =
            Math.min(
                Math.max(
                    0,
                    pitchPosition - WINDOW_SECONDS / 2
                ),
                maxScroll
            );

        scrollSlider.value =
            String(desired);

        drawContour();
    }
}


// =====================================================
// CURRENT PLAYBACK POSITION
// =====================================================

function getPitchCurrentPosition() {

    if (!pitchPlaying) {
        return pitchPosition;
    }

    const ctx =
        S.audioContext;

    return Math.max(
        0,
        pitchStartPosition +
        (ctx.currentTime - pitchStartedAt)
    );
}


// =====================================================
// STOP AUDIO NODES
// =====================================================

function stopPitchNodes() {

    pitchNodes.forEach(node => {

        try {
            node.onended = null;
            node.stop();
        } catch (error) {
            // Already stopped.
        }

    });

    pitchNodes = [];
}


// =====================================================
// UPDATE PLAY BUTTON
// =====================================================

function updatePitchPlayButton() {

    if (!pitchPlayBtn) return;

    pitchPlayBtn.textContent =
        pitchPlaying
            ? "⏸ Pause"
            : "▶ Play";
}


// =====================================================
// STOP PLAYBACK
// =====================================================

function stopPitchPlayback() {

    stopPitchNodes();

    pitchPlaying = false;

    cancelAnimationFrame(
        pitchAnimationFrame
    );

    updatePitchPlayButton();

}


// =====================================================
// START PLAYBACK
// =====================================================

function startPitchPlayback(
    startPosition = pitchPosition
) {

    if (
        !S.audioContext ||
        !S.beatBuffer ||
        !audioBuffers[pitchMode]
    ) {
        return;
    }

    const ctx =
        S.audioContext;

    if (ctx.state === "suspended") {
        ctx.resume();
    }

    stopPitchNodes();

    const beat =
        S.beatBuffer;

    const vocal =
        audioBuffers[pitchMode];

    const duration =
        beat.duration;

    // Clamp position.
    startPosition =
        Math.max(
            0,
            Math.min(
                duration - 0.01,
                startPosition
            )
        );

    const now =
        ctx.currentTime + 0.05;

    pitchStartedAt =
        now;

    pitchStartPosition =
        startPosition;

    pitchPosition =
        startPosition;


    // -----------------------------------------------------
    // BEAT
    // -----------------------------------------------------

    const beatSource =
        ctx.createBufferSource();

    beatSource.buffer =
        beat;

    const beatGain =
        ctx.createGain();

    beatGain.gain.value =
        0.75;

    beatSource
        .connect(beatGain)
        .connect(ctx.destination);


    // -----------------------------------------------------
    // VOCAL
    // -----------------------------------------------------

    const vocalSource =
        ctx.createBufferSource();

    vocalSource.buffer =
        vocal;

    vocalSource.connect(
        ctx.destination
    );


    // -----------------------------------------------------
    // ALIGN VOCAL WITH BEAT
    // -----------------------------------------------------

    const vocalTime =
        startPosition -
        S.vocalOffset;


    // Beat begins immediately at
    // the selected beat position.

    beatSource.start(
        now,
        startPosition
    );


    // If the vocal should have already
    // started before the selected beat
    // position, compensate for it.

    if (vocalTime >= 0) {

        vocalSource.start(
            now,
            vocalTime
        );

    } else {

        vocalSource.start(
            now + (-vocalTime),
            0
        );

    }


    // -----------------------------------------------------
    // STORE PLAYBACK STATE
    // -----------------------------------------------------

    pitchNodes = [
        beatSource,
        vocalSource
    ];

    pitchPlaying = true;

    updatePitchPlayButton();


    // -----------------------------------------------------
    // END OF TRACK
    // -----------------------------------------------------

    beatSource.onended = () => {

        if (!pitchPlaying) {
            return;
        }

        pitchPosition =
            duration;

        stopPitchPlayback();

        updatePitchPosition(
            duration
        );

    };


    // -----------------------------------------------------
    // UPDATE PLAYHEAD
    // -----------------------------------------------------

    animatePitchPlayback();
}


// =====================================================
// PAUSE
// =====================================================

function pausePitchPlayback() {

    if (!pitchPlaying) {
        return;
    }

    pitchPosition =
        getPitchCurrentPosition();

    stopPitchPlayback();

    updatePitchPosition(
        pitchPosition
    );
}


// =====================================================
// PLAY / PAUSE BUTTON
// =====================================================

pitchPlayBtn.addEventListener(
    "click",
    () => {

        if (pitchPlaying) {

            pausePitchPlayback();

        } else {

            startPitchPlayback(
                pitchPosition
            );

        }

    }
);


// =====================================================
// STOP
// =====================================================

pitchStopBtn.addEventListener(
    "click",
    () => {

        stopPitchPlayback();

        pitchPosition = 0;

        pitchLoopStart = 0;

        updatePitchPosition(0);

    }
);


// =====================================================
// A/B MODE SWITCH
// =====================================================

function switchPitchMode(mode) {

    if (
        mode === "tuned" &&
        !audioBuffers.tuned
    ) {
        return;
    }

    if (
        mode === "original" &&
        !audioBuffers.original
    ) {
        return;
    }

    if (
        mode === "detuned" &&
        !audioBuffers.detuned
    ) {
        return;
    }

    const wasPlaying =
        pitchPlaying;

    const currentPosition =
        getPitchCurrentPosition();

    pitchMode =
        mode;


    modeCorrectedBtn
        .classList
        .toggle(
            "active",
            mode === "tuned"
        );

    modeOriginalBtn
        .classList
        .toggle(
            "active",
            mode === "original"
        );
    
    modeDetunedBtn
    .classList
    .toggle(
        "active",
        mode === "detuned"
    );

    if (wasPlaying) {

        startPitchPlayback(
            currentPosition
        );

    } else {

        updatePitchPosition(
            currentPosition
        );

    }

}


modeCorrectedBtn.addEventListener(
    "click",
    () => switchPitchMode("tuned")
);

modeOriginalBtn.addEventListener(
    "click",
    () => switchPitchMode("original")
);
modeDetunedBtn.addEventListener(
    "click",
    () => switchPitchMode("detuned")
);


// =====================================================
// JUMP / REWIND
// =====================================================

function jumpPitchPlayback(
    seconds
) {

    const current =
        getPitchCurrentPosition();

    const duration =
        S.beatBuffer
            ? S.beatBuffer.duration
            : 0;

    const target =
        Math.max(
            0,
            Math.min(
                duration - 0.01,
                current + seconds
            )
        );


    // When playing, restart both
    // sources from the new position.

    if (pitchPlaying) {

        startPitchPlayback(
            target
        );

    } else {

        pitchPosition =
            target;

        updatePitchPosition(
            target
        );

    }

}


rewind5sBtn.addEventListener(
    "click",
    () => jumpPitchPlayback(-5)
);

rewind2sBtn.addEventListener(
    "click",
    () => jumpPitchPlayback(-2)
);

forward5sBtn.addEventListener(
    "click",
    () => jumpPitchPlayback(5)
);


// =====================================================
// 4 SECOND LOOP
// =====================================================

pitchLoopToggle.addEventListener(
    "change",
    () => {

        if (
            !pitchLoopToggle.checked
        ) {
            return;
        }

        // Start the loop at the
        // current listening position.

        pitchLoopStart =
            getPitchCurrentPosition();

    }
);


// =====================================================
// PLAYBACK ANIMATION
// =====================================================

function animatePitchPlayback() {

    if (!pitchPlaying) {
        return;
    }

    const current =
        getPitchCurrentPosition();


    // -----------------------------------------------------
    // LOOP
    // -----------------------------------------------------

    if (
        pitchLoopToggle.checked &&
        current >= pitchLoopStart + 4
    ) {

        startPitchPlayback(
            pitchLoopStart
        );

        return;

    }


    // -----------------------------------------------------
    // END
    // -----------------------------------------------------

    if (
        S.beatBuffer &&
        current >=
        S.beatBuffer.duration
    ) {

        stopPitchPlayback();

        updatePitchPosition(
            S.beatBuffer.duration
        );

        return;

    }


    updatePitchPosition(
        current
    );


    pitchAnimationFrame =
        requestAnimationFrame(
            animatePitchPlayback
        );

}

    // -----------------------------------------------------
    // WAV encoding for the download
    // -----------------------------------------------------

    function toWav(channels, sampleRate) {

        const n = channels[0].length, nch = channels.length;
        const buffer = new ArrayBuffer(44 + n * nch * 2);
        const view = new DataView(buffer);

        const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };

        text(0, "RIFF"); view.setUint32(4, 36 + n * nch * 2, true);
        text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, nch, true);
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * nch * 2, true);
        view.setUint16(32, nch * 2, true); view.setUint16(34, 16, true);
        text(36, "data"); view.setUint32(40, n * nch * 2, true);

        let offset = 44;
        for (let i = 0; i < n; i++) {
            for (let c = 0; c < nch; c++) {
                const v = Math.max(-1, Math.min(1, channels[c][i]));
                view.setInt16(offset, v < 0 ? v * 32768 : v * 32767, true);
                offset += 2;
            }
        }

        return new Blob([buffer], { type: "audio/wav" });
    }
});