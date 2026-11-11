"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHub, catalog, plain } = require("./harness.cjs");
const cases = require("./cases.json"), golden = require("./source_effect_golden.json");
const { api } = createHub().page();
for (const row of cases.splice) test(`insertion: ${row.id}`, () => assert.deepEqual(plain(api.splicePrompt(row.base, row.start, row.end, row.text)), row.expected));
for (const row of cases.effect) test(`effect: ${row.id}`, () => assert.deepEqual(plain(api.composeEffect(catalog, { ...api.state, ...row.state })), row.expected));
test("528 upstream effect/boost outputs use the shipped composer", () => {
    assert.equal(golden.cases.length, 528);
    for (const row of golden.cases) assert.equal(api.composeEffect(catalog, { ...api.state, selectedPresetId: row.preset_id, styleBoost: row.style_boost }).preview, row.expected_effect);
});
test("disabled insertion keeps every byte; explicit repeated Insert adds a second fragment", () => {
    const base = "  base\n\n";
    assert.equal(api.insertEffect(catalog, { ...api.state, enabled: false }, base, 0, base.length).value, base);
    const first = api.splicePrompt("base", 4, 4, "F");
    assert.equal(api.splicePrompt(first.value, first.value.length, first.value.length, "F").value, "base\nF\nF");
});
test("Unicode limits, raw text, empty draft, and typed booleans", () => {
    assert.equal(api.validateCustom("😀".repeat(80), "😀".repeat(12000)).ok, true);
    assert.equal(api.validateCustom("😀".repeat(81), "x").reason, "name_too_long");
    assert.equal(api.validateCustom("x", "😀".repeat(12001)).reason, "text_too_long");
    assert.equal(api.validateCustom(1, "x").ok, false);
    assert.equal(api.normalizeState({ enabled: "false", mode: "Custom", customDraft: "" }).enabled, false);
    assert.equal(api.normalizeState({ customDraft: "" }).customDraft, "");
});
test("asset base keeps encoded spaces, renamed folders and reverse proxy paths", () => {
    for (const src of ["http://localhost/file=extensions/alias/javascript/prompt_effect.js?123", "http://localhost/neo/file=extensions/A%20B/javascript/prompt_effect.js?123#hash"]) {
        assert.equal(api.resolveExtensionBase(src), src.replace(/\/javascript.*$/, ""));
    }
    assert.throws(() => api.resolveExtensionBase("https://example.org/javascript/prompt_effect.js"));
    assert.throws(() => api.assetUrl("../bad.webp"));
    assert.throws(() => api.assetUrl("https://example.org/image.webp"));
    assert.throws(() => api.validateCatalog({ ...catalog, presets: catalog.presets.slice(1) }));
});
test("Save, rename, Save As, same-name refusal, revision conflict, independent records", () => {
    const hub = createHub(), a = hub.page().api, b = hub.page().api;
    const one = a.saveCustomRecord(" A ", " raw "); assert.equal(one.record.text, "raw");
    const other = b.saveCustomRecord("B", "second"); assert.equal(other.ok, true);
    const rename = a.saveCustomRecord("Renamed", "changed", one.record.id, 1);
    assert.equal(rename.record.id, one.record.id); assert.equal(rename.record.revision, 2);
    assert.equal(b.saveCustomRecord("stale", "x", one.record.id, 1).reason, "revision_conflict");
    assert.equal(a.saveCustomRecord("B", "replace").reason, "duplicate_name");
    assert.equal(a.loadCustomRecords().records.length, 2);
    assert.equal(a.exportCustomPresets().value.presets.every(row => Object.keys(row).join() === "name,text"), true);
});
test("saving with Boost retains raw draft and failed save keeps dirty state", () => {
    const hub = createHub(), page = hub.page(), a = page.api;
    a.setState({ mode: "Custom", styleBoost: "Anime", customName: "Name", customDraft: "raw" });
    assert.equal(a.customDirty(), true);
    assert.equal(a.saveCustomRecord(a.state.customName, a.state.customDraft).record.text, "raw");
    page.control.storageFailure = true;
    assert.equal(a.saveCustomRecord("Next", "raw").ok, false);
    assert.equal(a.state.customDraft, "raw"); assert.equal(a.customDirty(), true);
});
test("deletion detaches the ID, keeps the draft, and cannot silently resurrect an old UUID", () => {
    const { api: a, localStorage } = createHub().page();
    const record = a.saveCustomRecord("Saved", "text").record;
    a.setState({ customPresetId: record.id, loadedCustomRevision: 1, customDraft: "edited", styleBoost: "Anime" });
    localStorage.removeItem(a.keys.custom + record.id.slice(7)); a.detachMissingCustom();
    assert.equal(a.state.customPresetId, null); assert.equal(a.state.customDraft, "edited"); assert.equal(a.state.styleBoost, "Anime");
    assert.equal(a.saveCustomRecord("Name", "x", record.id, 1).reason, "revision_conflict");
});
test("corrupt records and unknown state schemas survive without being overwritten", () => {
    const hub = createHub(), first = hub.page({ session: "s" });
    hub.entries.set(first.api.keys.custom + "00000000-0000-4000-8000-000000000000", "bad json");
    hub.entries.set(first.api.keys.state, JSON.stringify({ schema_version: 99 }));
    const next = hub.page({ session: "s" }); next.api.commit({ customDraft: "kept" });
    assert.equal(JSON.parse(hub.entries.get(next.api.keys.state)).schema_version, 99);
    assert.equal(next.api.loadCustomRecords().errors.length, 1);
    assert.equal(next.api.saveCustomRecord("Valid", "x").ok, false);
    assert.equal(next.api.state.customDraft, "kept");
});
test("Import plans old/new forms, renames exact collisions, rejects invalid values before writes", () => {
    const { api: a } = createHub().page();
    a.saveCustomRecord("A", "old");
    const plan = a.planImport([{ name: " A ", text: "new" }, { name: "B", text: "b" }, { name: 4, text: "bad" }]);
    assert.equal(plan.plan[0].name, "A (import 2)"); assert.equal(plan.rejected.length, 1);
    assert.equal(a.loadCustomRecords().records.length, 1);
    assert.equal(a.importCustomPresets(plan.plan).saved, 2);
    assert.equal(a.planImport({ schema_version: 1, presets: [{ name: "C", text: "c" }] }).ok, true);
    assert.equal(a.planImport({ schema_version: 99, presets: [] }).ok, false);
    assert.equal(a.planImport([], 2097153).ok, false);
    assert.equal(a.planImport(Array(501).fill({ name: "x", text: "x" })).ok, false);
});
test("Import stops after a partial storage failure and preserves prior and successful records", () => {
    const page = createHub().page(), a = page.api;
    a.saveCustomRecord("Existing", "keep");
    const plan = a.planImport([{ name: "A", text: "a" }, { name: "B", text: "b" }, { name: "C", text: "c" }]);
    page.control.failCustomAt = page.control.customWrites + 2;
    const result = a.importCustomPresets(plan.plan);
    assert.equal(result.ok, false); assert.equal(result.saved, 1); assert.equal(result.remaining.length, 2);
    assert.equal(a.loadCustomRecords().records.length, 2);
});
