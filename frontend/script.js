document.addEventListener("DOMContentLoaded", () => {

    // =====================================================
    // 1. GET HTML ELEMENTS
    // =====================================================

    const vocalInput = document.getElementById("vocal-input");
    const beatInput = document.getElementById("beat-input");

    const vocalFileName = document.getElementById("vocal-file-name");
    const beatFileName = document.getElementById("beat-file-name");

    const uploadSection = document.getElementById("upload-section");
    const alignmentSection = document.getElementById("alignment-section");
    const analysisSection = document.getElementById("analysis-section");

    const startAlignmentButton = document.getElementById(
        "start-alignment-button"
    );

    const continueAnalysisButton = document.getElementById(
        "continue-analysis-button"
    );

    const alignmentVocalName = document.getElementById(
        "alignment-vocal-name"
    );

    const alignmentBeatName = document.getElementById(
        "alignment-beat-name"
    );

    const beatCanvas = document.getElementById("beat-waveform");
    const vocalCanvas = document.getElementById("vocal-waveform");

    const beatDurationDisplay = document.getElementById("beat-duration");

    const offsetSlider = document.getElementById("offset-slider");
    const offsetValue = document.getElementById("offset-value");

    const vocalOffsetDisplay = document.getElementById(
        "vocal-offset-display"
    );

    const autoAlignButton = document.getElementById("auto-align-button");

    const previewAlignmentButton = document.getElementById(
        "preview-alignment-button"
    );

    const nudgeButtons = document.querySelectorAll("[data-nudge]");

    const playhead = document.getElementById("playhead");
    const loopRegion = document.getElementById("loop-region");
    const loopToggle = document.getElementById("loop-toggle");
    const loopLengthSelect = document.getElementById("loop-length");


    // =====================================================
    // 2. AUDIO VARIABLES
    // =====================================================

    let audioContext;

    let vocalBuffer = null;
    let beatBuffer = null;

    // Positive values move the vocal later relative to the beat.
    let vocalOffset = 0;

    // Read-only window onto the audio state, used by tune.js (step 4).
    window.VocalVaultState = {
        get vocalBuffer() { return vocalBuffer; },
        get beatBuffer() { return beatBuffer; },
        get audioContext() { return audioContext; },
        get vocalOffset() { return vocalOffset; },
        get beatBpm() { return detectedBpm; },
        beatKey: null,         // set by runBeatKeyAnalysis
        vocalPitch: null       // set by runVocalPitchAnalysis (range, lowest note, pitch curve)
    };


    // =====================================================
    // 3. DISPLAY SELECTED FILE NAMES
    // =====================================================

    vocalInput.addEventListener("change", () => {

        const file = vocalInput.files[0];

        vocalFileName.textContent = file
            ? file.name
            : "No vocal selected";

    });


    beatInput.addEventListener("change", () => {

        const file = beatInput.files[0];

        beatFileName.textContent = file
            ? file.name
            : "No beat selected";

    });


    // =====================================================
    // 4. LOAD AUDIO AND OPEN ALIGNMENT
    // =====================================================

    startAlignmentButton.addEventListener("click", async () => {

        const vocalFile = vocalInput.files[0];
        const beatFile = beatInput.files[0];

        // Both files are required.
        if (!vocalFile || !beatFile) {

            alert(
                "Please select both a vocal track and an instrumental beat."
            );

            return;
        }

        try {

            startAlignmentButton.disabled = true;
            startAlignmentButton.textContent = "Loading audio...";

            // Create the browser audio engine.
            audioContext = new (
                window.AudioContext || window.webkitAudioContext
            )();

            // Decode both audio files.
            [vocalBuffer, beatBuffer] = await Promise.all([
                decodeFile(audioContext, vocalFile),
                decodeFile(audioContext, beatFile)
            ]);

            // Display selected track names.
            alignmentVocalName.textContent = vocalFile.name;
            alignmentBeatName.textContent = beatFile.name;

            // Display beat duration.
            beatDurationDisplay.textContent = formatTime(
                beatBuffer.duration
            );

            // Start with zero offset.
            vocalOffset = 0;

            offsetSlider.value = "0";

            updateOffsetDisplay();

            // Hide upload section.
            uploadSection.classList.add("hidden");

            // Show alignment section.
            alignmentSection.classList.remove("hidden");

            // Draw the waveforms now that the section has a real width.
            drawWaveform(beatCanvas, beatBuffer);
            drawWaveform(vocalCanvas, vocalBuffer);

            // Park the playhead just before the vocal comes in.
            setPlayhead(detectAudioStart(vocalBuffer) - 1, false);

            alignmentSection.scrollIntoView({
                behavior: "smooth",
                block: "start"
            });

        } catch (error) {

            console.error(error);

            alert(
                "Could not read one of the audio files. " +
                "Please try another audio format."
            );

        } finally {

            startAlignmentButton.disabled = false;

            startAlignmentButton.textContent = "Continue to Alignment";

        }

    });


    // =====================================================
    // 5. VOCAL POSITION SLIDER
    // =====================================================

    offsetSlider.addEventListener("input", () => {

        setVocalOffset(parseFloat(offsetSlider.value));

    });


    // Fine adjustment: 1 ms and 10 ms nudges.
    nudgeButtons.forEach((button) => {

        button.addEventListener("click", () => {

            if (!vocalBuffer) return;

            setVocalOffset(
                vocalOffset + parseFloat(button.dataset.nudge)
            );

        });

    });


    // =====================================================
    // 6. DRAG THE VOCAL WAVEFORM
    // =====================================================

    let dragging = false;

    let dragStartX = 0;
    let dragStartOffset = 0;


    // Remember where the drag started.
    vocalCanvas.addEventListener("pointerdown", (event) => {

        if (!vocalBuffer) return;

        dragging = true;

        dragStartX = event.clientX;

        dragStartOffset = vocalOffset;

        vocalCanvas.setPointerCapture(event.pointerId);

    });


    // Update vocal offset while dragging.
    vocalCanvas.addEventListener("pointermove", (event) => {

        if (!dragging || !vocalBuffer) return;

        const secondsPerPixel = getTimelineSecondsPerPixel();

        const movementSeconds =
            (event.clientX - dragStartX) * secondsPerPixel;

        setVocalOffset(dragStartOffset + movementSeconds);

    });


    // Stop dragging when the pointer is released.
    vocalCanvas.addEventListener("pointerup", () => {

        dragging = false;

    });


    vocalCanvas.addEventListener("pointercancel", () => {

        dragging = false;

    });


    // =====================================================
    // 7. AUTOMATIC ALIGNMENT
    // =====================================================

    autoAlignButton.addEventListener("click", async () => {

        if (!vocalBuffer || !beatBuffer) return;

        autoAlignButton.disabled = true;

        autoAlignButton.textContent = "Analyzing...";

        try {

            // Find the first audible point in both tracks.
            const vocalStart = detectAudioStart(vocalBuffer);

            const beatStart = detectAudioStart(beatBuffer);

            // Calculate the difference between their start times.
            setVocalOffset(beatStart - vocalStart);

        } finally {

            autoAlignButton.disabled = false;

            autoAlignButton.textContent = "Auto Align";

        }

    });


    // =====================================================
    // 8. PLAYHEAD AND LIVE PREVIEW
    // =====================================================
    // The white line is the playhead: it marks where playback starts.
    // Play Preview plays the beat and the vocal from there. With Loop
    // on, the same few seconds repeat, so you can adjust the vocal and
    // hear the result immediately without waiting for the song.
    // Moving the vocal re-times ONLY the vocal. The beat never changes.

    // How far ahead audio is scheduled. Both tracks are placed on the
    // audio clock, so the gap between them is exact to the sample.
    const PREVIEW_LEAD = 0.03;

    // Short crossfade when the vocal is re-timed, so it doesn't click.
    const PREVIEW_FADE = 0.008;

    // Tiny fades at loop edges so the loop point doesn't click.
    const EDGE_FADE = 0.002;

    let playheadTime = 0;       // where playback starts (seconds)
    let preview = null;         // null while stopped
    let scrubbing = false;      // true while the playhead is being dragged


    // ---------- playhead position and loop region ----------

    function getLoopLength() {

        return parseFloat(loopLengthSelect.value) || 4;

    }


    function drawPlayhead(seconds) {

        if (!beatBuffer) return;

        playhead.style.left =
            (seconds / beatBuffer.duration) * 100 + "%";

    }


    function drawLoopRegion() {

        if (!beatBuffer || !loopToggle.checked) {

            loopRegion.classList.add("hidden");

            return;
        }

        const length = Math.min(
            getLoopLength(),
            beatBuffer.duration - playheadTime
        );

        loopRegion.style.left =
            (playheadTime / beatBuffer.duration) * 100 + "%";

        loopRegion.style.width =
            (length / beatBuffer.duration) * 100 + "%";

        loopRegion.classList.remove("hidden");

    }


    function setPlayhead(seconds, restartIfPlaying = true) {

        if (!beatBuffer) return;

        playheadTime = clamp(
            seconds,
            0,
            Math.max(0, beatBuffer.duration - 0.1)
        );

        drawPlayhead(playheadTime);

        drawLoopRegion();

        if (restartIfPlaying && preview) {
            restartLivePreview();
        }

    }


    // ---------- moving the playhead with the mouse or finger ----------

    function timeFromPointer(event) {

        const rect = beatCanvas.getBoundingClientRect();

        return (
            (event.clientX - rect.left) / rect.width
        ) * beatBuffer.duration;

    }


    // Both the beat waveform (click anywhere) and the white line
    // itself (drag it) move the playhead.
    [beatCanvas, playhead].forEach((element) => {

        element.addEventListener("pointerdown", (event) => {

            if (!beatBuffer) return;

            scrubbing = true;

            element.setPointerCapture(event.pointerId);

            setPlayhead(timeFromPointer(event), false);

        });

        element.addEventListener("pointermove", (event) => {

            if (!scrubbing) return;

            setPlayhead(timeFromPointer(event), false);

        });

        const release = () => {

            if (!scrubbing) return;

            scrubbing = false;

            // If music is playing, jump to the new spot.
            if (preview) restartLivePreview();

        };

        element.addEventListener("pointerup", release);

        element.addEventListener("pointercancel", release);

    });


    loopToggle.addEventListener("change", () => {

        drawLoopRegion();

        if (preview) restartLivePreview();

    });

    loopLengthSelect.addEventListener("change", () => {

        drawLoopRegion();

        if (preview) restartLivePreview();

    });


    // ---------- play / stop ----------

    previewAlignmentButton.addEventListener("click", () => {

        if (preview) {
            stopLivePreview();
        } else {
            startLivePreview();
        }

    });


    function startLivePreview() {

        if (!audioContext || !vocalBuffer || !beatBuffer) return;

        if (audioContext.state === "suspended") {
            audioContext.resume();
        }

        const beatGain = audioContext.createGain();
        beatGain.gain.value = 0.75;
        beatGain.connect(audioContext.destination);

        const vocalBus = audioContext.createGain();
        vocalBus.gain.value = 1;
        vocalBus.connect(audioContext.destination);

        preview = {
            beatGain,
            vocalBus,
            passes: [],
            tickTimer: null,
            frame: null,
            refreshQueued: false
        };

        schedulePass(audioContext.currentTime + PREVIEW_LEAD);

        // Keeps the loop going and tidies up finished audio.
        preview.tickTimer = setInterval(previewTick, 25);

        preview.frame = requestAnimationFrame(animatePlayhead);

        previewAlignmentButton.textContent = "■ Stop Preview";

    }


    function stopLivePreview() {

        if (!preview) return;

        const old = preview;

        preview = null;

        clearInterval(old.tickTimer);

        cancelAnimationFrame(old.frame);

        // Fade out quickly, then stop, so stopping doesn't click.
        const now = audioContext.currentTime;

        [old.beatGain, old.vocalBus].forEach((gain) => {

            gain.gain.cancelScheduledValues(now);

            gain.gain.setTargetAtTime(0, now, 0.004);

        });

        const stopAt = now + 0.03;

        old.passes.forEach((pass) => {

            try { pass.beatSource.stop(stopAt); } catch (error) { /* done */ }

            pass.vocals.forEach((vocal) => {

                try { vocal.source.stop(stopAt); } catch (error) { /* done */ }

            });

        });

        setTimeout(() => {

            old.beatGain.disconnect();

            old.vocalBus.disconnect();

        }, 150);

        // The line goes back to where playback began.
        drawPlayhead(playheadTime);

        previewAlignmentButton.textContent = "▶ Play Preview";

    }


    function restartLivePreview() {

        stopLivePreview();

        startLivePreview();

    }


    // ---------- scheduling ----------

    // Fade in and out at the edges of a stretch of audio.
    function shapeEnvelope(param, from, to, fadeIn, fadeOut) {

        param.setValueAtTime(0, from);

        param.linearRampToValueAtTime(1, from + fadeIn);

        if (to - fadeOut > from + fadeIn) {

            param.setValueAtTime(1, to - fadeOut);

            param.linearRampToValueAtTime(0, to);

        }

    }


    // Schedules one pass of the beat (and the vocal under it) starting
    // at `ctxStart` on the audio clock. With Loop off there is a single
    // pass to the end of the song. With Loop on, each pass is one loop
    // length and the next pass is scheduled just before this one ends.
    function schedulePass(ctxStart) {

        const remaining = beatBuffer.duration - playheadTime;

        const length = loopToggle.checked
            ? Math.min(getLoopLength(), remaining)
            : remaining;

        const beatFade = audioContext.createGain();

        shapeEnvelope(
            beatFade.gain,
            ctxStart,
            ctxStart + length,
            EDGE_FADE,
            EDGE_FADE
        );

        beatFade.connect(preview.beatGain);

        const beatSource = audioContext.createBufferSource();

        beatSource.buffer = beatBuffer;

        beatSource.connect(beatFade);

        beatSource.start(ctxStart, playheadTime, length);

        const pass = {
            ctxStart,
            ctxEnd: ctxStart + length,
            beatStart: playheadTime,
            beatSource,
            beatFade,
            vocals: []
        };

        preview.passes.push(pass);

        scheduleVocal(pass, ctxStart, false);

    }


    // Places the vocal under the beat for the part of `pass` that is
    // still to come after `fromCtx`. The vocal's position is always
    //     (where the beat is) - (vocal offset)
    // so changing the offset moves the vocal and nothing else.
    function scheduleVocal(pass, fromCtx, crossfade) {

        const t = Math.max(fromCtx, pass.ctxStart);

        if (t >= pass.ctxEnd) return;

        const beatTime = pass.beatStart + (t - pass.ctxStart);

        const vocalPosition = beatTime - vocalOffset;

        let startCtx = t;
        let startPosition = vocalPosition;

        // Negative: the vocal hasn't started yet, so wait for it.
        if (vocalPosition < 0) {
            startCtx = t - vocalPosition;
            startPosition = 0;
        }

        const duration = pass.ctxEnd - startCtx;

        if (duration <= 0 || startPosition >= vocalBuffer.duration) return;

        const fade = audioContext.createGain();

        shapeEnvelope(
            fade.gain,
            startCtx,
            pass.ctxEnd,
            crossfade ? PREVIEW_FADE : EDGE_FADE,
            EDGE_FADE
        );

        fade.connect(preview.vocalBus);

        const source = audioContext.createBufferSource();

        source.buffer = vocalBuffer;

        source.connect(fade);

        source.start(startCtx, startPosition, duration);

        pass.vocals.push({ source, fade, startCtx });

    }


    // Re-time the vocal inside every pass that is playing or queued.
    function retimeVocal() {

        if (!preview) return;

        const when = audioContext.currentTime + PREVIEW_LEAD;

        preview.passes.forEach((pass) => {

            if (pass.ctxEnd <= when) return;

            pass.vocals.forEach((vocal) => {

                if (vocal.startCtx >= when) {

                    // Hasn't started yet: just cancel it.
                    try { vocal.source.stop(0); } catch (error) { /* done */ }

                } else {

                    // Already playing: fade it out as the new one fades in.
                    vocal.fade.gain.cancelScheduledValues(when);

                    vocal.fade.gain.setValueAtTime(1, when);

                    vocal.fade.gain.linearRampToValueAtTime(
                        0,
                        when + PREVIEW_FADE
                    );

                    try {
                        vocal.source.stop(when + PREVIEW_FADE);
                    } catch (error) { /* done */ }

                }

            });

            pass.vocals = [];

            scheduleVocal(pass, when, true);

        });

    }


    // Called whenever the offset changes. Several quick changes
    // (dragging the slider) are merged into one re-time per frame.
    function refreshLivePreview() {

        if (!preview || preview.refreshQueued) return;

        preview.refreshQueued = true;

        requestAnimationFrame(() => {

            if (!preview) return;

            preview.refreshQueued = false;

            retimeVocal();

        });

    }


    // Runs every 25 ms while playing.
    function previewTick() {

        if (!preview) return;

        const now = audioContext.currentTime;

        const last = preview.passes[preview.passes.length - 1];

        if (loopToggle.checked) {

            // Queue the next lap just before this one ends.
            if (now + 0.2 >= last.ctxEnd) {
                schedulePass(last.ctxEnd);
            }

        } else if (now > last.ctxEnd + 0.05) {

            // Reached the end of the song.
            stopLivePreview();

            return;
        }

        // Release laps that have finished.
        preview.passes = preview.passes.filter((pass) => {

            if (pass.ctxEnd + 0.3 >= now) return true;

            pass.beatFade.disconnect();

            pass.vocals.forEach((vocal) => vocal.fade.disconnect());

            return false;

        });

    }


    // Moves the white line along with the music.
    function animatePlayhead() {

        if (!preview) return;

        if (!scrubbing) {

            const now = audioContext.currentTime;

            const pass = preview.passes.find(
                (p) => now >= p.ctxStart && now < p.ctxEnd
            );

            if (pass) {
                drawPlayhead(pass.beatStart + (now - pass.ctxStart));
            }

        }

        preview.frame = requestAnimationFrame(animatePlayhead);

    }


    // =====================================================
    // 9. CONTINUE TO AUDIO ANALYSIS
    // =====================================================

continueAnalysisButton.addEventListener("click", () => {

    stopLivePreview();

    analysisSection.classList.remove("hidden");

    analysisSection.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });

    runBeatAnalysis();
    runBeatKeyAnalysis();
    runVocalPitchAnalysis();
    runVocalTempoAnalysis();

});


    // =====================================================
    // 9b. BEAT BPM ANALYSIS
    // =====================================================

    const beatBpmValue = document.getElementById("beat-bpm");
    const beatBpmStatus = document.getElementById("beat-bpm-status");
    const bpmAdjust = document.getElementById("bpm-adjust");
    const bpmHalfButton = document.getElementById("bpm-half-button");
    const bpmDoubleButton = document.getElementById("bpm-double-button");

    let analyzedBeatBuffer = null;
    let detectedBpm = null;
    let originalBpm = null;
    let bpmConfidence = 0;

    // Prep (or other steps) can set BPM when analysis missed it
    window.VocalVaultSetBeatBpm = function (bpm) {
        const n = Number(bpm);
        if (!(n > 30 && n < 400)) return;
        detectedBpm = n;
        if (originalBpm == null) originalBpm = n;
        try { showBpm(); } catch (e) { /* ignore */ }
    };

    async function runBeatAnalysis() {

        // Only analyze each beat once.
        if (!beatBuffer || analyzedBeatBuffer === beatBuffer) return;

        const currentBeat = beatBuffer;

        analyzedBeatBuffer = currentBeat;

        beatBpmValue.textContent = "…";
        beatBpmStatus.textContent = "Analyzing beat…";
        bpmAdjust.classList.add("hidden");

        try {

            const result =
                await window.VocalVaultAnalysis.analyzeBpm(currentBeat);

            // Ignore the result if a different beat was loaded meanwhile.
            if (analyzedBeatBuffer !== currentBeat) return;

            if (result.bpm === null) {

                beatBpmValue.textContent = "—";
                beatBpmStatus.textContent = result.reason;

                return;
            }

            detectedBpm = result.bpm;
            originalBpm = result.bpm;
            bpmConfidence = result.confidence;

            showBpm();

            bpmAdjust.classList.remove("hidden");

        } catch (error) {

            console.error(error);

            analyzedBeatBuffer = null;

            beatBpmValue.textContent = "—";
            beatBpmStatus.textContent = "Could not analyze this beat.";

        }

    }


    function formatBpm(bpm) {

        // Show whole numbers when the result is within 0.15 of one.
        return Math.abs(bpm - Math.round(bpm)) < 0.15
            ? String(Math.round(bpm))
            : bpm.toFixed(1);

    }


    function showBpm() {

        beatBpmValue.textContent = formatBpm(detectedBpm);

        if (detectedBpm === originalBpm) {

            const level =
                bpmConfidence >= 0.7 ? "high"
                : bpmConfidence >= 0.45 ? "medium"
                : "low";

            beatBpmStatus.textContent = `Detected · ${level} confidence`;

        } else {

            beatBpmStatus.textContent =
                `Adjusted from ${formatBpm(originalBpm)}`;

        }

        // The vocal is judged against the beat, so refresh that comparison.
        showVocalTempo();

    }


    // Fix half-time / double-time mistakes.
    bpmHalfButton.addEventListener("click", () => {

        if (detectedBpm === null || detectedBpm / 2 < 20) return;

        detectedBpm = detectedBpm / 2;

        showBpm();

    });


    bpmDoubleButton.addEventListener("click", () => {

        if (detectedBpm === null || detectedBpm * 2 > 400) return;

        detectedBpm = detectedBpm * 2;

        showBpm();

    });

    // ============================================================
