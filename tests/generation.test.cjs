"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHub } = require("./harness.cjs");

function host() {
    const page = createHub().page();
    page.context.submit = (...args) => args;
    page.context.submit_img2img = async (...args) => args;
    page.context.forgeGenerationQueue = { submit: (...args) => args };
    page.api.installGenerationPrompt();
    page.api.commit({ mode: "Custom", customDraft: "warm afternoon lighting" });
    return page;
}

test("Enable adds the selected effect to native and queued generation without editing Positive", async () => {
    const { api, context, inputs } = host();
    inputs.txt2img.value = "forest";
    inputs.img2img.value = "castle";

    assert.equal(context.submit(null, "forest")[1], "forest");
    api.commit({ enabled: true });
    assert.equal(context.submit(null, "forest")[1], "forest\nwarm afternoon lighting");
    assert.equal(context.forgeGenerationQueue.submit(null, "forest")[1], "forest\nwarm afternoon lighting");
    assert.equal((await context.submit_img2img(null, null, "castle"))[2], "castle\nwarm afternoon lighting");
    assert.equal(inputs.txt2img.value, "forest");
    assert.equal(inputs.img2img.value, "castle");

    assert.equal(context.submit(null, "gallery-upscale-argument")[1], "gallery-upscale-argument");
    api.commit({ enabled: false });
    assert.equal(context.submit(null, "forest")[1], "forest");
});

test("Insert remains editable and Generate does not duplicate the inserted effect", () => {
    const { api, context, inputs } = host();
    const textarea = inputs.txt2img;
    textarea.value = "forest";
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    api.commit({ enabled: true });

    assert.equal(api.requestInsert("txt2img"), undefined);
    const inserted = textarea.value;
    assert.equal(inserted, "forest\nwarm afternoon lighting");
    assert.equal(context.submit(null, inserted)[1], inserted);
    api.commit({ enabled: false });
    assert.equal(textarea.value, inserted);
});
