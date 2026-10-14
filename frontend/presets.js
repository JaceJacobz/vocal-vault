/**
 * Vocal Vault — Style + Polish recipes
 * Maps UI choices to numbers the existing mix chain already understands.
 */
(function () {
    "use strict";

    const STYLES = {
        // Placeholder while the beat is being listened to: automix.js swaps in the detected style.
        auto: {
            id: "auto",
            label: "Auto-detect from my beat",
            blurb: "Listens to your beat and picks the closest style. If it is not sure, it uses Universal.",
            presenceDb: 1.15,
            airDb: 1.4,
            cutStrength: 0.62,
            boostStrength: 0.38,
            sat: { drive: 1.3, mix: 0.07 },
            vocalAboveBeatDb: 0.21,
            compressTightenDb: 0,
            reverbScale: 1,
            echoScale: 1,
            reverbBelowAdd: 0,
            echoBelowAdd: 0,
            midDuckScale: 1,
            preferDoubler: null,
            forceMinimalFx: false,
            beatEnhanceStrength: 1,
            suggestedLufs: -12
        },
        universal: {
            id: "universal",
            label: "Universal",
            blurb: "Balanced default — safe on most songs",
            presenceDb: 1.15,
            airDb: 1.4,
            cutStrength: 0.62,
            boostStrength: 0.38,
            sat: { drive: 1.3, mix: 0.07 },
            vocalAboveBeatDb: 0.21,
            compressTightenDb: 0,
            reverbScale: 1,
            echoScale: 1,
            reverbBelowAdd: 0,
            echoBelowAdd: 0,
            midDuckScale: 1,
            preferDoubler: null,
            forceMinimalFx: false,
            beatEnhanceStrength: 1,
            suggestedLufs: -12
        },
        afrobeats: {
            id: "afrobeats",
            label: "Afrobeats / Amapiano",
            blurb: "Bright top, tight low-mids, shorter space, forward vocal",
            presenceDb: 2.1,
            airDb: 2.9,
            cutStrength: 0.72,
            boostStrength: 0.55,
            sat: { drive: 1.55, mix: 0.11 },
            vocalAboveBeatDb: 0.42,
            compressTightenDb: 1.5,
            reverbScale: 0.72,
            echoScale: 0.85,
            reverbBelowAdd: 1,
            echoBelowAdd: 0,
            midDuckScale: 1.15,
            preferDoubler: true,
            forceMinimalFx: false,
            beatEnhanceStrength: 1.15,
            suggestedLufs: -12
        },
        trap: {
            id: "trap",
            label: "Trap / Drill",
            blurb: "Harder compression, more grit, louder vocal, darker space",
            presenceDb: 1.9,
            airDb: 1.2,
            cutStrength: 0.75,
            boostStrength: 0.5,
            sat: { drive: 1.6, mix: 0.12 },
            vocalAboveBeatDb: 0.5,
            compressTightenDb: 3,
            reverbScale: 0.55,
            echoScale: 0.65,
            reverbBelowAdd: 3,
            echoBelowAdd: 2,
            midDuckScale: 1.25,
            preferDoubler: false,
            forceMinimalFx: false,
            beatEnhanceStrength: 1.25,
            suggestedLufs: -9
        },
        rap: {
            id: "rap",
            label: "Rap / Hip-Hop",
            blurb: "Dry, punchy, lyric-forward — clear midrange, tight space, sits on top of the beat",
            presenceDb: 2.35,
            airDb: 1.65,
            cutStrength: 0.78,
            boostStrength: 0.52,
            sat: { drive: 1.5, mix: 0.1 },
            vocalAboveBeatDb: 0.5,
            compressTightenDb: 2.4,
            reverbScale: 0.42,
            echoScale: 0.55,
            reverbBelowAdd: 4,
            echoBelowAdd: 2.5,
            midDuckScale: 1.3,
            preferDoubler: false,
            forceMinimalFx: false,
            beatEnhanceStrength: 1.2,
            suggestedLufs: -10
        },
        rnb: {
            id: "rnb",
            label: "R&B / Melodic",
            blurb: "Softer dynamics, longer plate, gentle width",
            presenceDb: 1.7,
            airDb: 2.35,
            cutStrength: 0.55,
            boostStrength: 0.45,
            sat: { drive: 1.35, mix: 0.09 },
            vocalAboveBeatDb: 0.24,
            compressTightenDb: -1.2,
            reverbScale: 1.3,
            echoScale: 1.15,
            reverbBelowAdd: -2,
            echoBelowAdd: -1,
            midDuckScale: 0.9,
            preferDoubler: true,
            forceMinimalFx: false,
            beatEnhanceStrength: 0.9,
            suggestedLufs: -12
        },
        clean: {
            id: "clean",
            label: "Clean / Natural",
            blurb: "Minimal color — close to the raw performance",
            presenceDb: 0.7,
            airDb: 1.0,
            cutStrength: 0.45,
            boostStrength: 0.28,
            sat: { drive: 1.25, mix: 0.06 },
            vocalAboveBeatDb: 0.21,
            compressTightenDb: -2,
            reverbScale: 0.45,
            echoScale: 0.5,
            reverbBelowAdd: 4,
            echoBelowAdd: 3,
            midDuckScale: 0.65,
            preferDoubler: false,
            forceMinimalFx: true,
            beatEnhanceStrength: 0.65,
            suggestedLufs: -14
        }
    };

    const POLISH = {
        natural: {
            id: "natural",
            label: "Natural",
            presenceMul: 0.75,
            airMul: 0.75,
            satMixMul: 0.65,
            satDriveMul: 0.85,
            compressMul: 0.7,
            vocalAboveAdd: -0.4,
            doubleBias: -1,
            spaceDbAdd: 2,
            beatMul: 0.85
        },
        radio: {
            id: "radio",
            label: "Radio",
            presenceMul: 1.05,
            airMul: 1.0,
            satMixMul: 0.95,
            satDriveMul: 0.95,
            compressMul: 1.1,
            vocalAboveAdd: 0.1,
            doubleBias: 1,
            spaceDbAdd: 0,
            beatMul: 1
        },
        aggressive: {
            id: "aggressive",
            label: "Aggressive",
            presenceMul: 1.32,
            airMul: 1.35,
            satMixMul: 1.05,
            satDriveMul: 1.05,
            compressMul: 1.3,
            vocalAboveAdd: 0.4,
            doubleBias: 1,
            spaceDbAdd: -1.5,
            beatMul: 1.15
        }
    };

    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    function resolve(styleId, polishId) {
        const style = STYLES[styleId] || STYLES.universal;
        const polish = POLISH[polishId] || POLISH.radio;

        const presenceDb = clamp(style.presenceDb * polish.presenceMul, 0, 4);
        const airDb = clamp(style.airDb * polish.airMul, 0, 4.0);
        const sat = {
            drive: clamp(style.sat.drive * polish.satDriveMul, 1.1, 2.2),
            mix: clamp(style.sat.mix * polish.satMixMul, 0.03, 0.18)
        };
        const compressTightenDb = style.compressTightenDb * polish.compressMul;
        const vocalAboveBeatDb = clamp(
            style.vocalAboveBeatDb + polish.vocalAboveAdd,
            -2,
            1.5
        );

        let preferDoubler = style.preferDoubler;
        if (polish.doubleBias > 0 && preferDoubler === null) preferDoubler = true;
        if (polish.doubleBias > 0 && preferDoubler === false && style.id !== "clean" && style.id !== "trap" && style.id !== "rap") {
            preferDoubler = true;
        }
        if (polish.doubleBias < 0 && preferDoubler === true) preferDoubler = null;
        if (style.forceMinimalFx) preferDoubler = false;

        return {
            styleId: style.id,
            polishId: polish.id,
            styleLabel: style.label,
            polishLabel: polish.label,
            blurb: style.blurb,
            presenceDb,
            airDb,
            cutStrength: style.cutStrength,
            boostStrength: style.boostStrength,
            sat,
            vocalAboveBeatDb,
            compressTightenDb,
            reverbScale: style.reverbScale,
            echoScale: style.echoScale,
            reverbBelowAdd: style.reverbBelowAdd + polish.spaceDbAdd,
            echoBelowAdd: style.echoBelowAdd + polish.spaceDbAdd * 0.5,
            midDuckScale: style.midDuckScale,
            preferDoubler,
            forceMinimalFx: style.forceMinimalFx,
            beatEnhanceStrength: clamp(style.beatEnhanceStrength * polish.beatMul, 0.4, 1.6),
            suggestedLufs: style.suggestedLufs,
            eq: {
                presenceDb,
                airDb,
                cutStrength: style.cutStrength,
                boostStrength: style.boostStrength
            }
        };
    }

    function listStyles() {
        return Object.keys(STYLES).map((id) => ({
            id,
            label: STYLES[id].label,
            blurb: STYLES[id].blurb
        }));
    }

    function listPolish() {
        return Object.keys(POLISH).map((id) => ({
            id,
            label: POLISH[id].label
        }));
    }

    window.VocalVaultPresets = {
        STYLES,
        POLISH,
        resolve,
        listStyles,
        listPolish
    };
})();
