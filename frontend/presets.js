/**
 * Vocal Vault — Style + Polish recipes
 * Maps UI choices to numbers the existing mix chain already understands.
 *
 * READ THIS BEFORE EDITING A NUMBER. Several knobs are capped downstream, so a value above the cap does nothing
 * and two styles that "ask" for different amounts end up identical. The numbers below are chosen to sit INSIDE the
 * range the engine really honours (checked by test_presets.js):
 *
 *   presenceDb          studio.js planEq: min(presence, 1.6) x 0.85 is what reaches 3.2 kHz.        range 0 .. 1.6
 *   airDb               studio.js planEq: min(air, 1.5) x 0.75 is the high shelf.                    range 0 .. 1.5
 *   vocalAboveBeatDb    automix.js, balanced mode: min(value, 0.25). "Forward" mode sets its own     range -2 .. 0.25
 *                       level (0.6+) and "closer" its own (-0.3), so only values under 0.25 matter.
 *   suggestedLufs       must be one of the dropdown's options (mixui.js LOUDNESS_TARGETS).
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
            airDb: 1.05,
            cutStrength: 0.62,
            boostStrength: 0.38,
            sat: { drive: 1.3, mix: 0.07 },
            vocalAboveBeatDb: 0,
            compressTightenDb: 0,
            reverbScale: 1,
            echoScale: 1,
            reverbBelowAdd: 0,
            echoBelowAdd: 0,
            midDuckScale: 1,
            preferDoubler: null,
            forceMinimalFx: false,
            beatEnhanceStrength: 1,
            suggestedLufs: -14
        },
        universal: {
            id: "universal",
            label: "Universal",
            blurb: "Balanced default — safe on most songs",
            presenceDb: 1.15,
            airDb: 1.05,
            cutStrength: 0.62,
            boostStrength: 0.38,
            sat: { drive: 1.3, mix: 0.07 },
            vocalAboveBeatDb: 0,
            compressTightenDb: 0,
            reverbScale: 1,
            echoScale: 1,
            reverbBelowAdd: 0,
            echoBelowAdd: 0,
            midDuckScale: 1,
            preferDoubler: null,
            forceMinimalFx: false,
            beatEnhanceStrength: 1,
            suggestedLufs: -14
        },
        afrobeats: {
            id: "afrobeats",
            label: "Afrobeats / Amapiano",
            blurb: "Bright, silky top, tight low-mids, forward vocal; space that stays out of the way",
            presenceDb: 1.3,
            airDb: 1.35,
            cutStrength: 0.72,
            boostStrength: 0.55,
            sat: { drive: 1.55, mix: 0.11 },
            vocalAboveBeatDb: 0.05,
            compressTightenDb: 1.5,
            reverbScale: 0.8,
            echoScale: 1,
            reverbBelowAdd: 0.5,
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
            presenceDb: 1.35,
            airDb: 0.8,
            cutStrength: 0.75,
            boostStrength: 0.5,
            sat: { drive: 1.6, mix: 0.12 },
            vocalAboveBeatDb: 0.1,
            compressTightenDb: 3,
            reverbScale: 0.55,
            echoScale: 0.65,
            reverbBelowAdd: 3,
            echoBelowAdd: 2,
            midDuckScale: 1.25,
            preferDoubler: false,
            forceMinimalFx: false,
            beatEnhanceStrength: 1.25,
            suggestedLufs: -10
        },
        rap: {
            id: "rap",
            label: "Rap / Hip-Hop",
            blurb: "Dry, punchy, lyric-forward — clear midrange, tight space, sits on top of the beat",
            presenceDb: 1.45,
            airDb: 0.95,
            cutStrength: 0.78,
            boostStrength: 0.52,
            sat: { drive: 1.5, mix: 0.1 },
            vocalAboveBeatDb: 0.15,
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
            presenceDb: 1,
            airDb: 1.35,
            cutStrength: 0.55,
            boostStrength: 0.45,
            sat: { drive: 1.35, mix: 0.09 },
            vocalAboveBeatDb: -0.1,
            compressTightenDb: -1.2,
            reverbScale: 1.3,
            echoScale: 1.15,
            reverbBelowAdd: -2,
            echoBelowAdd: -1,
            midDuckScale: 0.9,
            preferDoubler: true,
            forceMinimalFx: false,
            beatEnhanceStrength: 0.9,
            suggestedLufs: -14
        },
        clean: {
            id: "clean",
            label: "Clean / Natural",
            blurb: "Minimal color — close to the raw performance",
            presenceDb: 0.6,
            airDb: 0.7,
            cutStrength: 0.45,
            boostStrength: 0.28,
            sat: { drive: 1.25, mix: 0.06 },
            vocalAboveBeatDb: -0.3,
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

    // presence/air multipliers: the strongest style (presence 1.45, air 1.35) x aggressive lands just under the caps
    // (1.6 / 1.5), so "Aggressive" is always really stronger than "Radio" and nothing is silently clipped.
    // spaceDbAdd: + = the reverb/echo sit further under the vocal (drier), - = more of them.
    const POLISH = {
        natural: {
            id: "natural",
            label: "Natural",
            presenceMul: 0.7,
            airMul: 0.7,
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
            presenceMul: 1,
            airMul: 1,
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
            presenceMul: 1.1,
            airMul: 1.1,
            satMixMul: 1.05,
            satDriveMul: 1.05,
            compressMul: 1.3,
            vocalAboveAdd: 0.1,
            doubleBias: 1,
            spaceDbAdd: 1,
            beatMul: 1.15
        }
    };

    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    function resolve(styleId, polishId) {
        const style = STYLES[styleId] || STYLES.universal;
        const polish = POLISH[polishId] || POLISH.radio;

        const presenceDb = clamp(style.presenceDb * polish.presenceMul, 0, 1.6);      // planEq caps presence at 1.6
        const airDb = clamp(style.airDb * polish.airMul, 0, 1.5);                    // planEq caps the air shelf at 1.5
        const sat = {
            drive: clamp(style.sat.drive * polish.satDriveMul, 1.1, 2.2),
            mix: clamp(style.sat.mix * polish.satMixMul, 0.03, 0.18)
        };
        const compressTightenDb = style.compressTightenDb * polish.compressMul;
        const vocalAboveBeatDb = clamp(
            style.vocalAboveBeatDb + polish.vocalAboveAdd,
            -2,
            0.25                                                                    // automix.js balanced mode caps the vocal here
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
