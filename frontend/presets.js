/**
 * Vocal Vault — Style + Polish recipes
 * Maps UI choices to numbers the existing mix chain already understands.
 */
(function () {
    "use strict";

    const STYLES = {
        universal: {
            id: "universal",
            label: "Universal",
            blurb: "Balanced default — safe on most songs",
            presenceDb: 1.5,
            airDb: 2.0,
            cutStrength: 0.6,
            boostStrength: 0.4,
            sat: { drive: 2.0, mix: 0.2 },
            vocalAboveBeatDb: 1.5,
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
            presenceDb: 2.3,
            airDb: 3.2,
            cutStrength: 0.72,
            boostStrength: 0.55,
            sat: { drive: 2.4, mix: 0.28 },
            vocalAboveBeatDb: 2.2,
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
            presenceDb: 2.1,
            airDb: 1.3,
            cutStrength: 0.75,
            boostStrength: 0.5,
            sat: { drive: 3.1, mix: 0.36 },
            vocalAboveBeatDb: 2.8,
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
        rnb: {
            id: "rnb",
            label: "R&B / Melodic",
            blurb: "Softer dynamics, longer plate, gentle width",
            presenceDb: 1.9,
            airDb: 2.6,
            cutStrength: 0.55,
            boostStrength: 0.45,
            sat: { drive: 1.85, mix: 0.18 },
            vocalAboveBeatDb: 1.3,
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
            sat: { drive: 1.4, mix: 0.08 },
            vocalAboveBeatDb: 1.0,
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
            vocalAboveAdd: -0.3,
            doubleBias: -1,
            spaceDbAdd: 2,
            beatMul: 0.85
        },
        radio: {
            id: "radio",
            label: "Radio",
            presenceMul: 1.15,
            airMul: 1.2,
            satMixMul: 1.15,
            satDriveMul: 1.1,
            compressMul: 1.05,
            vocalAboveAdd: 0.4,
            doubleBias: 1,
            spaceDbAdd: 0,
            beatMul: 1
        },
        aggressive: {
            id: "aggressive",
            label: "Aggressive",
            presenceMul: 1.4,
            airMul: 1.45,
            satMixMul: 1.45,
            satDriveMul: 1.35,
            compressMul: 1.3,
            vocalAboveAdd: 1.2,
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
        const airDb = clamp(style.airDb * polish.airMul, 0, 4.5);
        const sat = {
            drive: clamp(style.sat.drive * polish.satDriveMul, 1.2, 4.5),
            mix: clamp(style.sat.mix * polish.satMixMul, 0.04, 0.48)
        };
        const compressTightenDb = style.compressTightenDb * polish.compressMul;
        const vocalAboveBeatDb = clamp(
            style.vocalAboveBeatDb + polish.vocalAboveAdd,
            -2,
            5
        );

        let preferDoubler = style.preferDoubler;
        if (polish.doubleBias > 0 && preferDoubler === null) preferDoubler = true;
        if (polish.doubleBias > 0 && preferDoubler === false && style.id !== "clean" && style.id !== "trap") {
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