// 9c. BEAT KEY + SCALE ANALYSIS
// ============================================================

const beatKeyValue =
    document.getElementById("beat-key");

const beatKeyStatus =
    beatKeyValue
        ? beatKeyValue.parentElement.querySelector("small")
        : null;

let analyzedKeyBuffer = null;


// ------------------------------------------------------------
// Run beat key detection.
// ------------------------------------------------------------

async function runBeatKeyAnalysis() {

    if (!beatBuffer) {
        return;
    }

    // Do not analyse the same beat twice.
    if (analyzedKeyBuffer === beatBuffer) {
        return;
    }

    const currentBeat = beatBuffer;

    analyzedKeyBuffer = currentBeat;

    window.VocalVaultState.beatKey = null;

    beatKeyValue.textContent = "…";

    if (beatKeyStatus) {
        beatKeyStatus.textContent =
            "Detecting key…";
    }

    try {

        const result =
            await window.VocalVaultAnalysis.detectKey(
                currentBeat
            );

        // Make sure the user hasn't loaded another beat
        // while the analysis was running.
        if (analyzedKeyBuffer !== currentBeat) {
            return;
        }

        if (!result.key) {

            beatKeyValue.textContent = "—";

            if (beatKeyStatus) {
                beatKeyStatus.textContent =
                    result.reason ||
                    "Could not detect key.";
            }

            return;
        }

        // Example:
        // C# Minor
        // A Major
        // F Minor

        beatKeyValue.textContent =
            `${result.key} ${result.scale}`;

        // Step 4 (pitch correction) reads this.
        window.VocalVaultState.beatKey = result;

        if (beatKeyStatus) {

            const confidencePercent =
                Math.round(
                    result.confidence * 100
                );

            beatKeyStatus.textContent =
                `Detected • ${confidencePercent}% confidence`;

        }

    } catch (error) {

        console.error(
            "Beat key analysis failed:",
            error
        );

        analyzedKeyBuffer = null;

        beatKeyValue.textContent = "—";

        if (beatKeyStatus) {
            beatKeyStatus.textContent =
                "Could not analyze key.";
        }

    }

}

