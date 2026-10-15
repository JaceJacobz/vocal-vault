// Does changing the Style move the REAL loudness target, or only the dropdown on screen?  Run: node test_dropdown.js [mixui file]
const vm = require("vm"), fs = require("fs");
const file = process.argv[2] || "./mixui.js";
function makeEl(id) {
  const el = { id, value: "", options: [], listeners: {}, classList: { add() {}, remove() {} }, textContent: "", style: {},
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach(f => f(ev)); },
    appendChild(o) { this.options.push(o); if (this.options.length === 1) this.value = o.value; },
    set innerHTML(_) { this.options = []; }, get innerHTML() { return ""; } };
  return el;
}
const els = {}; ["master-target", "export-format", "mix-compare", "mix-compare-info", "mix-play-before", "mix-play-after", "mix-stop", "mix-download", "mix-style", "mix-style-hint", "mix-polish", "harmony-select", "export-filename"].forEach(i => els[i] = makeEl(i));
els["export-format"].value = "24"; els["mix-polish"].value = "radio";
const domReady = [];
const document = { addEventListener(t, f) { if (t === "DOMContentLoaded") domReady.push(f); }, getElementById: (i) => els[i] || null, createElement: () => ({ value: "", textContent: "" }) };
const win = { VocalVaultState: {}, addEventListener() {} };
const P = {}; vm.runInContext(fs.readFileSync(process.argv[3] || "./presets.js", "utf8"), vm.createContext({ window: P, Math, Object, console }));
win.VocalVaultPresets = P.VocalVaultPresets;
const ctx = vm.createContext({ document, window: win, module: { exports: {} }, Math, Object, console, URL: {}, Blob: function () {}, ArrayBuffer, DataView, Event: function (type) { this.type = type; } });
vm.runInContext(fs.readFileSync(file, "utf8"), ctx);
domReady.forEach(f => f());
const S = win.VocalVaultState, sel = els["master-target"];
console.log(`${file}`);
console.log("  at load        : dropdown shows", sel.value, "| the app will mix to", S.masterTargetLufs);
els["mix-style"].value = "trap"; els["mix-style"].dispatchEvent({ type: "change" });
console.log("  after 'Trap'   : dropdown shows", sel.value, "| the app will mix to", S.masterTargetLufs);
const ok = String(S.masterTargetLufs) === sel.value || parseFloat(sel.value) === S.masterTargetLufs;
console.log(ok ? "  => in sync" : "  => OUT OF SYNC: you see one loudness, the mix uses another");
process.exit(ok ? 0 : 1);
