/**
 * Vocal Vault — optional fill for missing / thin instruments
 * Analyzes the beat, then synthesizes supportive layers locked to BPM + key.
 * Off by default; only mixes under the real instrumental.
 */
(function () {
    "use strict";

    const MAJOR = [0, 2, 4, 5, 7, 9, 11];
    const MINOR = [0, 2, 3, 5, 7, 8, 10];
    const PROG_MAJOR = [0, 4, 5, 3];
    const PROG_MINOR = [0, 5, 3, 4];

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
    function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    function monoOf(chs) {
        const n = chs[0].length;
        const m = new Float32Array(n);
        for (let c = 0; c < chs.length; c++) {
            const x = chs[c];
            for (let i = 0; i < n; i++) m[i] += x[i] / chs.length;
        }
        return m;
    }

    function rmsDb(x) {
        let e = 0;
        for (let i = 0; i < x.length; i++) e += x[i] * x[i];
        return 10 * Math.log10(Math.max(e / Math.max(1, x.length), 1e-20));
    }

    function bandEnergyDb(mono, sr, lo, hi) {
        const n = mono.length;
        const hpC = Math.exp(-2 * Math.PI * lo / sr);
        const lpC = Math.exp(-2 * Math.PI * hi / sr);
        let h = 0, l = 0, e = 0, cnt = 0;
        const step = Math.max(1, Math.floor(sr / 8000));
        for (let i = 0; i < n; i += step) {
            const x = mono[i];
            h = hpC * h + (1 - hpC) * x;
            const hiP = x - h;
            l = lpC * l + (1 - lpC) * hiP;
            e += l * l;
            cnt++;
        }
        return 10 * Math.log10(Math.max(e / Math.max(1, cnt), 1e-20));
    }

    function onsetStrength(mono, sr, lo, hi) {
        const hop = Math.max(1, Math.round(0.01 * sr));
        const frames = Math.floor(mono.length / hop);
        if (frames < 8) return 0;
        const hpC = Math.exp(-2 * Math.PI * lo / sr);
        const lpC = Math.exp(-2 * Math.PI * hi / sr);
        let h = 0, l = 0, prev = 0, flux = 0, n = 0;
        for (let f = 1; f < frames; f++) {
            let e = 0;
            const a = f * hop, b = Math.min(mono.length, a + hop);
            for (let i = a; i < b; i++) {
                const x = mono[i];
                h = hpC * h + (1 - hpC) * x;
                const hiP = x - h;
                l = lpC * l + (1 - lpC) * hiP;
                e += l * l;
            }
            e = Math.sqrt(e / Math.max(1, b - a));
            if (e > prev) flux += e - prev;
            prev = e;
            n++;
        }
        return n ? flux / n : 0;
    }

    function detectInstruments(beatChannels, sr) {
        const mono = monoOf(beatChannels);
        const full = rmsDb(mono);
        const bands = {
            kick: bandEnergyDb(mono, sr, 40, 100),
            snare: bandEnergyDb(mono, sr, 180, 350),
            bass: bandEnergyDb(mono, sr, 90, 280),
            chord: bandEnergyDb(mono, sr, 350, 900),
            pad: bandEnergyDb(mono, sr, 600, 2000),
            hat: bandEnergyDb(mono, sr, 6000, 12000),
            piano: bandEnergyDb(mono, sr, 400, 2500)
        };
        const onset = {
            kick: onsetStrength(mono, sr, 40, 120),
            snare: onsetStrength(mono, sr, 150, 400),
            hat: onsetStrength(mono, sr, 6000, 12000)
        };

        function status(relDb, onsetVal, onsetThr, energyThr) {
            if (relDb < energyThr - 8 && onsetVal < onsetThr * 0.35) return "missing";
            if (relDb < energyThr - 3 || onsetVal < onsetThr * 0.7) return "thin";
            return "ok";
        }

        const presence = {
            kick: status(bands.kick - full, onset.kick, 0.004, -8),
            snare: status(bands.snare - full, onset.snare, 0.003, -12),
            hat: status(bands.hat - full, onset.hat, 0.002, -18),
            bass: status(bands.bass - full, 0.01, 0.01, -6),
            chord: status(bands.chord - full, 0.01, 0.01, -8),
            pad: status(bands.pad - full, 0.01, 0.01, -12),
            piano: status(bands.piano - full, onset.snare * 0.5, 0.002, -10)
        };

        return { bands: bands, onset: onset, presence: presence, fullDb: full };
    }

    function scaleDegrees(scale) {
        return String(scale || "major").toLowerCase().indexOf("min") >= 0 ? MINOR : MAJOR;
    }

    function progression(scale) {
        return String(scale || "major").toLowerCase().indexOf("min") >= 0 ? PROG_MINOR : PROG_MAJOR;
    }

    function rootMidi(rootPc, octave) {
        return 12 * (octave || 3) + ((rootPc % 12) + 12) % 12;
    }

    function env(t, a, d, s, r, dur) {
        if (t < 0) return 0;
        if (t < a) return t / Math.max(1e-4, a);
        if (t < a + d) return 1 - (1 - s) * ((t - a) / Math.max(1e-4, d));
        if (t < dur - r) return s;
        if (t < dur) return s * (1 - (t - (dur - r)) / Math.max(1e-4, r));
        return 0;
    }

    function synthKick(sr, durSec) {
        const n = Math.max(1, Math.round(durSec * sr));
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const f = 150 * Math.exp(-t * 18) + 45;
            const amp = Math.exp(-t * 9) * (t < 0.002 ? t / 0.002 : 1);
            out[i] = Math.sin(2 * Math.PI * f * t) * amp * 0.9;
            if (t < 0.01) out[i] += (Math.random() * 2 - 1) * Math.exp(-t * 120) * 0.25;
        }
        return out;
    }

    function synthSnare(sr, durSec) {
        const n = Math.max(1, Math.round(durSec * sr));
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 20);
            const noise = (Math.random() * 2 - 1) * Math.exp(-t * 14);
            out[i] = (tone * 0.35 + noise * 0.65) * 0.55;
        }
        return out;
    }

    function synthHat(sr, durSec, open) {
        const n = Math.max(1, Math.round(durSec * sr));
        const out = new Float32Array(n);
        const decay = open ? 8 : 28;
        let hp = 0;
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const noise = Math.random() * 2 - 1;
            hp = noise - hp * 0.95;
            out[i] = hp * Math.exp(-t * decay) * (open ? 0.22 : 0.18);
        }
        return out;
    }

    function synthBassNote(sr, freq, durSec, vel) {
        const n = Math.max(1, Math.round(durSec * sr));
        const out = new Float32Array(n);
        const v = vel != null ? vel : 0.35;
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const amp = env(t, 0.01, 0.08, 0.7, 0.12, durSec) * v;
            const phase = 2 * Math.PI * freq * t;
            out[i] = (Math.sin(phase) * 0.75 + Math.sin(phase * 2) * 0.18 + Math.sin(phase * 3) * 0.07) * amp;
        }
        return out;
    }

    function synthPadChord(sr, freqs, durSec, vel) {
        const n = Math.max(1, Math.round(durSec * sr));
        const out = new Float32Array(n);
        const v = (vel != null ? vel : 0.12) / Math.max(1, freqs.length);
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const amp = env(t, 0.04, 0.2, 0.7, 0.25, durSec) * v;
            let s = 0;
            for (let fi = 0; fi < freqs.length; fi++) {
                const f = freqs[fi];
                const phase = 2 * Math.PI * f * t;
                s += Math.sin(phase) * 0.55 + Math.sin(phase * 2) * 0.25 + Math.sin(phase * 3) * 0.12;
            }
            out[i] = s * amp;
        }
        return out;
    }

    function synthPianoChord(sr, freqs, durSec, vel) {
        const n = Math.max(1, Math.round(durSec * sr));
        const out = new Float32Array(n);
        const v = (vel != null ? vel : 0.14) / Math.max(1, freqs.length);
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const amp = env(t, 0.005, 0.25, 0.35, 0.35, durSec) * v;
            let s = 0;
            for (let fi = 0; fi < freqs.length; fi++) {
                const f = freqs[fi];
                const phase = 2 * Math.PI * f * t;
                s += Math.sin(phase) + 0.4 * Math.sin(phase * 2) + 0.15 * Math.sin(phase * 3);
            }
            out[i] = s * amp;
        }
        return out;
    }

    function synthStrings(sr, freqs, durSec, vel) {
        const n = Math.max(1, Math.round(durSec * sr));
        const out = new Float32Array(n);
        const v = (vel != null ? vel : 0.08) / Math.max(1, freqs.length);
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const amp = env(t, 0.08, 0.3, 0.8, 0.4, durSec) * v;
            let s = 0;
            for (let fi = 0; fi < freqs.length; fi++) {
                const f = freqs[fi];
                const phase = 2 * Math.PI * f * t;
                s += Math.sin(phase) * 0.5 + Math.sin(phase * 2.01) * 0.3 + Math.sin(phase * 3.02) * 0.15;
            }
            out[i] = s * amp;
        }
        return out;
    }

    function placeHit(target, hit, atSample, gain) {
        const g = gain != null ? gain : 1;
        for (let i = 0; i < hit.length; i++) {
            const k = atSample + i;
            if (k < 0 || k >= target.length) continue;
            target[k] += hit[i] * g;
        }
    }

    function simpleChordFreqs(rootPc, scale, barIndex, octave) {
        const degs = scaleDegrees(scale);
        const prog = progression(scale);
        const deg = prog[barIndex % prog.length];
        const root = rootMidi(rootPc, octave);
        const start = degs.indexOf(deg);
        const safeStart = start >= 0 ? start : 0;
        return [0, 2, 4].map(function (off) {
            const idx = (safeStart + off) % degs.length;
            let midi = root + (degs[idx] - degs[safeStart]);
            if (degs[idx] < degs[safeStart]) midi += 12;
            return midiToHz(midi);
        });
    }

    function bassDegreeMidi(rootPc, scale, barIndex) {
        const degs = scaleDegrees(scale);
        const prog = progression(scale);
        const deg = prog[barIndex % prog.length];
        return rootMidi(rootPc, 2) + deg;
    }

    function fillMissing(beatChannels, sr, options) {
        const o = Object.assign({
            bpm: 90,
            rootPc: 0,
            scale: "major",
            strength: 0.55
        }, options || {});

        const report = [];
        const det = detectInstruments(beatChannels, sr);
        const n = beatChannels[0].length;
        const bpm = clamp(o.bpm || 90, 60, 180);
        const beatSec = 60 / bpm;
        const barSec = beatSec * 4;
        const strength = clamp(o.strength, 0.25, 1.2);

        const fillL = new Float32Array(n);
        const fillR = new Float32Array(n);
        const added = [];

        if (det.presence.kick === "missing" || det.presence.kick === "thin") {
            const hit = synthKick(sr, 0.35);
            const g = det.presence.kick === "missing" ? 0.32 : 0.16;
            for (let tSec = 0; tSec < n / sr; tSec += beatSec) {
                placeHit(fillL, hit, Math.round(tSec * sr), g * strength);
                placeHit(fillR, hit, Math.round(tSec * sr), g * strength);
            }
            added.push(det.presence.kick === "missing" ? "kick" : "light kick");
        }

        if (det.presence.snare === "missing" || det.presence.snare === "thin") {
            const hit = synthSnare(sr, 0.28);
            const g = det.presence.snare === "missing" ? 0.22 : 0.12;
            for (let tSec = beatSec; tSec < n / sr; tSec += beatSec * 2) {
                placeHit(fillL, hit, Math.round(tSec * sr), g * strength);
                placeHit(fillR, hit, Math.round(tSec * sr), g * strength * 0.95);
            }
            added.push(det.presence.snare === "missing" ? "snare" : "light snare");
        }

        if (det.presence.hat === "missing" || det.presence.hat === "thin") {
            const closed = synthHat(sr, 0.08, false);
            const openHat = synthHat(sr, 0.18, true);
            const g = det.presence.hat === "missing" ? 0.2 : 0.1;
            let step = 0;
            for (let tSec = 0; tSec < n / sr; tSec += beatSec / 2) {
                const hit = (step % 4 === 3) ? openHat : closed;
                placeHit(fillL, hit, Math.round(tSec * sr), g * strength * (step % 2 ? 0.75 : 1));
                placeHit(fillR, hit, Math.round(tSec * sr), g * strength * (step % 2 ? 1 : 0.75));
                step++;
            }
            added.push(det.presence.hat === "missing" ? "hats" : "light hats");
        }

        if (det.presence.bass === "missing" || det.presence.bass === "thin") {
            const g = det.presence.bass === "missing" ? 0.18 : 0.1;
            const bars = Math.ceil((n / sr) / barSec);
            for (let bar = 0; bar < bars; bar++) {
                const midi = bassDegreeMidi(o.rootPc, o.scale, bar);
                const freq = midiToHz(midi);
                const note = synthBassNote(sr, freq, Math.min(barSec * 0.95, n / sr - bar * barSec), g);
                placeHit(fillL, note, Math.round(bar * barSec * sr), 1);
                placeHit(fillR, note, Math.round(bar * barSec * sr), 1);
            }
            added.push(det.presence.bass === "missing" ? "bass" : "light bass");
        }

        if (det.presence.chord === "missing" || det.presence.chord === "thin" || det.presence.pad === "missing") {
            const g = (det.presence.chord === "missing") ? 0.14 : 0.08;
            const bars = Math.ceil((n / sr) / barSec);
            for (let bar = 0; bar < bars; bar++) {
                const freqs = simpleChordFreqs(o.rootPc, o.scale, bar, 3);
                const chord = synthPadChord(sr, freqs, Math.min(barSec * 0.98, n / sr - bar * barSec), g);
                placeHit(fillL, chord, Math.round(bar * barSec * sr), 0.9);
                placeHit(fillR, chord, Math.round(bar * barSec * sr), 1.1);
            }
            added.push(det.presence.chord === "missing" ? "pad chords" : "light pad");
        }

        if (det.presence.piano === "missing" || det.presence.piano === "thin") {
            if (det.presence.chord !== "missing") {
                const g = det.presence.piano === "missing" ? 0.12 : 0.07;
                const bars = Math.ceil((n / sr) / barSec);
                for (let bar = 0; bar < bars; bar++) {
                    const freqs = simpleChordFreqs(o.rootPc, o.scale, bar, 4);
                    const chord = synthPianoChord(sr, freqs, Math.min(barSec * 0.9, n / sr - bar * barSec), g);
                    placeHit(fillL, chord, Math.round(bar * barSec * sr), 1.05);
                    placeHit(fillR, chord, Math.round(bar * barSec * sr), 0.95);
                }
                added.push(det.presence.piano === "missing" ? "piano" : "light piano");
            }
        }

        if (det.presence.pad === "missing" || (det.presence.pad === "thin" && det.presence.chord === "thin")) {
            const g = det.presence.pad === "missing" ? 0.09 : 0.05;
            const bars = Math.ceil((n / sr) / barSec);
            for (let bar = 0; bar < bars; bar += 2) {
                const freqs = simpleChordFreqs(o.rootPc, o.scale, bar, 4);
                const layer = synthStrings(sr, freqs, Math.min(barSec * 2 * 0.95, n / sr - bar * barSec), g);
                placeHit(fillL, layer, Math.round(bar * barSec * sr), 0.95);
                placeHit(fillR, layer, Math.round(bar * barSec * sr), 1.05);
            }
            added.push("soft strings");
        }

        if (!added.length) {
            report.push("Checked for missing instruments — beat already feels full enough, nothing added.");
            return { channels: beatChannels, report: report, detection: det, added: added };
        }

        const mixed = beatChannels.map(function (ch, c) {
            const src = c === 0 ? fillL : fillR;
            const y = new Float32Array(n);
            for (let i = 0; i < n; i++) y[i] = ch[i] + src[i];
            return y;
        });

        let peak = 0;
        for (let c = 0; c < mixed.length; c++) {
            for (let i = 0; i < n; i++) {
                const a = Math.abs(mixed[c][i]);
                if (a > peak) peak = a;
            }
        }
        if (peak > 0.95) {
            const sc = 0.95 / peak;
            for (let c = 0; c < mixed.length; c++) {
                for (let i = 0; i < n; i++) mixed[c][i] *= sc;
            }
        }

        report.push("Added supportive layers for missing/thin parts: " + added.join(", ") + ".");
        report.push("Fill is mixed under the real beat (optional synth support, not a full arrangement).");
        return { channels: mixed, report: report, detection: det, added: added };
    }

    window.VocalVaultFill = {
        detectInstruments: detectInstruments,
        fillMissing: fillMissing
    };
})();
