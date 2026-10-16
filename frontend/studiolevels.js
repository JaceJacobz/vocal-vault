/**
 * Vocal Vault — Studio lane levels
 *
 * How loud should an adlib, tag, harmony or soft intro sit against the lead?
 *
 * The first version put a fixed number of dB on the RECORDED level ("Quieter" = recorded - 6.5 dB). That is not
 * "a bit under the lead": an adlib that was already recorded softly became even softer, and "Same" left a soft intro
 * exactly as soft as it was recorded. It also measured loudness as the average over the whole clip INCLUDING silence,
 * so a short, dense adlib clip looked louder than a long lead take full of pauses, and Auto turned it down.
 *
 * Now every relative choice is measured the way a listener hears it: the loudness of the clip WHILE IT IS SOUNDING
 * (silence and breaths ignored), compared with the lead's loudness while it is singing.
 *
 *   Relatively lower     a bit under the lead
 *   Relatively higher    a bit over the lead
 *   Same as the lead     level with the lead
 *   Keep as recorded     no change at all, exactly as it was recorded
 *   Auto                 a typical place for this kind of lane (adlib, tag, harmony ...)
 *   Mute
 *
 * Plain functions only, so it can be tested in Node.
 */
(function (root) {
    "use strict";

    const FRAME_SEC = 0.05;
    const ACTIVE_WINDOW_DB = 15;           // "sounding" = within 15 dB of the clip's own loud parts
    const MIN_ACTIVE_SEC = 0.2;            // less than this and there is nothing to measure
    const MAX_BOOST_DB = 18, MAX_CUT_DB = -24;

    const REL_DB = { lower: -3.5, higher: 3, match: 0 };
    const AUTO_REL_DB = { main: 0, adlib: -6, tag: -7.5, harmony: -4.5, other: -3.5 };

    const MIX_LEVELS = {
        auto: { label: "Auto", blurb: "Vocal Vault places this lane where that kind of lane usually sits against the lead" },
        lower: { label: "Relatively lower", blurb: "A bit under the lead (" + Math.abs(REL_DB.lower) + " dB), measured against how loud the lead really sounds" },
        higher: { label: "Relatively higher", blurb: "A bit over the lead (+" + REL_DB.higher + " dB), so it shines out" },
        match: { label: "Same as the lead", blurb: "Brought to the same loudness as the lead, e.g. a soft intro that should not sound smaller" },
        keep: { label: "Keep as recorded", blurb: "No level change: exactly the volume it was recorded at" },
        mute: { label: "Mute", blurb: "Skip this lane in the mix" }
    };
    // names saved by the first version
    const LEGACY = { lead: "keep", same: "keep", quieter: "lower", louder: "higher" };

    function normalizeMode(mode) {
        if (MIX_LEVELS[mode]) return mode;
        if (LEGACY[mode]) return LEGACY[mode];
        return "auto";
    }

    const frameCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;

    // 50 ms loudness (dB, RMS) of one channel
    function frameDb(data, sr) {
        if (frameCache && frameCache.has(data)) { const c = frameCache.get(data); if (c.sr === sr) return c.db; }
        const hop = Math.max(1, Math.round(FRAME_SEC * sr)), frames = Math.floor(data.length / hop), out = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            let s = 0; const a = f * hop;
            for (let i = a; i < a + hop; i++) s += data[i] * data[i];
            out[f] = 10 * Math.log10(s / hop + 1e-14);
        }
        if (frameCache) frameCache.set(data, { sr: sr, db: out });
        return out;
    }

    // clips: [{ data: Float32Array, sr }]. Loudness while sounding, over all clips of the lane.
    function activeLevel(clips) {
        const all = [];
        for (const c of clips || []) { const db = frameDb(c.data, c.sr); for (let i = 0; i < db.length; i++) if (db[i] > -90) all.push(db[i]); }
        if (!all.length) return { db: -120, activeSec: 0 };
        const sorted = Float32Array.from(all).sort();
        const top = sorted[Math.floor((sorted.length - 1) * 0.95)];
        let p = 0, n = 0;
        for (const v of all) if (v >= top - ACTIVE_WINDOW_DB) { p += Math.pow(10, v / 10); n++; }
        return { db: 10 * Math.log10(p / n), activeSec: n * FRAME_SEC };
    }

    const signed = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1);

    // The gain to put on a lane. leadDb: the lead's activeLevel().db (null/-120 if there is no lead).
    function resolveGain(a) {
        const mode = normalizeMode(a.mode);
        if (mode === "mute") return { db: null, lin: 0, key: "mute", label: "Mute" };
        if (mode === "keep") return { db: 0, lin: 1, key: mode, label: "Keep as recorded" };
        if (a.isLead) return { db: 0, lin: 1, key: mode, label: "Lead (as recorded)" };

        const haveRef = a.leadDb != null && a.leadDb > -100 && a.laneDb > -100 && a.laneActiveSec >= MIN_ACTIVE_SEC;
        if (!haveRef) return { db: 0, lin: 1, key: mode, label: "As recorded (nothing to compare with)", noReference: true };

        const rel = mode === "auto" ? (AUTO_REL_DB[a.type] != null ? AUTO_REL_DB[a.type] : -3.5) : REL_DB[mode];
        let db = (a.leadDb + rel) - a.laneDb, clamped = false;
        if (db > MAX_BOOST_DB) { db = MAX_BOOST_DB; clamped = true; }
        if (db < MAX_CUT_DB) { db = MAX_CUT_DB; clamped = true; }
        const where = rel === 0 ? "level with the lead" : (Math.abs(rel) + " dB " + (rel < 0 ? "under" : "over") + " the lead");
        return {
            db: db, lin: Math.pow(10, db / 20), key: mode, clamped: clamped, relDb: rel,
            label: MIX_LEVELS[mode].label + ": " + where + " (" + signed(db) + " dB)" + (clamped ? " — limited, the take is very different in level" : "")
        };
    }

    // ---------------------------------------------------------
    // For the pipeline: what the LEAD sounds like after the chain has processed the whole composite.
    // The chain (EQ, compressors, warmth) changes the loudness of the composite; the lead alone was never run through it.
    // Estimate the chain's gain over time from the composite (raw vs finished) and apply it to the lead-only reference.
    // hopPowers: the level engine's function, (channels, sr) -> power per 100 ms hop.
    // ---------------------------------------------------------
    function leadLikeProcessed(leadCh, rawCh, finCh, sr, hopPowers) {
        const pr = hopPowers(rawCh, sr), pf = hopPowers(finCh, sr), n = Math.min(pr.length, pf.length), hopSec = 0.1;
        const g = new Float32Array(n), w = new Float32Array(n);
        for (let j = 0; j < n; j++) {
            if (pr[j] > 1e-9 && pf[j] > 1e-12) { g[j] = 10 * Math.log10(pf[j] / pr[j]); w[j] = pr[j]; }
        }
        // smooth over ~0.5 s, weighted by how much is actually there
        const sm = new Float32Array(n);
        for (let j = 0; j < n; j++) {
            let s = 0, ws = 0;
            for (let k = Math.max(0, j - 2); k <= Math.min(n - 1, j + 2); k++) { s += g[k] * w[k]; ws += w[k]; }
            sm[j] = ws > 0 ? Math.max(-12, Math.min(12, s / ws)) : 0;
        }
        return leadCh.map((x) => {
            const y = new Float32Array(x.length);
            for (let i = 0; i < x.length; i++) {
                const pos = i / sr / hopSec - 0.5, k = Math.floor(pos), f = pos - k;
                const a = sm[Math.max(0, Math.min(n - 1, k))], b = sm[Math.max(0, Math.min(n - 1, k + 1))];
                y[i] = x[i] * Math.pow(10, (a + (b - a) * f) / 20);
            }
            return y;
        });
    }

    const api = { MIX_LEVELS, REL_DB, AUTO_REL_DB, normalizeMode, activeLevel, resolveGain, leadLikeProcessed, frameDb };
    if (typeof window !== "undefined") window.VocalVaultStudioLevels = api;
    if (typeof module !== "undefined") module.exports = api;

})(typeof window !== "undefined" ? window : this);