// ============================================================
// 9d. VOCAL PITCH ANALYSIS
// ============================================================

const vocalPitchValue =
    document.getElementById("vocal-pitch");

const vocalPitchStatus =
    vocalPitchValue
        ? vocalPitchValue.parentElement.querySelector("small")
        : null;

let analyzedVocalPitchBuffer = null;
let vocalPitchAnalysis = null;


// ------------------------------------------------------------
// Run vocal pitch detection.
// ------------------------------------------------------------

async function runVocalPitchAnalysis() {

    if (!vocalBuffer) {
        return;
    }

    // Don't analyse the same vocal twice.
    if (
        analyzedVocalPitchBuffer ===
        vocalBuffer
    ) {
        return;
    }

    const currentVocal =
        vocalBuffer;

    analyzedVocalPitchBuffer =
        currentVocal;

    // A new vocal: forget the old one's pitch until this analysis finishes.
    window.VocalVaultState.vocalPitch = null;

    vocalPitchValue.textContent = "…";

    if (vocalPitchStatus) {
        vocalPitchStatus.textContent =
            "Detecting vocal pitch…";
    }

    try {

        const result =
            await window.VocalVaultAnalysis
                .detectVocalPitch(
                    currentVocal
                );

        // Ignore stale results.
        if (
            analyzedVocalPitchBuffer !==
            currentVocal
        ) {
            return;
        }

        if (
            !result.frames ||
            result.minMidi === null
        ) {

            vocalPitchValue.textContent =
                "—";

            if (vocalPitchStatus) {
                vocalPitchStatus.textContent =
                    result.reason ||
                    "Could not detect vocal pitch.";
            }

            return;

        }

        // Save the complete pitch curve.
        // We'll need this later for pitch correction.
        vocalPitchAnalysis =
            result;

        // Share it with the mix stage (the high-pass sits below the lowest note).
        window.VocalVaultState.vocalPitch = result;

        // Display the detected vocal range.
        vocalPitchValue.textContent =
            result.noteRange;

        if (vocalPitchStatus) {

            const confidencePercent =
                Math.round(
                    result.confidence * 100
                );

            vocalPitchStatus.textContent =
                `Detected • ${confidencePercent}% confidence`;

        }

        console.log(
            "Vocal pitch analysis:",
            result
        );

    } catch (error) {

        console.error(
            "Vocal pitch analysis failed:",
            error
        );

        analyzedVocalPitchBuffer =
            null;

        vocalPitchValue.textContent =
            "—";

        if (vocalPitchStatus) {
            vocalPitchStatus.textContent =
                "Could not analyze vocal pitch.";
        }

    }

}
// ============================================================
// 9e. VOCAL TEMPO ANALYSIS
// ============================================================
// A vocal has no drums, so its tempo is read from where the
// syllables start. That is far less certain than reading a beat,
// so it is always shown next to the beat's BPM, and the search is
// centred on the beat's tempo (which also avoids half/double-time
// mistakes).
// ============================================================

