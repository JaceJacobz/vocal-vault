/**
 * Vocal Vault — Studio DAW + mode switch
 *
 * Studio mode: full timeline DAW
 *  - Load a beat
 *  - Add up to 20 vocal lanes (main / adlib / tag / harmony / other)
 *  - Record while the beat plays from the playhead (punch-in anywhere)
 *  - Clips store startOffset so they sit correctly on the timeline
 *  - Send main vocal + beat into Pipeline mode (rendered in place)
 *
 * Pipeline mode: existing upload → align → process flow (unchanged IDs)
 */
(function () {
    "use strict";

    const MAX_LANES = 20;
    const PX_PER_SEC_DESKTOP = 80;
    const PX_PER_SEC_MOBILE = 48;

    function pxPerSec() {
        return window.matchMedia("(max-width: 720px)").matches ? PX_PER_SEC_MOBILE : PX_PER_SEC_DESKTOP;
    }
    const COLORS = {
        main: "#22d3ee",
        adlib: "#a78bfa",
        tag: "#f472b6",
        harmony: "#34d399",
        other: "#fbbf24",
        beat: "#8b5cf6"
    };

    let lanes = [];
    let beat = { file: null, buffer: null, name: null, duration: 0 };

    let audioCtx = null;
    let playhead = 0;
    let isPlaying = false;
    let isRecording = false;
    let playStartCtx = 0;
    let playStartOffset = 0;
    let animFrame = null;
    let activeSources = [];

    let mediaStream = null;
    let mediaRecorder = null;
    let recChunks = [];
    let recLaneId = null;
    let recStartOffset = 0;
    let analyser = null;
    let meterRaf = null;
    let countInTimer = null;

    const $ = (id) => document.getElementById(id);
    const els = {};

    function cache() {
        els.shell = $("app-shell");
        els.preloader = $("preloader");
        els.modePipeline = $("mode-pipeline");
        els.modeStudio = $("mode-studio");
        els.subtitle = $("mode-subtitle");
        els.lanes = $("studio-lanes");
        els.empty = $("studio-empty");
        els.ruler = $("studio-ruler");
        els.rulerScroll = $("studio-ruler-scroll");
        els.playheadEl = $("studio-playhead");
        els.beatInput = $("studio-beat-input");
        els.beatName = $("studio-beat-name");
        els.loadBeat = $("studio-load-beat");
        els.addLane = $("studio-add-lane");
        els.laneType = $("studio-lane-type");
        els.toPipeline = $("studio-to-pipeline");
        els.trPlay = $("tr-play");
        els.trStop = $("tr-stop");
        els.trRecord = $("tr-record");
        els.trScrub = $("tr-scrub");
        els.trCur = $("tr-time-current");
        els.trTot = $("tr-time-total");
        els.trLoop = $("tr-loop");
        els.trCountIn = $("tr-countin");
        els.trRawMic = $("tr-raw-mic");
        els.trStatus = $("tr-status");
        els.trMeter = $("tr-meter-fill");
        els.trackCount = $("track-count-label");
        els.roleVocal = $("role-vocal-chip");
        els.roleBeat = $("role-beat-chip");
        els.vocalInput = $("vocal-input");
        els.beatFileInput = $("beat-input");
        els.vocalFileName = $("vocal-file-name");
        els.beatFileName = $("beat-file-name");
    }

    function uid() {
        return Math.random().toString(36).slice(2, 9);
    }

    function fmt(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ":" + s.toFixed(1).padStart(4, "0");
    }

    function status(msg) {
        if (els.trStatus) els.trStatus.textContent = msg;
    }

    function ensureCtx() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume();
        return audioCtx;
    }

    function totalDuration() {
        let d = beat.duration || 0;
        lanes.forEach((lane) => {
            lane.clips.forEach((c) => {
                d = Math.max(d, c.start + c.duration);
            });
        });
        return Math.max(d, 30);
    }

    function timelineWidth() {
        return Math.ceil(totalDuration() * pxPerSec()) + 200;
    }

    function assignFile(input, file, nameEl) {
        if (!input || !file) return;
        try {
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            if (nameEl) nameEl.textContent = file.name;
        } catch (e) {
            console.warn(e);
        }
    }

    function hidePreloader() {
        if (!els.preloader) return;
        els.preloader.classList.add("is-done");
        els.shell?.classList.remove("is-booting");
        setTimeout(() => els.preloader?.remove(), 400);
    }

    function setMode(mode) {
        const isStudio = mode === "studio";
        els.shell?.classList.toggle("mode-studio", isStudio);
        els.shell?.classList.toggle("mode-pipeline", !isStudio);
        els.modePipeline?.classList.toggle("hidden", isStudio);
        els.modeStudio?.classList.toggle("hidden", !isStudio);
        els.modePipeline?.setAttribute("aria-hidden", isStudio ? "true" : "false");
        els.modeStudio?.setAttribute("aria-hidden", isStudio ? "false" : "true");

        document.querySelectorAll(".mode-btn").forEach((btn) => {
            const on = btn.dataset.mode === mode;
            btn.classList.toggle("is-active", on);
            btn.setAttribute("aria-selected", on ? "true" : "false");
        });

        if (els.subtitle) {
            els.subtitle.textContent = isStudio
                ? "Record · multi-lane · punch-in anywhere"
                : "Upload → align → correct → mix → master";
        }

        if (isStudio) {
            renderLanes();
            drawRuler();
            updatePlayheadUi();
        }
        try {
            localStorage.setItem("vv-mode", mode);
        } catch (_) {}
    }

    async function loadBeatFile(file) {
        if (!file) return;
        const ctx = ensureCtx();
        try {
            const ab = await file.arrayBuffer();
            const buffer = await ctx.decodeAudioData(ab.slice(0));
            beat = { file, buffer, name: file.name, duration: buffer.duration };
            if (els.beatName) els.beatName.textContent = file.name;
            assignFile(els.beatFileInput, file, els.beatFileName);
            refreshRoles();
            drawRuler();
            updateTotals();
            status("Beat loaded");
            renderLanes();
        } catch (e) {
            console.warn(e);
            status("Could not decode beat");
        }
    }

    function addLane(type) {
        if (lanes.length >= MAX_LANES) {
            status("Max " + MAX_LANES + " lanes");
            return;
        }
        type = type || els.laneType?.value || "main";
        const labels = { main: "Main vocal", adlib: "Adlib", tag: "Tag", harmony: "Harmony", other: "Other" };
        const count = lanes.filter((l) => l.type === type).length + 1;
        const lane = {
            id: uid(),
            name: labels[type] + (count > 1 ? " " + count : ""),
            type,
            color: COLORS[type] || COLORS.other,
            clips: [],
            armed: true,
            muted: false
        };
        lanes.forEach((l) => (l.armed = false));
        lanes.push(lane);
        renderLanes();
        updateCount();
        status("Added " + lane.name);
    }

    function removeLane(id) {
        lanes = lanes.filter((l) => l.id !== id);
        renderLanes();
        updateCount();
        updateTotals();
    }

    function armLane(id) {
        lanes.forEach((l) => (l.armed = l.id === id));
        renderLanes();
    }

    function renameLane(id, name) {
        const l = lanes.find((x) => x.id === id);
        if (l && name.trim()) {
            l.name = name.trim();
            renderLanes();
        }
    }

    function renderLanes() {
        if (!els.lanes) return;
        els.lanes.innerHTML = "";
        const w = timelineWidth();

        if (els.empty) {
            els.empty.classList.toggle("hidden", lanes.length > 0 || !!beat.buffer);
        }

        if (beat.buffer) {
            const row = document.createElement("div");
            row.className = "studio-lane studio-lane-beat";
            row.innerHTML =
                '<div class="studio-lane-head">' +
                '<span class="lane-color" style="background:' + COLORS.beat + '"></span>' +
                '<div class="lane-meta"><strong>Beat</strong><small>' + escapeHtml(beat.name || "") + "</small></div>" +
                "</div><div class=\"studio-lane-track\"></div>";
            const track = row.querySelector(".studio-lane-track");
            track.style.minWidth = w + "px";
            const clip = document.createElement("div");
            clip.className = "studio-clip beat-clip";
            clip.style.left = "0px";
            clip.style.width = Math.max(4, beat.duration * pxPerSec()) + "px";
            clip.style.background = COLORS.beat;
            clip.innerHTML = "<span>" + escapeHtml(beat.name || "Beat") + "</span>";
            track.appendChild(clip);
            els.lanes.appendChild(row);
            drawClipWave(clip, beat.buffer);
        }

        lanes.forEach((lane) => {
            const row = document.createElement("div");
            row.className = "studio-lane" + (lane.armed ? " is-armed" : "");
            row.dataset.laneId = lane.id;
            row.innerHTML =
                '<div class="studio-lane-head">' +
                '<span class="lane-color" style="background:' + lane.color + '"></span>' +
                '<div class="lane-meta">' +
                '<input class="lane-name-input" value="' + escapeAttr(lane.name) + '">' +
                "<small>" + lane.type + (lane.armed ? " · armed" : "") + "</small>" +
                "</div>" +
                '<div class="lane-btns">' +
                '<button type="button" class="lane-btn' + (lane.armed ? " is-on" : "") + '" data-act="arm" title="Arm for record">R</button>' +
                '<button type="button" class="lane-btn" data-act="del" title="Delete lane">×</button>' +
                "</div></div>" +
                '<div class="studio-lane-track"></div>';

            const track = row.querySelector(".studio-lane-track");
            track.style.minWidth = w + "px";

            lane.clips.forEach((c) => {
                const el = document.createElement("div");
                el.className = "studio-clip";
                el.style.left = c.start * pxPerSec() + "px";
                el.style.width = Math.max(4, c.duration * pxPerSec()) + "px";
                el.style.background = lane.color;
                el.innerHTML = "<span>" + escapeHtml(c.name) + "</span>";
                el.title = c.name + " @ " + fmt(c.start);
                track.appendChild(el);
                if (c.buffer) drawClipWave(el, c.buffer);
            });

            row.querySelector('[data-act="arm"]').addEventListener("click", () => armLane(lane.id));
            row.querySelector('[data-act="del"]').addEventListener("click", () => {
                if (confirm("Delete lane \u201c" + lane.name + "\u201d?")) removeLane(lane.id);
            });
            row.querySelector(".lane-name-input").addEventListener("change", (e) => {
                renameLane(lane.id, e.target.value);
            });

            track.addEventListener("click", (e) => {
                if (isRecording) return;
                if (e.target.closest(".studio-clip")) return;
                const scrollHost = track.closest(".studio-lanes") || track;
                // position relative to track content
                const rect = track.getBoundingClientRect();
                // tracks don't scroll individually - parent studio-timeline may
                const x = e.clientX - rect.left;
                playhead = Math.max(0, x / pxPerSec());
                if (isPlaying) scheduleFrom(playhead);
                updatePlayheadUi();
            });

            els.lanes.appendChild(row);
        });

        drawRuler();
    }

    function drawClipWave(clipEl, buffer) {
        try {
            const canvas = document.createElement("canvas");
            const w = Math.max(2, parseFloat(clipEl.style.width) || 100);
            canvas.width = Math.min(2000, Math.floor(w));
            canvas.height = 36;
            canvas.className = "clip-wave";
            const ctx = canvas.getContext("2d");
            const data = buffer.getChannelData(0);
            const step = Math.max(1, Math.floor(data.length / canvas.width));
            ctx.fillStyle = "rgba(0,0,0,0.25)";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = "rgba(255,255,255,0.5)";
            ctx.beginPath();
            const mid = canvas.height / 2;
            for (let x = 0; x < canvas.width; x++) {
                let min = 1, max = -1;
                const start = x * step;
                for (let i = 0; i < step && start + i < data.length; i++) {
                    const v = data[start + i];
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
                ctx.moveTo(x, mid + min * mid);
                ctx.lineTo(x, mid + max * mid);
            }
            ctx.stroke();
            clipEl.appendChild(canvas);
        } catch (_) {}
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function escapeAttr(s) {
        return escapeHtml(s).replace(/"/g, "&quot;");
    }

    function drawRuler() {
        const canvas = els.ruler;
        if (!canvas) return;
        const w = timelineWidth();
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = w + "px";
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(28 * dpr);
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, 28);
        ctx.fillStyle = "#8b8b9a";
        ctx.font = "10px Inter, system-ui, sans-serif";
        const dur = totalDuration();
        for (let t = 0; t <= dur + 1; t++) {
            const x = t * pxPerSec();
            const major = t % 5 === 0;
            ctx.strokeStyle = major ? "#34343f" : "#26262f";
            ctx.beginPath();
            ctx.moveTo(x + 0.5, major ? 8 : 16);
            ctx.lineTo(x + 0.5, 28);
            ctx.stroke();
            if (major) ctx.fillText(fmt(t).replace(/\.0$/, ""), x + 4, 10);
        }
    }

    function updatePlayheadUi() {
        const x = playhead * pxPerSec();
        if (els.playheadEl) els.playheadEl.style.transform = "translateX(" + x + "px)";
        if (els.trCur) els.trCur.textContent = fmt(playhead);
        const dur = totalDuration();
        if (els.trTot) els.trTot.textContent = fmt(beat.duration || dur);
        if (els.trScrub && dur > 0) {
            els.trScrub.max = Math.max(1, Math.floor(dur * 1000));
            els.trScrub.value = Math.floor(playhead * 1000);
        }
    }

    function updateTotals() {
        updatePlayheadUi();
        drawRuler();
    }

    function updateCount() {
        if (els.trackCount) els.trackCount.textContent = lanes.length + " / " + MAX_LANES;
    }

    function refreshRoles() {
        let vocalClip = null;
        const mainLane = lanes.find((l) => l.type === "main" && l.clips.length);
        const anyLane = lanes.find((l) => l.clips.length);
        const lane = mainLane || anyLane;
        if (lane) vocalClip = lane.clips[lane.clips.length - 1];
        if (els.roleVocal) els.roleVocal.textContent = "Vocal: " + (vocalClip ? vocalClip.name : "—");
        if (els.roleBeat) els.roleBeat.textContent = "Beat: " + (beat.name || "—");
    }

    function stopSources() {
        activeSources.forEach((s) => {
            try { s.stop(); } catch (_) {}
        });
        activeSources = [];
    }

    function scheduleFrom(offset, gainValue) {
        const ctx = ensureCtx();
        stopSources();
        const startAt = ctx.currentTime;
        const g = gainValue == null ? 1 : gainValue;

        if (beat.buffer && offset < beat.buffer.duration) {
            const src = ctx.createBufferSource();
            src.buffer = beat.buffer;
            const gain = ctx.createGain();
            gain.gain.value = g;
            src.connect(gain);
            gain.connect(ctx.destination);
            src.start(startAt, offset);
            activeSources.push(src);
        }

        lanes.forEach((lane) => {
            if (lane.muted) return;
            lane.clips.forEach((clip) => {
                if (!clip.buffer) return;
                const clipEnd = clip.start + clip.duration;
                if (offset >= clipEnd) return;

                const src = ctx.createBufferSource();
                src.buffer = clip.buffer;
                const gain = ctx.createGain();
                gain.gain.value = g;
                src.connect(gain);
                gain.connect(ctx.destination);

                if (offset <= clip.start) {
                    const when = startAt + (clip.start - offset);
                    src.start(when, 0);
                } else {
                    const into = offset - clip.start;
                    src.start(startAt, into);
                }
                activeSources.push(src);
            });
        });

        playStartCtx = startAt;
        playStartOffset = offset;
    }

    function play() {
        if (isRecording) return;
        if (!beat.buffer && !lanes.some((l) => l.clips.length)) {
            status("Load a beat or record first");
            return;
        }
        ensureCtx();
        if (isPlaying) {
            const now = playStartOffset + (audioCtx.currentTime - playStartCtx);
            stopSources();
            isPlaying = false;
            playhead = Math.min(now, totalDuration());
            els.trPlay?.classList.remove("is-active");
            if (animFrame) cancelAnimationFrame(animFrame);
            updatePlayheadUi();
            status("Paused");
            return;
        }
        scheduleFrom(playhead);
        isPlaying = true;
        els.trPlay?.classList.add("is-active");
        status("Playing");
        tick();
    }

    function hardStop() {
        stopSources();
        isPlaying = false;
        if (isRecording) stopRecording(false);
        playhead = 0;
        els.trPlay?.classList.remove("is-active");
        if (animFrame) cancelAnimationFrame(animFrame);
        updatePlayheadUi();
        status("Stopped");
    }

    function tick() {
        if (!isPlaying || !audioCtx) return;
        playhead = playStartOffset + (audioCtx.currentTime - playStartCtx);
        const dur = totalDuration();
        if (playhead >= dur) {
            if (els.trLoop?.checked) {
                playhead = 0;
                scheduleFrom(0);
            } else {
                hardStop();
                return;
            }
        }
        updatePlayheadUi();
        animFrame = requestAnimationFrame(tick);
    }

    async function startRecording() {
        if (isRecording) return;
        const armed = lanes.find((l) => l.armed);
        if (!armed) {
            status("Arm a lane first (R button)");
            return;
        }

        // "Raw" = no browser processing (can be hissy/quiet on laptop mics).
        // Default = clean: NS + EC + AGC — phones often ignore these; desktops need them.
        const raw = !!(els.trRawMic && els.trRawMic.checked);

        try {
            ensureCtx();
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: { ideal: 1 },
                    sampleRate: { ideal: 48000 },
                    echoCancellation: raw ? false : true,
                    noiseSuppression: raw ? false : true,
                    autoGainControl: raw ? false : true
                }
            });
        } catch (err) {
            // Fallback without ideal constraints
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (err2) {
                status("Mic permission denied");
                console.warn(err2);
                return;
            }
        }

        if (els.trCountIn?.checked) {
            status("Count-in…");
            await countIn(2);
        }

        recChunks = [];
        recLaneId = armed.id;
        recStartOffset = playhead;

        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : MediaRecorder.isTypeSupported("audio/webm")
              ? "audio/webm"
              : "";

        try {
            const opts = mime ? { mimeType: mime } : {};
            // Higher bitrate = less coding noise on quiet laptop mics
            if (mime.indexOf("opus") !== -1) opts.audioBitsPerSecond = 192000;
            mediaRecorder = new MediaRecorder(mediaStream, opts);
        } catch (e) {
            try {
                mediaRecorder = new MediaRecorder(mediaStream);
            } catch (e2) {
                status("Recorder not supported");
                mediaStream.getTracks().forEach((t) => t.stop());
                return;
            }
        }

        mediaRecorder.ondataavailable = (e) => {
            if (e.data?.size) recChunks.push(e.data);
        };
        mediaRecorder.onstop = onRecordStop;

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const micSrc = audioCtx.createMediaStreamSource(mediaStream);
        micSrc.connect(analyser);
        runMeter();

        mediaRecorder.start(50);
        isRecording = true;
        document.body.classList.add("is-recording");
        els.trRecord?.classList.add("is-hot");

        stopSources();
        isPlaying = false;
        // Play beat quieter while recording to reduce speaker→mic bleed on laptops
        scheduleFrom(recStartOffset, 0.55);
        isPlaying = true;
        els.trPlay?.classList.add("is-active");
        playStartOffset = recStartOffset;
        playStartCtx = audioCtx.currentTime;
        status("Recording from " + fmt(recStartOffset) + (raw ? " (raw mic)" : ""));
        tick();
    }

    function countIn(seconds) {
        return new Promise((resolve) => {
            let left = seconds;
            status("Count-in " + left + "…");
            countInTimer = setInterval(() => {
                left--;
                if (left <= 0) {
                    clearInterval(countInTimer);
                    countInTimer = null;
                    resolve();
                } else {
                    status("Count-in " + left + "…");
                }
            }, 1000);
        });
    }

    function stopRecording(save) {
        if (!isRecording || !mediaRecorder) return;
        if (save === false) {
            mediaRecorder.onstop = null;
            try { mediaRecorder.stop(); } catch (_) {}
            cleanupRecStream();
            isRecording = false;
            document.body.classList.remove("is-recording");
            els.trRecord?.classList.remove("is-hot");
            return;
        }
        try { mediaRecorder.stop(); } catch (_) {}
    }

    async function onRecordStop() {
        cleanupRecStream();
        isRecording = false;
        document.body.classList.remove("is-recording");
        els.trRecord?.classList.remove("is-hot");

        if (isPlaying && audioCtx) {
            playhead = playStartOffset + (audioCtx.currentTime - playStartCtx);
            stopSources();
            isPlaying = false;
            els.trPlay?.classList.remove("is-active");
            if (animFrame) cancelAnimationFrame(animFrame);
        }

        if (!recChunks.length) {
            status("Empty recording");
            return;
        }

        const blob = new Blob(recChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
        const lane = lanes.find((l) => l.id === recLaneId);
        if (!lane) return;

        const ctx = ensureCtx();
        let buffer = null;
        let duration = 0;
        try {
            const ab = await blob.arrayBuffer();
            buffer = await ctx.decodeAudioData(ab.slice(0));
            duration = buffer.duration;
            // Lift quiet laptop takes; light high-pass to cut DC / rumble hiss floor
            buffer = polishTake(buffer);
        } catch (e) {
            console.warn("decode rec", e);
            duration = Math.max(0.1, (recChunks.length * 50) / 1000);
        }

        const takeNum = lane.clips.length + 1;
        // Prefer polished WAV for pipeline; keep original blob type as fallback name
        let file;
        if (buffer) {
            const wav = audioBufferToWav(buffer);
            file = new File(
                [wav],
                lane.name.replace(/\s+/g, "_") + "_take" + takeNum + ".wav",
                { type: "audio/wav" }
            );
        } else {
            file = new File(
                [blob],
                lane.name.replace(/\s+/g, "_") + "_take" + takeNum + ".webm",
                { type: blob.type }
            );
        }

        lane.clips.push({
            id: uid(),
            name: "Take " + takeNum,
            blob: file,
            file,
            buffer,
            start: recStartOffset,
            duration
        });

        renderLanes();
        updateTotals();
        refreshRoles();
        status("Saved Take " + takeNum + " @ " + fmt(recStartOffset));
    }

    /** Normalize peak ~ -6 dBFS and apply a gentle high-pass (cuts jack/DC rumble). */
    function polishTake(buffer) {
        const sr = buffer.sampleRate;
        const ch = buffer.numberOfChannels;
        const len = buffer.length;
        // Copy to new buffer
        const out = ensureCtx().createBuffer(ch, len, sr);
        let peak = 0;
        for (let c = 0; c < ch; c++) {
            const src = buffer.getChannelData(c);
            for (let i = 0; i < len; i++) {
                const v = Math.abs(src[i]);
                if (v > peak) peak = v;
            }
        }
        // One-pole high-pass ~80 Hz
        const rc = 1 / (2 * Math.PI * 80);
        const dt = 1 / sr;
        const alpha = rc / (rc + dt);
        const target = 0.5; // ~ -6 dBFS
        const gain = peak > 0.001 ? Math.min(8, target / peak) : 1;
        for (let c = 0; c < ch; c++) {
            const src = buffer.getChannelData(c);
            const dst = out.getChannelData(c);
            let prevIn = 0, prevOut = 0;
            for (let i = 0; i < len; i++) {
                const x = src[i];
                const y = alpha * (prevOut + x - prevIn);
                prevIn = x;
                prevOut = y;
                dst[i] = y * gain;
            }
        }
        return out;
    }

    function cleanupRecStream() {
        stopMeter();
        if (mediaStream) {
            mediaStream.getTracks().forEach((t) => t.stop());
            mediaStream = null;
        }
        analyser = null;
    }

    function runMeter() {
        if (!analyser || !els.trMeter) return;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const loop = () => {
            if (!analyser) return;
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                const v = Math.abs(data[i] - 128) / 128;
                if (v > peak) peak = v;
            }
            els.trMeter.style.width = Math.min(100, peak * 150) + "%";
            meterRaf = requestAnimationFrame(loop);
        };
        loop();
    }

    function stopMeter() {
        if (meterRaf) cancelAnimationFrame(meterRaf);
        meterRaf = null;
        if (els.trMeter) els.trMeter.style.width = "0%";
    }

    function toggleRecord() {
        if (isRecording) stopRecording(true);
        else startRecording();
    }

    async function renderLaneToFile(lane) {
        if (!lane.clips.length) return null;
        const sr = beat.buffer?.sampleRate || lane.clips[0].buffer?.sampleRate || 44100;
        const dur = Math.max(
            beat.duration || 0,
            ...lane.clips.map((c) => c.start + c.duration)
        );
        const offline = new OfflineAudioContext(1, Math.ceil(dur * sr) || sr, sr);

        for (const clip of lane.clips) {
            if (!clip.buffer) continue;
            const src = offline.createBufferSource();
            src.buffer = clip.buffer;
            src.connect(offline.destination);
            src.start(Math.max(0, clip.start));
        }

        const rendered = await offline.startRendering();
        const wav = audioBufferToWav(rendered);
        return new File([wav], lane.name.replace(/\s+/g, "_") + "_comp.wav", { type: "audio/wav" });
    }

    function audioBufferToWav(buffer) {
        const sr = buffer.sampleRate;
        const samples = buffer.getChannelData(0);
        const dataLength = samples.length * 2;
        const ab = new ArrayBuffer(44 + dataLength);
        const view = new DataView(ab);
        const writeStr = (o, s) => {
            for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
        };
        writeStr(0, "RIFF");
        view.setUint32(4, 36 + dataLength, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sr, true);
        view.setUint32(28, sr * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeStr(36, "data");
        view.setUint32(40, dataLength, true);
        let off = 44;
        for (let i = 0; i < samples.length; i++, off += 2) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        return new Blob([ab], { type: "audio/wav" });
    }

    async function sendToPipeline() {
        if (!beat.file && !beat.buffer) {
            status("Load a beat first");
            return;
        }
        const mainLane =
            lanes.find((l) => l.type === "main" && l.clips.length) ||
            lanes.find((l) => l.clips.length);
        if (!mainLane) {
            status("Record at least one vocal take");
            return;
        }

        status("Rendering vocal for pipeline…");
        try {
            const vocalFile = await renderLaneToFile(mainLane);
            if (!vocalFile) {
                status("Nothing to send");
                return;
            }

            let beatFile = beat.file;
            if (!beatFile && beat.buffer) {
                const wav = audioBufferToWav(beat.buffer);
                beatFile = new File([wav], (beat.name || "beat") + ".wav", { type: "audio/wav" });
            }

            assignFile(els.vocalInput, vocalFile, els.vocalFileName);
            assignFile(els.beatFileInput, beatFile, els.beatFileName);
            refreshRoles();
            setMode("pipeline");
            status("Sent to Pipeline — continue to Alignment");
            $("upload-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (e) {
            console.warn(e);
            status("Render failed");
        }
    }

    function bindPlayheadScrub() {
        if (!els.rulerScroll) return;
        els.rulerScroll.addEventListener("click", (e) => {
            if (isRecording) return;
            const rect = els.rulerScroll.getBoundingClientRect();
            const x = e.clientX - rect.left + els.rulerScroll.scrollLeft;
            playhead = Math.max(0, x / pxPerSec());
            if (isPlaying) scheduleFrom(playhead);
            updatePlayheadUi();
        });
    }

    function init() {
        cache();

        const minMs = 600;
        const t0 = performance.now();
        const done = () => {
            setTimeout(hidePreloader, Math.max(0, minMs - (performance.now() - t0)));
        };
        if (document.readyState === "complete") done();
        else window.addEventListener("load", done);

        document.querySelectorAll(".mode-btn").forEach((btn) => {
            btn.addEventListener("click", () => setMode(btn.dataset.mode));
        });

        let saved = "pipeline";
        try {
            saved = localStorage.getItem("vv-mode") || "pipeline";
        } catch (_) {}
        setMode(saved);

        els.loadBeat?.addEventListener("click", () => els.beatInput?.click());
        els.beatInput?.addEventListener("change", () => {
            const f = els.beatInput.files?.[0];
            if (f) loadBeatFile(f);
            els.beatInput.value = "";
        });
        els.addLane?.addEventListener("click", () => addLane(els.laneType?.value));
        els.toPipeline?.addEventListener("click", sendToPipeline);

        els.trPlay?.addEventListener("click", play);
        els.trStop?.addEventListener("click", hardStop);
        els.trRecord?.addEventListener("click", toggleRecord);

        els.trScrub?.addEventListener("input", () => {
            if (isRecording) return;
            playhead = (+els.trScrub.value) / 1000;
            if (isPlaying) scheduleFrom(playhead);
            updatePlayheadUi();
        });

        bindPlayheadScrub();
        updateCount();
        refreshRoles();
        status("Ready");

        // Redraw timeline when rotating phone / resizing
        let resizeTimer = null;
        window.addEventListener("resize", () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (els.shell?.classList.contains("mode-studio")) {
                    renderLanes();
                    drawRuler();
                    updatePlayheadUi();
                }
            }, 120);
        });

        window.VocalVaultDAW = {
            setMode,
            addLane,
            loadBeatFile,
            lanes,
            beat,
            sendToPipeline,
            MAX_LANES
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
