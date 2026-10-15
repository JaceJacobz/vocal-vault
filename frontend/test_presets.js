// Run: node test_presets.js     (needs presets.js, mixui.js and studio.js beside it)
const vm = require("vm"), fs = require("fs");
const { createStudioEngine } = require("./studio.js");
const E = createStudioEngine();
let pass = 0, fail = 0;
const check = (l, ok, x = "") => { ok ? pass++ : fail++; console.log((ok ? "  PASS " : "  FAIL ") + l + (x ? "   " + x : "")); };

const win = {}; vm.runInContext(fs.readFileSync(__dirname + "/presets.js", "utf8"), vm.createContext({ window: win, Math, Object, console }));
const P = win.VocalVaultPresets;
const mod = { exports: {} };
vm.runInContext(fs.readFileSync(__dirname + "/mixui.js", "utf8"), vm.createContext({ module: mod, window: win, document: { addEventListener() {}, getElementById() { return null; } }, Math, Object, console, URL: {}, Blob: function () {}, ArrayBuffer, DataView, Event: function () {} }));
const TARGETS = mod.exports.LOUDNESS_TARGETS.map(t => t.lufs);

const styles = Object.keys(P.STYLES).filter(s => s !== "auto"), pol = ["natural", "radio", "aggressive"];
const flat = E.TARGET_DB.slice();
const eq = (r) => { const p = E.planEq(flat, r.eq, 44100); return { pres: p.bands.find(b => b.f === 3200).gainDb, air: p.shelf.gainDb }; };

console.log("1) nothing is silently clipped by a cap downstream");
{
  let bad = [];
  for (const s of styles) for (const p of pol) {
    const st = P.STYLES[s], po = P.POLISH[p], r = P.resolve(s, p);
    if (Math.abs(st.presenceDb * po.presenceMul - r.presenceDb) > 1e-9) bad.push(`${s}/${p} presence`);
    if (Math.abs(st.airDb * po.airMul - r.airDb) > 1e-9) bad.push(`${s}/${p} air`);
    if (r.presenceDb > 1.6 + 1e-9 || r.airDb > 1.5 + 1e-9 || r.vocalAboveBeatDb > 0.25 + 1e-9) bad.push(`${s}/${p} over a cap`);
  }
  check("every presence / air / vocal-level value is inside the range the engine honours", !bad.length, bad.join(", "));
}
console.log("2) the polish steps are really different");
for (const s of styles) {
  const [n, r, a] = pol.map(p => eq(P.resolve(s, p)));
  check(`${s}: natural < radio < aggressive for presence and air`, n.pres + 0.05 < r.pres && r.pres + 0.05 < a.pres && n.air + 0.05 < r.air && r.air + 0.05 < a.air,
    `presence ${n.pres.toFixed(2)} / ${r.pres.toFixed(2)} / ${a.pres.toFixed(2)}  air ${n.air.toFixed(2)} / ${r.air.toFixed(2)} / ${a.air.toFixed(2)}`);
}
console.log("3) the styles are really different");
{
  const f = {}; for (const s of styles) f[s] = eq(P.resolve(s, "radio"));
  let worst = 9, pair = "";
  for (let i = 0; i < styles.length; i++) for (let j = i + 1; j < styles.length; j++) {
    const d = Math.hypot(f[styles[i]].pres - f[styles[j]].pres, f[styles[i]].air - f[styles[j]].air);
    if (d < worst) { worst = d; pair = styles[i] + " vs " + styles[j]; }
  }
  check("every pair of styles differs by >= 0.1 dB in presence/air combined", worst >= 0.1, `closest pair: ${pair} (${worst.toFixed(2)} dB)`);
  const v = styles.map(s => P.resolve(s, "radio").vocalAboveBeatDb);
  const order = ["clean", "rnb", "universal", "afrobeats", "trap", "rap"].map(s => P.resolve(s, "radio").vocalAboveBeatDb);
  check("vocal-above-beat orders clean < rnb < universal < afrobeats < trap < rap", order.every((x, i) => i === 0 || x > order[i - 1]), order.map(x => x.toFixed(2)).join(" < "));
}
console.log("4) loudness suggestions exist in the dropdown");
for (const k of Object.keys(P.STYLES)) check(`${k}: ${P.STYLES[k].suggestedLufs} LUFS is an option`, TARGETS.includes(P.STYLES[k].suggestedLufs), "options " + TARGETS.join(", "));
console.log("5) the characters make musical sense");
{
  const R = (s) => P.resolve(s, "radio");
  check("Rap and Trap have less reverb than Universal; R&B has more", R("rap").reverbScale < R("universal").reverbScale && R("trap").reverbScale < R("universal").reverbScale && R("rnb").reverbScale > R("universal").reverbScale);
  check("Clean has the least echo and forces minimal effects", R("clean").echoScale <= Math.min(...styles.map(s => R(s).echoScale)) && R("clean").forceMinimalFx);
  check("R&B compresses more gently than every style except Clean; Trap hardest", R("rnb").compressTightenDb < Math.min(...styles.filter(s => s !== "rnb" && s !== "clean").map(s => R(s).compressTightenDb)) && R("trap").compressTightenDb === Math.max(...styles.map(s => R(s).compressTightenDb)));
  check("doubler: Afrobeats and R&B on, Rap and Clean off", R("afrobeats").preferDoubler === true && R("rnb").preferDoubler === true && R("rap").preferDoubler === false && R("clean").preferDoubler === false);
  check("'Aggressive' never adds MORE reverb than 'Radio' (it should be tighter)", styles.every(s => P.resolve(s, "aggressive").reverbBelowAdd >= P.resolve(s, "radio").reverbBelowAdd && P.resolve(s, "aggressive").echoBelowAdd >= P.resolve(s, "radio").echoBelowAdd));
  check("'Natural' uses less saturation and compression than 'Radio'", styles.every(s => P.resolve(s, "natural").sat.mix < P.resolve(s, "radio").sat.mix && Math.abs(P.resolve(s, "natural").compressTightenDb) <= Math.abs(P.resolve(s, "radio").compressTightenDb) + 1e-9));
  const a = P.resolve("auto", "radio"), u = P.resolve("universal", "radio");
  check("'Auto' behaves like Universal until the beat has been heard", a.presenceDb === u.presenceDb && a.airDb === u.airDb && a.suggestedLufs === u.suggestedLufs);
}
console.log("6) every combination resolves to sane numbers");
{
  let bad = [];
  for (const s of Object.keys(P.STYLES).concat(["nonsense"])) for (const p of pol.concat(["nonsense"])) {
    const r = P.resolve(s, p);
    for (const k of ["presenceDb", "airDb", "vocalAboveBeatDb", "compressTightenDb", "reverbBelowAdd", "echoBelowAdd", "beatEnhanceStrength"]) if (!Number.isFinite(r[k])) bad.push(`${s}/${p} ${k}`);
    if (!Number.isFinite(r.sat.drive) || !Number.isFinite(r.sat.mix) || r.sat.mix < 0.03 || r.sat.mix > 0.18) bad.push(`${s}/${p} sat`);
  }
  check("no NaN, saturation always inside its safe range (also for unknown names)", !bad.length, bad.join(", "));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