const vocalTempoValue =
    document.getElementById("vocal-bpm");

const vocalTempoStatus =
    document.getElementById("vocal-bpm-status");

const vocalTempoCompare =
    document.getElementById("vocal-bpm-compare");

let analyzedVocalTempoBuffer = null;
let vocalTempoAnalysis = null;   // full result, including the tempogram
let vocalTempoMatch = null;      // vocal vs beat; used by time-stretching later

// Below this the vocal has no steady pulse worth reporting.
const MIN_VOCAL_TEMPO_CONFIDENCE = 0.3;


async function runVocalTempoAnalysis() {

    if (!vocalBuffer) {
        return;
    }

    // Don't analyse the same vocal twice.
    if (analyzedVocalTempoBuffer === vocalBuffer) {
        return;
    }

    const currentVocal = vocalBuffer;

    analyzedVocalTempoBuffer = currentVocal;
    vocalTempoAnalysis = null;
    vocalTempoMatch = null;

    vocalTempoValue.textContent = "…";
    vocalTempoStatus.textContent = "Analyzing vocal rhythm…";
    vocalTempoCompare.textContent = "";

    try {

        const result =
            await window.VocalVaultAnalysis
                .analyzeVocalTempo(currentVocal);

        // Ignore stale results.
        if (analyzedVocalTempoBuffer !== currentVocal) {
            return;
        }

        if (result.bpm === null) {

            vocalTempoValue.textContent = "—";
            vocalTempoStatus.textContent =
                result.reason || "Could not detect vocal tempo.";

            return;
        }

        vocalTempoAnalysis = result;

        showVocalTempo();

    } catch (error) {

        console.error("Vocal tempo analysis failed:", error);

        analyzedVocalTempoBuffer = null;

        vocalTempoValue.textContent = "—";
        vocalTempoStatus.textContent = "Could not analyze vocal tempo.";
        vocalTempoCompare.textContent = "";

    }

}


