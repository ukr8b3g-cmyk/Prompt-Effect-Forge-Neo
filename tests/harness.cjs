"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto").webcrypto;
const root = path.resolve(__dirname, "..");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "data/prompt_effect_presets.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "javascript/prompt_effect.js"), "utf8");
const instrumented = source.replace("// PEF_TEST_SEAM", `globalThis.__pef = {
    composeEffect, splicePrompt, insertEffect, validateCustom, normalizeState, resolveExtensionBase,
    validateCatalog, assetUrl, loadCustomRecords, saveCustomRecord, planImport, importCustomPresets, exportCustomPresets,
    customDirty, insertIntoPrompt, handleMessage, requestInsert, reconnectHost, receiveState, snapshot, commit,
    ensureMounts, renderAll, loadCatalog, openDrawer, closeDrawer, loadCustom, detachMissingCustom, dispose,
    keys, instanceId, session, scope, isStandalone, transport, setStyleBoostEnabled,
    toggleFavorite, isFavorite, recentLibraryIds, libraryItems, selectPreset, recordLibraryOperation, receiveLibraryOperation, readLibraryOperations,
    get state() { return state; }, get revision() { return revision; }, get connected() { return connected; },
    get pending() { return pending; }, get status() { return status; }, get ready() { return ready; },
    get loadError() { return loadError; }, get persistenceWarning() { return persistenceWarning; },
    get renderCount() { return lastRender; }, get discovery() { return discovery; },
    setState(value) { state = normalizeState({...state, ...value}); },
    activate(value) { catalog = value; ready = true; extensionBase = resolveExtensionBase(); },
    composeStart() { composing++; }, composeEnd() { composing = 0; if (deferredState) { const v = deferredState; deferredState = null; receiveState(v); } }
};`);

function createHub() {
    const entries = new Map(), pages = [], messages = [];
    let held = false;
    const deliveries = [];
    const deliver = fn => { if (held) deliveries.push(fn); else fn(); };
    let timerId = 0, now = 0;
    const timers = new Map();
    const advance = ms => {
        now += ms;
        for (const [id, timer] of [...timers]) if (timer.time <= now) { timers.delete(id); timer.fn(); }
    };
    function page(options = {}) {
        const events = new Map(), channels = [];
        const control = { bcFailure: !!options.bcFailure, bcSendFailure: false, storageFailure: false, dropACK: false, customWrites: 0, failCustomAt: Infinity };
        const fire = (type, event) => { for (const listener of events.get(type) || []) listener(event); };
        const localStorage = {
            get length() { if (control.storageFailure) throw new Error("SecurityError"); return entries.size; },
            key(index) { return [...entries.keys()][index] || null; },
            getItem(key) { if (control.storageFailure) throw new Error("SecurityError"); return entries.get(key) ?? null; },
            setItem(key, value) {
                if (control.storageFailure || (key.includes(":custom:") && ++control.customWrites >= control.failCustomAt)) throw new Error("QuotaExceededError");
                const oldValue = entries.get(key) ?? null; entries.set(key, String(value));
                if (key.includes(":event:")) {
                    const message = JSON.parse(value).message; messages.push({ path: "storage", message });
                    if (control.dropACK && message.type === "insert-ack") return;
                }
                for (const other of pages) if (other.fire !== fire) deliver(()=>other.fire("storage", { key, newValue: String(value), oldValue }));
            },
            removeItem(key) { if (control.storageFailure) throw new Error("SecurityError"); const oldValue = entries.get(key); entries.delete(key); for (const other of pages) if (other.fire !== fire) deliver(()=>other.fire("storage", { key, newValue: null, oldValue })); },
        };
        const sessionData = new Map();
        if (options.session) sessionData.set(`prompt-effect-forge-neo:host:v1:${options.scope || "/"}`, options.session);
        const inputs = {};
        for (const target of ["txt2img", "img2img"]) inputs[target] = { value: "", selectionStart: 0, selectionEnd: 0, updates: 0, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }, dispatchEvent() { this.updates++; } };
        const document = {
            documentElement: { dataset: {} }, currentScript: { src: "http://localhost/file=extensions/Prompt%20Effects/javascript/prompt_effect.js?123" },
            baseURI: "http://localhost/", scripts: [], readyState: "loading", addEventListener() {},
            querySelector(selector) { const key = /^#(txt2img|img2img)_prompt textarea$/.exec(selector); return key ? inputs[key[1]] : null; }, querySelectorAll() { return []; },
        };
        class BC {
            constructor(name) { if (control.bcFailure) throw new Error("unavailable"); this.name = name; this.listeners = []; channels.push(this); }
            addEventListener(type, listener) { this.listeners.push(listener); }
            removeEventListener(type, listener) { this.listeners = this.listeners.filter(value => value !== listener); }
            postMessage(message) {
                if (control.bcSendFailure) throw new Error("InvalidStateError");
                messages.push({ path: "broadcast", message });
                if (control.dropACK && message.type === "insert-ack") return;
                for (const other of pages) if (other.fire !== fire) for (const channel of other.channels) if (channel.name === this.name) for (const listener of channel.listeners) deliver(()=>listener({ data: structuredClone(message) }));
            }
            close() { const index = channels.indexOf(this); if (index !== -1) channels.splice(index, 1); }
        }
        const location = new URL(`http://localhost${options.scope && options.scope !== "/" ? options.scope + "/" : "/"}${options.hash || ""}`);
        const context = {
            document, location, URL, URLSearchParams, crypto, Uint8Array, console, Event,
            sessionStorage: { getItem: key => sessionData.get(key) ?? null, setItem: (key, value) => sessionData.set(key, value) }, localStorage,
            BroadcastChannel: BC, navigator: { language: "en" },
            setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, time: now + ms }); return id; }, clearTimeout: id => timers.delete(id),
            onUiLoaded() {}, onAfterUiUpdate() {}, gradioApp: () => document,
            updateInput: input => input.updates++,
            addEventListener: (type, listener) => { if (!events.has(type)) events.set(type, []); events.get(type).push(listener); },
            removeEventListener: (type, listener) => events.set(type, (events.get(type) || []).filter(value => value !== listener)),
        };
        context.window = context;
        const result = { fire, channels, inputs, control, localStorage, context };
        pages.push(result);
        vm.createContext(context); vm.runInContext(instrumented, context, { filename: "prompt_effect.js" });
        result.api = context.__pef;
        result.api.activate(catalog);
        return result;
    }
    return { page, entries, messages, advance, hold(){held=true;}, flush(reverse=false){held=false;const queue=deliveries.splice(0);if(reverse)queue.reverse();for(const fn of queue)fn();} };
}
const plain = value => JSON.parse(JSON.stringify(value));
module.exports = { createHub, catalog, source, instrumented, root, plain };
