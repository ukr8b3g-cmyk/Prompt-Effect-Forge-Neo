"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHub } = require("./harness.cjs");
function pair(hostOptions = {}, pickerOptions = {}) {
    const hub = createHub(), host = hub.page({ session: "original", ...hostOptions });
    const picker = hub.page({ hash: `#prompt-effect-forge-neo?host=original&page=${host.api.instanceId}`, ...pickerOptions });
    picker.api.reconnectHost(); hub.advance(350);
    return { hub, host, picker };
}
function request(host, extra = {}) { return { protocol: "prompt-effect-forge-neo", version: 1, scope: "/", session: host.api.session, source: "picker", recipient: host.api.instanceId, type: "insert-request", requestId: "r1", target: "txt2img", text: "effect", ...extra }; }
test("direct insertion notifies Gradio, only selected prompt changes, disabled host blocks direct writes", () => {
    const host = createHub().page();
    host.inputs.txt2img.value = "leftRIGHT"; host.inputs.txt2img.setSelectionRange(4, 4);
    assert.equal(host.api.insertIntoPrompt("txt2img", "F").ok, true);
    assert.equal(host.inputs.txt2img.value, "left\nF\nRIGHT"); assert.equal(host.inputs.txt2img.updates, 1);
    assert.equal(host.inputs.img2img.value, "");
    host.api.setState({ enabled: false });
    assert.equal(host.api.insertIntoPrompt("img2img", "F").reason, "disabled");
});
test("handshake selects one path, original host is fixed even with another WebUI", () => {
    const { hub, host, picker } = pair();
    const other = hub.page({ session: "other" });
    assert.equal(picker.api.connected.source, host.api.instanceId); assert.equal(picker.api.connected.path, "broadcast");
    picker.api.requestInsert("img2img");
    assert.ok(host.inputs.img2img.value.includes("photorealistic")); assert.equal(other.inputs.img2img.value, "");
    assert.equal(hub.messages.filter(row => row.message.type === "insert-request").length, 1);
});
for (const [name, a, b] of [["host lacks BC", true, false], ["picker lacks BC", false, true], ["both lack BC", true, true]]) {
    test(`mixed transport: ${name}`, () => {
        const { host, picker } = pair({ bcFailure: a }, { bcFailure: b });
        assert.equal(picker.api.connected.path, "storage"); picker.api.requestInsert("txt2img");
        assert.equal(picker.api.pending, null); assert.equal(host.inputs.txt2img.updates, 1);
    });
}
test("invalid envelopes, targets and text never insert; picker cannot act as a host", () => {
    const { host, picker } = pair();
    for (const invalid of [{ protocol: "background-prompter" }, { version: 2 }, { scope: "/else" }, { session: "else" }, { recipient: "else" }, { target: "negative" }, { type: "arbitrary" }, { text: "" }, { text: "x".repeat(16001) }]) host.api.handleMessage(request(host, invalid), "storage");
    picker.api.handleMessage(request(host, { recipient: picker.api.instanceId }), "storage");
    assert.equal(host.inputs.txt2img.updates, 0); assert.equal(picker.inputs.txt2img.updates, 0);
});
test("dedup cache returns the original result after Enable changes; distinct clicks repeat", () => {
    const { host } = pair(); const first = request(host);
    host.api.handleMessage(first, "storage"); host.api.setState({ enabled: false }); host.api.handleMessage(first, "broadcast");
    assert.equal(host.inputs.txt2img.updates, 1);
    host.api.handleMessage(request(host, { requestId: "r2" }), "storage"); assert.equal(host.inputs.txt2img.updates, 1);
    host.api.setState({ enabled: true }); host.api.handleMessage(request(host, { requestId: "r3" }), "storage"); assert.equal(host.inputs.txt2img.updates, 2);
});
test("ACK loss is uncertain, pending clears, no automatic retransmission", () => {
    const { hub, host, picker } = pair(); host.control.dropACK = true;
    picker.api.requestInsert("txt2img"); assert.equal(host.inputs.txt2img.updates, 1);
    hub.advance(1800); assert.equal(picker.api.pending, null); assert.equal(picker.api.status, "uncertain");
    assert.equal(hub.messages.filter(row => row.message.type === "insert-request").length, 1);
});
test("postMessage failure clears pending and does not retry Insert on storage", () => {
    const { hub, host, picker } = pair(); picker.control.bcSendFailure = true;
    picker.api.requestInsert("txt2img"); assert.equal(picker.api.pending, null); assert.equal(picker.api.connected, null);
    assert.equal(host.inputs.txt2img.updates, 0); assert.equal(hub.messages.filter(row => row.message.type === "insert-request").length, 0);
    picker.api.reconnectHost(); hub.advance(350); assert.equal(picker.api.connected.path, "storage");
});
test("storage send failure recovers through explicit reconnect", () => {
    const { hub, host, picker } = pair({ bcFailure: true }); picker.control.storageFailure = true;
    picker.api.requestInsert("txt2img"); assert.equal(picker.api.pending, null); assert.equal(host.inputs.txt2img.updates, 0);
    picker.control.storageFailure = false; picker.api.reconnectHost(); hub.advance(350); picker.api.requestInsert("txt2img");
    assert.equal(host.inputs.txt2img.updates, 1);
});
test("host reload needs reconnect; duplicate session is ambiguous and close never retargets", () => {
    const { hub, host, picker } = pair(); host.api.dispose();
    const replacement = hub.page({ session: "original" });
    picker.api.requestInsert("txt2img"); hub.advance(1800); assert.equal(replacement.inputs.txt2img.updates, 0);
    picker.api.reconnectHost(); hub.advance(350); assert.equal(picker.api.connected.source, replacement.api.instanceId);
    const duplicate = hub.page({ session: "original" });
    picker.api.reconnectHost(); hub.advance(350); assert.equal(picker.api.status, "ambiguous"); assert.equal(picker.api.connected, null);
    duplicate.api.dispose(); replacement.api.dispose(); hub.page({ session: "unrelated" });
    picker.api.reconnectHost(); hub.advance(350); assert.equal(picker.api.status, "disconnected");
});
test("no transport still permits direct local insertion", () => {
    const hub = createHub(), host = hub.page({ bcFailure: true }); host.control.storageFailure = true;
    assert.equal(host.api.insertIntoPrompt("txt2img", "F").ok, true);
    const picker = hub.page({ bcFailure: true, hash: `#prompt-effect-forge-neo?host=${host.api.session}` }); picker.control.storageFailure = true;
    picker.api.reconnectHost(); assert.equal(picker.api.discovery, null); assert.equal(picker.api.pending, null);
});
test("new picker uses live host snapshot; same revisions cause no state echo", () => {
    const { hub, host, picker } = pair(); const before = hub.messages.length;
    host.api.commit({ mode: "Custom", customDraft: "", styleBoost: "Anime" });
    assert.equal(picker.api.state.customDraft, ""); assert.equal(picker.api.state.styleBoost, "Anime");
    const sent = hub.messages.length;
    picker.api.receiveState(host.api.snapshot()); assert.equal(hub.messages.length, sent);
    assert.equal(sent - before, 2);
    const next = hub.page({ hash: `#prompt-effect-forge-neo?host=${host.api.session}` }); next.api.reconnectHost(); hub.advance(350);
    assert.equal(next.api.state.customDraft, ""); assert.equal(next.api.state.styleBoost, "Anime");
});
test("revision tiebreak and composition defer remote snapshots without echo", () => {
    const host = createHub().page(), a = host.api;
    a.composeStart();
    a.receiveState({ schema_version: 1, state: { ...a.state, customDraft: "remote" }, revision: { counter: 4, actor: "z" } });
    assert.equal(a.state.customDraft, ""); a.composeEnd(); assert.equal(a.state.customDraft, "remote");
    a.receiveState({ schema_version: 1, state: { ...a.state, customDraft: "old" }, revision: { counter: 4, actor: "a" } }); assert.equal(a.state.customDraft, "remote");
});
test("a delayed request meets the current disabled host gate and invalid selections are harmless", () => {
    const { host } = pair(); host.api.setState({ enabled: false });
    host.api.handleMessage(request(host), "storage"); assert.equal(host.inputs.txt2img.updates, 0);
    host.api.setState({ enabled: true }); host.inputs.txt2img.selectionStart = -1;
    host.api.handleMessage(request(host, { requestId: "new" }), "storage"); assert.equal(host.inputs.txt2img.updates, 0);
});
