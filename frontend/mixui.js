/* =========================================================
   VOCAL VAULT — MIX & MASTER (UI extras)

   1. Loudness target   Streaming, Apple Music, balanced or loud. Read by
                        automix.js as state.masterTargetLufs.
   2. Fair comparison   "Before" (your vocal and beat, untouched) against
                        "After" (the finished master), both played at the
                        SAME loudness. Louder always sounds better, so
                        without this the comparison tells you nothing.
   3. Export            24-bit WAV, or 16-bit WAV with dither.
   ========================================================= */

// ---------------------------------------------------------
// Pure functions (also used by the tests)
// ---------------------------------------------------------

const LOUDNESS_TARGETS = [
    { lufs: -12, label: "Balanced, −12 LUFS (default)" },
    { lufs: -14, label: "Streaming standard, −14 LUFS (Spotify, YouTube, Tidal)" },
    { lufs: -16, label: "Apple Music / Sound Check, −16 LUFS" },
    { lufs: -9,  label: "Loud, −9 LUFS (club, hip-hop, hard limiting)" }
];

// Gains (<= 1) that bring both versions to the loudness of the quieter one.
function matchedGains(lufsA, lufsB) {
    const ref = Math.min(lufsA, lufsB);
    return {
        gainA: Math.pow(10, (ref - lufsA) / 20),
        gainB: Math.pow(10, (ref - lufsB) / 20),
        referenceLufs: ref
    };
}

// channels: array of Float32Array. bits: 16 or 24. 16-bit gets triangular dither
// so quiet reverb tails fade out smoothly instead of turning into grit.
function encodeWav(channels, sampleRate, bits, seed) {

    const nch = channels.length, n = channels[0].length, bytes = bits / 8;
    const dataSize = n * nch * bytes;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const text = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

    text(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); text(8, "WAVE"); text(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * bytes, true);
    v.setUint16(32, nch * bytes, true); v.setUint16(34, bits, true);
    text(36, "data"); v.setUint32(40, dataSize, true);

    let a = (seed || 12345) >>> 0;
    const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

    let o = 44;
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < nch; c++) {
            const x = Math.max(-1, Math.min(1, channels[c][i]));
            if (bits === 24) {
                const s = Math.round(x * 8388607);
                v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255);
                o += 3;
            } else {
                const dither = rand() - rand();                    // triangular, +-1 LSB
                const s = Math.max(-32768, Math.min(32767, Math.round(x * 32767 + dither)));
                v.setInt16(o, s, true); o += 2;
            }
        }
    }
    return buf;
}