// Shows the vocal tempo next to the beat tempo. Called when the
// vocal finishes, when the beat BPM arrives, and when the user
// presses ÷2 or ×2 on the beat BPM.
function showVocalTempo() {

    if (!vocalTempoAnalysis) {
        return;
    }

    const analysis = window.VocalVaultAnalysis;

    // Beat tempo not known yet: show the vocal's own best guess.
    if (!detectedBpm) {

        vocalTempoMatch = null;

        vocalTempoValue.textContent =
            formatBpm(vocalTempoAnalysis.bpm);

        vocalTempoStatus.textContent =
            vocalTempoAnalysis.confidence < MIN_VOCAL_TEMPO_CONFIDENCE
                ? "No steady rhythm found"
                : "Detected • waiting for the beat BPM";

        vocalTempoCompare.textContent = "";

        return;
    }

    const near =
        analysis.findTempoNear(vocalTempoAnalysis, detectedBpm);

    if (!near || near.confidence < MIN_VOCAL_TEMPO_CONFIDENCE || near.atEdge) {

        vocalTempoMatch = null;

        vocalTempoValue.textContent = "—";

        // Does the vocal have a steady pulse somewhere else?
        const ownGuess =
            vocalTempoAnalysis.confidence >= MIN_VOCAL_TEMPO_CONFIDENCE
                ? vocalTempoAnalysis.bpm
                : null;

        if (ownGuess) {

            vocalTempoStatus.textContent = "Doesn't match the beat";
            vocalTempoCompare.textContent =
                `This vocal reads as about ${formatBpm(ownGuess)} BPM, ` +
                `more than 20% away from the beat. If the beat BPM ` +
                `looks half or double, press ÷2 or ×2.`;

        } else {

            vocalTempoStatus.textContent = "No steady rhythm found";
            vocalTempoCompare.textContent =
                "The vocal is too free-flowing to measure a tempo.";

        }

        return;
    }

    const level =
        near.confidence >= 0.7 ? "high"
        : near.confidence >= 0.45 ? "medium"
        : "low";

    vocalTempoValue.textContent = formatBpm(near.bpm);
    vocalTempoStatus.textContent = `Detected • ${level} confidence`;

    // Playback rate that would bring the vocal onto the beat's tempo.
    // 1.064 means play 6.4% faster; 0.943 means 5.7% slower.
    const rate = detectedBpm / near.bpm;
    const differencePercent = (near.bpm - detectedBpm) / detectedBpm * 100;

    vocalTempoMatch = {
        vocalBpm: near.bpm,
        beatBpm: detectedBpm,
        confidence: near.confidence,
        stretchRate: rate
    };

    if (Math.abs(differencePercent) < 1.5) {

        vocalTempoCompare.textContent =
            `In time with the beat (${formatBpm(detectedBpm)} BPM)`;

    } else {

        const slower = differencePercent < 0;
        const adjustPercent = Math.abs(rate - 1) * 100;

        vocalTempoCompare.textContent =
            `${Math.abs(differencePercent).toFixed(1)}% ` +
            `${slower ? "slower" : "faster"} than the beat ` +
            `(${formatBpm(detectedBpm)} BPM)\n` +
            `${slower ? "Speed up" : "Slow down"} ` +
            `${adjustPercent.toFixed(1)}% to match`;

    }

}


    // =====================================================
    // 10. UPDATE OFFSET LABELS
    // =====================================================

    // The ONE place the vocal offset is changed. Slider, drag, nudge
    // buttons and Auto Align all go through here.
    function setVocalOffset(seconds) {

        // Keep within the slider range and snap to whole milliseconds.
        vocalOffset = clamp(
            Math.round(seconds * 1000) / 1000,
            parseFloat(offsetSlider.min),
            parseFloat(offsetSlider.max)
        );

        offsetSlider.value = vocalOffset.toFixed(3);

        updateOffsetDisplay();

        // Only the position changed, so just slide the waveform.
        // (Redrawing the whole waveform on every tick is slow.)
        if (beatBuffer && vocalBuffer) {
            layoutVocalCanvas();
        }

        // If the preview is playing, re-time the vocal right now.
        refreshLivePreview();

    }


    function updateOffsetDisplay() {

        const sign = vocalOffset > 0 ? "+" : "";

        const formatted = `${sign}${vocalOffset.toFixed(3)}s`;

        offsetValue.textContent = formatted;

        vocalOffsetDisplay.textContent = `Offset: ${formatted}`;

    }


    // =====================================================
    // 11. DRAW AN AUDIO WAVEFORM
    // =====================================================

    function drawWaveform(canvas, buffer) {

        if (!buffer) return;

        // Size and position the vocal on the beat's timeline before measuring.
        if (canvas === vocalCanvas && beatBuffer) {
            layoutVocalCanvas();
        }

        const rect = canvas.getBoundingClientRect();

        const dpr = window.devicePixelRatio || 1;

        // Scale the canvas for sharper rendering.
        canvas.width = Math.max(
            1,
            Math.floor(rect.width * dpr)
        );

        canvas.height = Math.max(
            1,
            Math.floor(rect.height * dpr)
        );

        const ctx = canvas.getContext("2d");

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const width = rect.width;
        const height = rect.height;

        ctx.clearRect(0, 0, width, height);


        // Draw vertical timeline grid lines.
        ctx.strokeStyle = "#24262d";

        ctx.lineWidth = 1;

        for (let x = 0; x < width; x += 50) {

            ctx.beginPath();

            ctx.moveTo(x, 0);

            ctx.lineTo(x, height);

            ctx.stroke();

        }


        // Read the first audio channel.
        const data = buffer.getChannelData(0);

        const samplesPerPixel = Math.max(
            1,
            Math.floor(data.length / width)
        );


        // Draw the waveform.
        ctx.beginPath();

        ctx.strokeStyle = "#ff5500";

        ctx.lineWidth = 1.2;

        for (let x = 0; x < width; x++) {

            const start = x * samplesPerPixel;

            const end = Math.min(
                start + samplesPerPixel,
                data.length
            );

            let min = 1;
            let max = -1;

            for (let i = start; i < end; i++) {

                const value = data[i];

                if (value < min) min = value;

                if (value > max) max = value;

            }

            const y1 = ((1 + min) / 2) * height;

            const y2 = ((1 + max) / 2) * height;

            ctx.moveTo(x, y1);

            ctx.lineTo(x, y2);

        }

        ctx.stroke();


        // Draw the centre line.
        ctx.strokeStyle = "#363942";

        ctx.beginPath();

        ctx.moveTo(0, height / 2);

        ctx.lineTo(width, height / 2);

        ctx.stroke();

    }


    // =====================================================
    // 11b. POSITION THE VOCAL ON THE BEAT TIMELINE
    // =====================================================

    function layoutVocalCanvas() {

        const trackWidth =
            vocalCanvas.parentElement.getBoundingClientRect().width;

        if (!trackWidth) return;

        const pixelsPerSecond = trackWidth / beatBuffer.duration;

        // Width matches the vocal's real length relative to the beat.
        vocalCanvas.style.width =
            Math.max(1, vocalBuffer.duration * pixelsPerSecond) + "px";

        // Slide the vocal left or right by its offset.
        vocalCanvas.style.transform =
            `translateX(${vocalOffset * pixelsPerSecond}px)`;

    }


    // =====================================================
    // 12. DETECT THE FIRST AUDIBLE POINT
    // =====================================================

    function detectAudioStart(buffer) {

        const data = buffer.getChannelData(0);

        // Examine approximately the first 10 seconds.
        const maxSamples = Math.min(
            data.length,
            Math.floor(buffer.sampleRate * 10)
        );

        let peak = 0;

        for (let i = 0; i < maxSamples; i++) {

            peak = Math.max(
                peak,
                Math.abs(data[i])
            );

        }

        // Handle a silent recording.
        if (peak === 0) return 0;

        // Set a threshold relative to the recording's peak.
        const threshold = Math.max(
            0.01,
            peak * 0.08
        );

        // Require approximately 20 milliseconds of audible samples.
        const minimumRun = Math.floor(
            buffer.sampleRate * 0.02
        );

        let run = 0;

        for (let i = 0; i < maxSamples; i++) {

            if (Math.abs(data[i]) >= threshold) {

                run++;

                if (run >= minimumRun) {

                    return Math.max(
                        0,
                        (i - minimumRun) / buffer.sampleRate
                    );

                }

            } else {

                run = 0;

            }

        }

        return 0;

    }


    // =====================================================
    // 13. RENDER THE ALIGNED PREVIEW
    // =====================================================

    async function renderAlignmentPreview() {

        const sampleRate = Math.max(
            vocalBuffer.sampleRate,
            beatBuffer.sampleRate
        );

        // The BEAT never moves. It always starts at 0.
        // Only the vocal is shifted:
        //   positive offset -> vocal starts later (delayed)
        //   negative offset -> vocal starts earlier (its first
        //                      seconds are skipped, because nothing
        //                      can start before time 0)
        const vocalDelay = Math.max(0, vocalOffset);
        const vocalTrim = Math.max(0, -vocalOffset);

        // Work out how long the combined audio needs to be.
        const beatLength = Math.ceil(
            beatBuffer.duration * sampleRate
        );

        const vocalLength = Math.ceil(
            Math.max(0, vocalBuffer.duration - vocalTrim) * sampleRate
        );

        const vocalEnd =
            Math.ceil(vocalDelay * sampleRate) + vocalLength;

        const totalLength = Math.max(
            1,
            Math.max(beatLength, vocalEnd) +
            Math.floor(sampleRate * 0.25)
        );


        // Create an offline audio engine for rendering.
        const offline = new OfflineAudioContext(
            2,
            totalLength,
            sampleRate
        );


        // Create the beat source.
        const beatSource = offline.createBufferSource();

        beatSource.buffer = beatBuffer;


        // Create the vocal source.
        const vocalSource = offline.createBufferSource();

        vocalSource.buffer = vocalBuffer;


        // Set individual track volumes.
        const beatGain = offline.createGain();

        beatGain.gain.value = 0.75;

        const vocalGain = offline.createGain();

        vocalGain.gain.value = 1;


        // Connect audio sources to the output.
        beatSource.connect(beatGain);

        beatGain.connect(offline.destination);

        vocalSource.connect(vocalGain);

        vocalGain.connect(offline.destination);


        // Beat starts at 0. Vocal starts after its delay,
        // skipping `vocalTrim` seconds from the start of the recording.
        beatSource.start(0);

        vocalSource.start(vocalDelay, vocalTrim);


        // Render and return the combined audio.
        return await offline.startRendering();

    }


    // =====================================================
    // 14. DECODE AN UPLOADED AUDIO FILE
    // =====================================================

    async function decodeFile(ctx, file) {

        const arrayBuffer = await file.arrayBuffer();

        return await ctx.decodeAudioData(arrayBuffer);

    }


    // =====================================================
    // 15. CALCULATE TIMELINE MOVEMENT
    // =====================================================

    function getTimelineSecondsPerPixel() {

        if (!beatBuffer) return 0.01;

        const width = beatCanvas.getBoundingClientRect().width || 1;

        return beatBuffer.duration / width;

    }


    // =====================================================
    // 16. KEEP VALUES WITHIN A RANGE
    // =====================================================

    function clamp(value, min, max) {

        return Math.min(
            Math.max(value, min),
            max
        );

    }


    // =====================================================
    // 17. FORMAT AUDIO DURATION
    // =====================================================

    function formatTime(seconds) {

        const minutes = Math.floor(seconds / 60);

        const remaining = Math.floor(seconds % 60)
            .toString()
            .padStart(2, "0");

        return `${minutes}:${remaining}`;

    }


    // =====================================================
    // 18. CONVERT AUDIO TO A WAV FILE
    // =====================================================

    function audioBufferToWavBlob(buffer) {

        const numberOfChannels = buffer.numberOfChannels;

        const sampleRate = buffer.sampleRate;

        // Each sample uses 16 bits = 2 bytes.
        const dataLength =
            buffer.length * numberOfChannels * 2;

        const bufferLength = 44 + dataLength;

        const arrayBuffer = new ArrayBuffer(bufferLength);

        const view = new DataView(arrayBuffer);


        // Write the WAV header.
        writeString(view, 0, "RIFF");

        view.setUint32(4, bufferLength - 8, true);

        writeString(view, 8, "WAVE");

        writeString(view, 12, "fmt ");

        view.setUint32(16, 16, true);

        // PCM audio format.
        view.setUint16(20, 1, true);

        view.setUint16(22, numberOfChannels, true);

        view.setUint32(24, sampleRate, true);

        view.setUint32(
            28,
            sampleRate * numberOfChannels * 2,
            true
        );

        view.setUint16(32, numberOfChannels * 2, true);

        view.setUint16(34, 16, true);

        writeString(view, 36, "data");

        view.setUint32(40, dataLength, true);


        // Get the audio samples for each channel.
        const channels = [];

        for (let channel = 0; channel < numberOfChannels; channel++) {

            channels.push(
                buffer.getChannelData(channel)
            );

        }


        // Write interleaved 16-bit PCM samples.
        let offset = 44;

        for (let sample = 0; sample < buffer.length; sample++) {

            for (
                let channel = 0;
                channel < numberOfChannels;
                channel++
            ) {

                const value = clamp(
                    channels[channel][sample],
                    -1,
                    1
                );

                const intValue = value < 0
                    ? value * 32768
                    : value * 32767;

                view.setInt16(
                    offset,
                    intValue,
                    true
                );

                offset += 2;

            }

        }


        // Return the WAV file as a Blob.
        return new Blob(
            [arrayBuffer],
            { type: "audio/wav" }
        );

    }


    // =====================================================
    // 19. WRITE TEXT INTO A WAV HEADER
    // =====================================================

    function writeString(view, offset, string) {

        for (let i = 0; i < string.length; i++) {

            view.setUint8(
                offset + i,
                string.charCodeAt(i)
            );

        }

    }


    // =====================================================
    // 20. REDRAW WAVEFORMS WHEN WINDOW RESIZES
    // =====================================================

    window.addEventListener("resize", () => {

        if (beatBuffer) {
            drawWaveform(beatCanvas, beatBuffer);
        }

        if (vocalBuffer) {
            drawWaveform(vocalCanvas, vocalBuffer);
        }

    });


    // =====================================================
    // 21. CLEAN UP AUDIO URL WHEN PAGE IS CLOSED
    // =====================================================

    window.addEventListener("beforeunload", () => {

        stopLivePreview();

        if (audioContext && audioContext.state !== "closed") {

            audioContext.close();

        }

    });

    // =====================================================
    // 22. AUTOMIX ENGINE TRIGGER
    // =====================================================

    // Step 04 -> Step 05
    const continueMixButton = document.getElementById("continue-mix-button");
    const mixSection = document.getElementById("mix-section");

    if (continueMixButton && mixSection) {
        continueMixButton.addEventListener("click", () => {

            // Stop the pitch-correction player so it doesn't play under the mix.
            const pitchStop = document.getElementById("pitch-stop-btn");
            if (pitchStop) pitchStop.click();

            mixSection.classList.remove("hidden");
            mixSection.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    }

    const autoMixButton = document.getElementById("automix-button");
    const autoMixStatus = document.getElementById("automix-status");
    const mixAudioPlayer = document.getElementById("mix-audio-player");

    if (autoMixButton) {
        autoMixButton.addEventListener("click", async () => {
            if (!vocalBuffer || !beatBuffer) {
                alert("Please load both vocal and beat tracks first.");
                return;
            }

            autoMixButton.disabled = true;
            if (autoMixStatus) autoMixStatus.textContent = "Processing automix...";

            try {
                if (typeof stopLivePreview === "function") {
                    stopLivePreview();
                }

                // Pass the full accumulated state to automix.js
                const mixedBuffer = await window.VocalVaultAutomix.process(window.VocalVaultState);

                if (autoMixStatus) autoMixStatus.textContent = "Automix complete!";
                
                if (mixAudioPlayer && mixedBuffer) {
                    const wavBlob = audioBufferToWavBlob(mixedBuffer);

                    // Free the previous mix before making a new one.
                    if (mixAudioPlayer.dataset.url) URL.revokeObjectURL(mixAudioPlayer.dataset.url);
                    const mixUrl = URL.createObjectURL(wavBlob);
                    mixAudioPlayer.dataset.url = mixUrl;
                    mixAudioPlayer.src = mixUrl;

                    const mixDownload = document.getElementById("mix-download");
                    if (mixDownload) {
                        mixDownload.href = mixUrl;
                        mixDownload.classList.remove("hidden");
                    }

                    // mixui.js builds the 16/24-bit download and the fair before/after from this.
                    window.VocalVaultState.mixBuffer = mixedBuffer;
                    window.dispatchEvent(new Event("vv-mix-ready"));
                }

            } catch (error) {
                console.error("Automix failed:", error);
                if (autoMixStatus) autoMixStatus.textContent = "Automix failed.";
            } finally {
                autoMixButton.disabled = false;
            }
        });
    }
    

});