// ---------------------------------------------------------
// Page wiring
// ---------------------------------------------------------

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", () => {

    const $ = (id) => document.getElementById(id);
    const targetSelect = $("master-target");
    if (!targetSelect) return;

    const S = window.VocalVaultState;
    const formatSelect = $("export-format");
    const compare = $("mix-compare"), compareInfo = $("mix-compare-info");
    const playBefore = $("mix-play-before"), playAfter = $("mix-play-after"), stopButton = $("mix-stop");
    const download = $("mix-download");

    // ---- file name (user picks it; built in the page's own .mix-option style) ----
    let nameInput = $("export-name");
    if (!nameInput) {
        const field = document.createElement("div");
        field.className = "mix-option";
        field.innerHTML = '<label for="export-name">Song name</label>';
        nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.id = "export-name";
        nameInput.placeholder = "Name your song (optional)";
        nameInput.maxLength = 80;
        nameInput.autocomplete = "off";
        field.appendChild(nameInput);
        const anchor = formatSelect.closest(".mix-option");
        if (anchor) anchor.after(field);
        else download.parentNode.insertBefore(field, download);
    }

    const cleanFileName = () => nameInput.value
        .replace(/\.wav$/i, "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
        .replace(/\s+/g, " ")
        .replace(/^[.\s]+|[.\s]+$/g, "")
        .slice(0, 80);

    const updateFileName = () => {
        const bits = parseInt(formatSelect.value, 10);
        download.setAttribute("download", (cleanFileName() || `vocal-vault-master-${bits}bit`) + ".wav");
    };
    nameInput.addEventListener("input", updateFileName);

    // ---- loudness target ----
    LOUDNESS_TARGETS.forEach((t) => {
        const o = document.createElement("option");
        o.value = String(t.lufs); o.textContent = t.label;
        targetSelect.appendChild(o);
    });
    const applyTarget = () => { S.masterTargetLufs = parseFloat(targetSelect.value); };
    targetSelect.addEventListener("change", applyTarget);
    applyTarget();

    // optional higher harmony layer (0 = off). Read by automix.js.
    const harmonySelect = $("harmony-select");
    if (harmonySelect) {
        const applyHarmony = () => { S.harmonyDegrees = parseInt(harmonySelect.value, 10) || 0; };
        harmonySelect.addEventListener("change", applyHarmony);
        applyHarmony();
    }

    // ---- export ----
    let downloadUrl = null;

    function refreshDownload() {
        const mix = S.mixBuffer;
        if (!mix) return;
        const bits = parseInt(formatSelect.value, 10);
        const channels = [];
        for (let c = 0; c < mix.numberOfChannels; c++) channels.push(mix.getChannelData(c));
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(new Blob([encodeWav(channels, mix.sampleRate, bits)], { type: "audio/wav" }));
        download.href = downloadUrl;
        updateFileName();
        download.textContent = `Download final mix (${bits}-bit WAV)`;
        download.classList.remove("hidden");
    }
    formatSelect.addEventListener("change", refreshDownload);

    // ---- matched-loudness comparison ----
    let before = null, after = null, gains = null, nodes = [], playing = null;

    const channelsOf = (b) => { const o = []; for (let c = 0; c < b.numberOfChannels; c++) o.push(b.getChannelData(c)); return o; };

    function buildComparison() {

        const Levels = window.VocalVaultLevels, mix = S.mixBuffer;
        if (!Levels || !mix || !S.vocalBuffer || !S.beatBuffer) { compare.classList.add("hidden"); return; }

        const eng = Levels.engine, sr = S.beatBuffer.sampleRate;
        const vocal = channelsOf(S.vocalBuffer).map((c) => eng.resample(c, S.vocalBuffer.sampleRate, sr));
        const beat = channelsOf(S.beatBuffer);

        // "before" = exactly what was uploaded, summed at the chosen alignment, no processing
        const plan = eng.plan(vocal, beat, sr, S.vocalOffset || 0, { mode: "off" });
        const raw = eng.mix(vocal, beat, sr, plan, {});
        const lufs = (ch, rate) => eng.integrated(eng.momentary(eng.hopPowers(ch, rate)));

        const lufsBefore = lufs(raw.channels, sr), lufsAfter = lufs(channelsOf(mix), mix.sampleRate);
        const m = matchedGains(lufsBefore, lufsAfter);
        gains = { before: m.gainA, after: m.gainB };

        const ctx = S.audioContext;
        before = ctx.createBuffer(2, raw.channels[0].length, sr);
        before.copyToChannel(raw.channels[0], 0); before.copyToChannel(raw.channels[1], 1);
        after = mix;

        compareInfo.textContent =
            `Before measures ${lufsBefore.toFixed(1)} LUFS and the master ${lufsAfter.toFixed(1)} LUFS. ` +
            `Both play at ${m.referenceLufs.toFixed(1)} LUFS here, so you are hearing the processing and not just the volume.`;
        compare.classList.remove("hidden");
    }

    function stopPlayback() {
        nodes.forEach((n) => { try { n.onended = null; n.stop(); } catch (e) { /* stopped */ } });
        nodes = []; playing = null;
        playBefore.classList.remove("is-active"); playAfter.classList.remove("is-active");
    }

    function startPlayback(which) {

        const buf = which === "after" ? after : before;
        if (!buf) return;

        const ctx = S.audioContext;
        if (ctx.state === "suspended") ctx.resume();

        let pos = playing ? playing.pos + (ctx.currentTime - playing.t0) : null;
        if (pos === null) {
            const d = S.vocalBuffer.getChannelData(0); let first = 0, pk = 0;
            for (let i = 0; i < d.length; i += 64) pk = Math.max(pk, Math.abs(d[i]));
            for (let i = 0; i < d.length; i += 64) if (Math.abs(d[i]) > pk * 0.1) { first = i / S.vocalBuffer.sampleRate; break; }
            pos = Math.max(0, first + (S.vocalOffset || 0) - 1);
        }
        stopPlayback();

        const src = ctx.createBufferSource(); src.buffer = buf;
        const g = ctx.createGain(); g.gain.value = which === "after" ? gains.after : gains.before;
        src.connect(g).connect(ctx.destination);
        const now = ctx.currentTime + 0.05;
        src.start(now, Math.min(pos, Math.max(0, buf.duration - 0.1)));
        src.onended = stopPlayback;

        nodes = [src]; playing = { pos, t0: now };
        (which === "after" ? playAfter : playBefore).classList.add("is-active");
        (which === "after" ? playBefore : playAfter).classList.remove("is-active");
    }

    playBefore.addEventListener("click", () => startPlayback("before"));
    playAfter.addEventListener("click", () => startPlayback("after"));
    stopButton.addEventListener("click", stopPlayback);

    // automix.js (via script.js) announces a finished mix
    window.addEventListener("vv-mix-ready", () => {
        stopPlayback();
        refreshDownload();
        try { buildComparison(); } catch (error) { console.error(error); compare.classList.add("hidden"); }
    });
});

if (typeof module !== "undefined") {
    module.exports = { encodeWav, matchedGains, LOUDNESS_TARGETS };
}

/* Style / Polish helpers */
(function () {
    function updateStyleHint() {
        const sel = document.getElementById("mix-style");
        const hint = document.getElementById("mix-style-hint");
        const P = window.VocalVaultPresets;
        if (!sel || !hint || !P) return;
        const list = P.listStyles();
        const found = list.find((s) => s.id === sel.value);
        if (found) hint.textContent = found.blurb;
        // Suggest loudness when style changes (user can still override)
        const recipe = P.resolve(sel.value, (document.getElementById("mix-polish") || {}).value || "radio");
        const target = document.getElementById("master-target");
        if (target && recipe.suggestedLufs != null) {
            const want = String(recipe.suggestedLufs);
            for (const opt of target.options) {
                if (opt.value === want || opt.value === recipe.suggestedLufs) {
                    target.value = opt.value;
                    break;
                }
            }
            // mixui may use data attributes - try matching by value as number
            for (const opt of target.options) {
                if (parseFloat(opt.value) === recipe.suggestedLufs) {
                    target.value = opt.value;
                    break;
                }
            }
        }
    }
    document.addEventListener("DOMContentLoaded", () => {
        const style = document.getElementById("mix-style");
        const polish = document.getElementById("mix-polish");
        if (style) style.addEventListener("change", updateStyleHint);
        if (polish) polish.addEventListener("change", updateStyleHint);
        updateStyleHint();
    });
})();
