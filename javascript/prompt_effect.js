/* Prompt Effect for Forge Neo. Upstream credits: ../NOTICE.md. */
(() => {
    "use strict";

    const NS = "prompt-effect-forge-neo";
    const scriptSource = document.currentScript?.src || "";
    if (document.documentElement.dataset.pefAttached === "true") return;
    document.documentElement.dataset.pefAttached = "true";
    const scope = window.location.pathname.replace(/\/+$/, "") || "/";
    const standaloneHash = `#${NS}`;
    const isStandalone = location.hash === standaloneHash || location.hash.startsWith(`${standaloneHash}?`);
    const link = new URLSearchParams(isStandalone ? location.hash.split("?")[1] || "" : "");
    const codePoints = value => Array.from(value).length;
    function normalizeLibrarySize(value, panel = false) {
        const min = panel ? 130 : 148, max = panel ? 280 : 228, step = panel ? 10 : 4;
        const size = Math.min(max, Math.max(min, Number(value) || (panel ? 130 : 176)));
        return min + Math.round((size - min) / step) * step;
    }
    const uuid = () => {
        if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    const instanceId = uuid();
    let session = isStandalone ? link.get("host") || "" : "";
    let persistenceWarning = "";
    if (!isStandalone) {
        try {
            const key = `${NS}:host:v1:${scope}`;
            session = sessionStorage.getItem(key) || uuid();
            sessionStorage.setItem(key, session);
        } catch { session = uuid(); persistenceWarning = "session_storage"; }
    }
    const keys = {
        state: `${NS}:state:v1:${scope}:${session || instanceId}`,
        prefs: `${NS}:prefs:v1:${scope}`,
        custom: `${NS}:custom:v1:${scope}:`,
        library: `${NS}:library:v1:${scope}:`,
        event: `${NS}:event:v1:${scope}`,
    };
    const defaults = {
        enabled: true, mode: "Preset", selectedPresetId: "realistic_photo", category: "All", query: "",
        styleBoost: "", styleBoostLast:"Photo", customName: "", customDraft: "", customPresetId: null,
        loadedCustomRevision: 0, customBaselineName: "", customBaselineText: "",
    };
    let catalog = null, extensionBase = "", loading = null, ready = false, loadError = "";
    let state = { ...defaults }, revision = { counter: 0, actor: instanceId }, clock = 0;
    const controlRevisions={enabled:{...revision},styleBoost:{...revision}};
    let prefs = { cardSize: 176, drawerCardSize: 130, drawerWidth: 560, locale: "" };
    let stateWritable = true, prefsWritable = true, status = "", composing = 0, deferredState = null;
    let drawer = null, drawerOpener = null, drawerTarget = "txt2img", lastRender = 0;
    let connected = null, discovery = null, pending = null, disposed = false;
    const views = new Map(), processed = new Map();
    const navigationRoots = new WeakSet();
    const libraryVersions = { favorite: new Map(), recent: new Map() };
    let libraryClock = 0;

    function validLibraryOperation(op) {
        return op?.schema_version === 1 && ['favorite','recent'].includes(op.kind)
            && typeof op.item === 'string' && /^(?:[a-z0-9_]+|custom:[0-9a-f-]{36})$/i.test(op.item)
            && typeof op.active === 'boolean' && (op.kind !== 'recent' || op.active)
            && validRevision(op.revision);
    }
    function libraryOperationKey(op) {
        return `${keys.library}${op.kind}:${encodeURIComponent(op.item)}:${op.revision.counter}:${encodeURIComponent(op.revision.actor)}`;
    }
    function libraryOperationKeys() {
        const result = [];
        for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(keys.library)) result.push(key); }
        return result;
    }
    function mergeLibraryOperation(op) {
        if (!validLibraryOperation(op)) return false;
        libraryClock = Math.max(libraryClock, op.revision.counter);
        const previous = libraryVersions[op.kind].get(op.item);
        if (previous && compareRevision(op.revision, previous.revision) <= 0) return false;
        libraryVersions[op.kind].set(op.item, op);
        return true;
    }
    function readLibraryOperations() {
        let changed = false;
        try {
            for (const key of libraryOperationKeys()) {
                try {
                    const op = JSON.parse(localStorage.getItem(key));
                    if (!validLibraryOperation(op) || libraryOperationKey(op) !== key) throw new Error('library_schema');
                    changed = mergeLibraryOperation(op) || changed;
                } catch { persistenceWarning = 'library_unreadable'; }
            }
        } catch { persistenceWarning = 'storage_failed'; }
        return changed;
    }
    function storeLibraryOperation(op) {
        // Save the new immutable operation before removing dominated records.
        // A favorite removal remains as a tombstone so stale tabs cannot undo it.
        if (!writeJSON(libraryOperationKey(op), op)) return;
        try {
            for (const key of libraryOperationKeys()) {
                try {
                    const previous = JSON.parse(localStorage.getItem(key));
                    if (validLibraryOperation(previous) && libraryOperationKey(previous) === key
                        && previous.kind === op.kind && previous.item === op.item
                        && compareRevision(previous.revision, op.revision) < 0) localStorage.removeItem(key);
                } catch { /* Preserve unreadable records. */ }
            }
        } catch { persistenceWarning = 'storage_failed'; }
    }
    function isFavorite(id) { return libraryVersions.favorite.get(id)?.active === true; }
    function recentLibraryIds() {
        return [...libraryVersions.recent.values()].sort((a,b)=>compareRevision(b.revision,a.revision)).slice(0,20).map(op=>op.item);
    }
    function recordLibraryOperation(kind, item, active = true) {
        readLibraryOperations();
        const op = { schema_version:1, kind, item, active, revision:{counter:Math.max(Date.now(),libraryClock+1),actor:instanceId} };
        if (!mergeLibraryOperation(op)) return;
        storeLibraryOperation(op);
        transport.broadcast({type:'library-operation', operation:op});
    }
    function toggleFavorite(id) {
        // Use the clicked state even if a notification from another tab is late.
        const active = !isFavorite(id);
        recordLibraryOperation('favorite', id, active);
        renderAll();
    }
    function receiveLibraryOperation(op) {
        const changed = readLibraryOperations(), received = mergeLibraryOperation(op);
        if (received) storeLibraryOperation(op);
        if (changed || received) renderAll();
    }
    function libraryItems(filter = 'all', records = loadCustomRecords().records, browsing = state) {
        const recent = recentLibraryIds(), query = browsing.query.trim().toLowerCase();
        return [...(catalog?.presets || []), ...records].filter(item =>
            (browsing.category === 'All' || (item.category || 'Custom') === browsing.category)
            && (!query || `${item.name} ${item.category || 'Custom'} ${item.prompt || item.text}`.toLowerCase().includes(query))
            && (filter === 'all' || (filter === 'favorites' ? isFavorite(item.id) : recent.includes(item.id)))
        ).sort((a,b)=>filter === 'recent' ? recent.indexOf(a.id)-recent.indexOf(b.id) : 0);
    }
    function selectPreset(id) {
        if (!catalog?.presets.some(item=>item.id===id)) return;
        if (state.mode !== 'Preset' || state.selectedPresetId !== id) recordLibraryOperation('recent',id);
        commit({selectedPresetId:id,mode:'Preset'});
    }

    function normalizeState(value = {}) {
        const result = { ...defaults };
        for (const key of Object.keys(defaults)) {
            if (typeof defaults[key] === "string" && typeof value[key] === "string") result[key] = value[key];
        }
        result.enabled = value.enabled === undefined ? true : value.enabled === true;
        result.mode = ["Preset", "Custom"].includes(value.mode) ? value.mode : "Preset";
        result.category = ["All", "Photo", "Camera FX", "Art", "Light", "Weather", "Color Theme", "Finish", "Custom"].includes(value.category) ? value.category : "All";
        result.styleBoost = ["Photo", "Anime"].includes(value.styleBoost) ? value.styleBoost : "";
        result.styleBoostLast=result.styleBoost || (['Photo','Anime'].includes(value.styleBoostLast)?value.styleBoostLast:'Photo');
        result.customPresetId = typeof value.customPresetId === "string" && /^custom:[0-9a-f-]{36}$/i.test(value.customPresetId) ? value.customPresetId : null;
        result.loadedCustomRevision = Number.isSafeInteger(value.loadedCustomRevision) && value.loadedCustomRevision >= 0 ? value.loadedCustomRevision : 0;
        return result;
    }

    function composeEffect(data, value) {
        const boostName = ["Photo", "Anime"].includes(value.styleBoost) ? value.styleBoost : "";
        let raw;
        if (value.mode === "Custom") raw = typeof value.customDraft === "string" ? value.customDraft.trim() : "";
        else if (value.mode === "Preset") {
            const preset = data.presets.find(item => item.id === value.selectedPresetId);
            if (!preset) return { preview: "", insertable: false, reason: "unknown_preset" };
            raw = preset.prompt.trim();
        } else return { preview: "", insertable: false, reason: "invalid_mode" };
        const boost = boostName ? data.style_boosts[boostName] : "";
        const preview = !boost || raw.toLowerCase().includes(boost.toLowerCase()) ? raw : raw ? `${raw}, ${boost}` : boost;
        const reason = value.enabled !== true ? "disabled" : !preview ? "empty_effect" : codePoints(preview) > 16000 ? "text_too_long" : "ok";
        return { preview, insertable: reason === "ok", reason };
    }

    // Natural-language insertion boundaries adapted from Background-Prompter.
    function splicePrompt(base, start, end, text) {
        const no = reason => ({ changed: false, value: base, caret: null, reason });
        if (typeof base !== "string" || typeof text !== "string") return no("invalid_type");
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > base.length) return no("invalid_range");
        if (codePoints(text) > 16000) return no("text_too_long");
        let content = text.trim();
        if (!content) return no("empty_effect");
        const before = base.slice(0, start), after = base.slice(end);
        if (/,\s*$/.test(before)) content = content.replace(/^,+\s*/, "");
        if (/^\s*,/.test(after)) content = content.replace(/\s*,+$/, "");
        if (!content) return no("empty_effect");
        const left = before && !/[\s,]$/.test(before) && !/^[\s,]/.test(content) ? "\n" : /,$/.test(before) && !/^[\s,]/.test(content) ? " " : "";
        const right = after && !/^[\s,]/.test(after) && !/[\s,]$/.test(content) ? "\n" : /,$/.test(content) && after && !/^\s/.test(after) ? " " : "";
        return { changed: true, value: before + left + content + right + after, caret: start + left.length + content.length, reason: "ok" };
    }

    function insertEffect(data, value, base, start, end) {
        const effect = composeEffect(data, value);
        return effect.insertable ? splicePrompt(base, start, end, effect.preview) : { changed: false, value: base, caret: null, reason: effect.reason };
    }

    function validateCustom(name, text) {
        if (typeof name !== "string" || typeof text !== "string") return { ok: false, reason: "invalid_type" };
        name = name.trim(); text = text.trim();
        if (!name || !text) return { ok: false, reason: "empty_field" };
        if (codePoints(name) > 80) return { ok: false, reason: "name_too_long" };
        if (codePoints(text) > 12000) return { ok: false, reason: "text_too_long" };
        return { ok: true, name, text };
    }

    function resolveExtensionBase(src = scriptSource) {
        if (!src) {
            const candidates = [...document.scripts].filter(item => /\/javascript\/prompt_effect\.js(?:[?#]|$)/.test(item.src));
            if (candidates.length !== 1) throw new Error("asset_base");
            src = candidates[0].src;
        }
        const url = new URL(src, document.baseURI);
        if (url.origin !== location.origin || !/\/javascript\/prompt_effect\.js$/.test(url.pathname)) throw new Error("asset_base");
        url.search = ""; url.hash = "";
        return url.href.replace(/\/javascript\/prompt_effect\.js$/, "");
    }

    function assetUrl(relative) {
        if (!/^assets\/thumbnails\/[a-z0-9_-]+\.webp$/.test(relative)) throw new Error("invalid_asset");
        return `${extensionBase}/${relative}`;
    }

    function validateCatalog(value) {
        if (value?.schema_version !== 1 || !Array.isArray(value.presets) || value.presets.length !== 176 ||
            !Array.isArray(value.categories) || value.categories.join("|") !== "All|Photo|Camera FX|Art|Light|Weather|Color Theme|Finish|Custom" ||
            !["Photo", "Anime"].every(key => typeof value.style_boosts?.[key] === "string" && value.style_boosts[key])) throw new Error("invalid_catalog");
        const ids = new Set();
        const expected = { Photo: 27, "Camera FX": 24, Art: 14, Light: 13, Weather: 9, "Color Theme": 56, Finish: 33 };
        const counts = {};
        for (const item of value.presets) {
            if (!item || typeof item.id !== "string" || ids.has(item.id) || typeof item.name !== "string" ||
                typeof item.prompt !== "string" || !item.prompt.trim() || !(item.category in expected)) throw new Error("invalid_catalog");
            assetUrl(item.thumbnail);
            ids.add(item.id); counts[item.category] = (counts[item.category] || 0) + 1;
        }
        if (Object.keys(expected).some(key => expected[key] !== counts[key])) throw new Error("invalid_catalog");
        return value;
    }

    function validRevision(value) {
        return value && Number.isSafeInteger(value.counter) && value.counter >= 0 && typeof value.actor === "string" && value.actor.length > 0 && value.actor.length <= 200;
    }
    function compareRevision(a, b) { return a.counter - b.counter || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0); }
    function snapshot() { return { schema_version: 1, state: { ...state }, revision: { ...revision }, controlRevisions:{enabled:{...controlRevisions.enabled},styleBoost:{...controlRevisions.styleBoost}} }; }
    function controlRevision(value, field) { return validRevision(value.controlRevisions?.[field]) ? value.controlRevisions[field] : value.revision; }
    function writeJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch { persistenceWarning = "storage_failed"; return false; }
    }
    function readStoredControls() {
        if (!stateWritable) return;
        try {
            const raw = localStorage.getItem(keys.state);
            if (raw) {
                const old = JSON.parse(raw);
                if (old.schema_version !== 1 || !validRevision(old.revision) || !old.state) throw new Error("state_schema");
                const saved=normalizeState(old.state),controls={};
                for(const field of ['enabled','styleBoost']){
                    const previous=controlRevision(old,field);
                    if(compareRevision(previous,controlRevisions[field])>0){
                        controls[field]=saved[field];if(field==='styleBoost')controls.styleBoostLast=saved.styleBoostLast;
                        controlRevisions[field]={...previous};clock=Math.max(clock,previous.counter);
                    }
                }
                state=normalizeState({...state,...controls});
            }
        } catch { stateWritable = false; persistenceWarning = "state_unreadable"; return; }
    }
    function persistState() { readStoredControls(); if(stateWritable)writeJSON(keys.state,snapshot()); }
    function restore() {
        if (!isStandalone) {
            try {
                const raw = localStorage.getItem(keys.state);
                if (raw) {
                    const value = JSON.parse(raw);
                    if (value.schema_version !== 1 || !validRevision(value.revision) || !value.state) throw new Error("state_schema");
                    state = normalizeState(value.state); revision = value.revision; clock = revision.counter;
                    for(const field of ['enabled','styleBoost']){controlRevisions[field]={...controlRevision(value,field)};clock=Math.max(clock,controlRevisions[field].counter);}
                }
            } catch { stateWritable = false; persistenceWarning = "state_unreadable"; }
        }
        try {
            const raw = localStorage.getItem(keys.prefs);
            if (raw) {
                const value = JSON.parse(raw);
                if (value.schema_version !== 1) throw new Error("prefs_schema");
                const legacyDefault = value.drawerCardSize === undefined && value.cardSize === 180;
                prefs = { cardSize: legacyDefault ? 176 : normalizeLibrarySize(value.cardSize), drawerCardSize: normalizeLibrarySize(value.drawerCardSize, true), drawerWidth: Math.max(320, Number(value.drawerWidth) || 560), locale: ["ja", "en"].includes(value.locale) ? value.locale : "" };
            }
        } catch { prefsWritable = false; persistenceWarning = "state_unreadable"; }
    }
    function commit(change) {
        // A resumed tab may have missed notifications. Read durable control
        // clocks before assigning a new explicit intent, so a click is not lost.
        readStoredControls();
        state = normalizeState({ ...state, ...change });
        revision = { counter: Math.min(Number.MAX_SAFE_INTEGER, ++clock), actor: instanceId };
        for(const field of ['enabled','styleBoost'])if(Object.hasOwn(change,field))controlRevisions[field]={...revision};
        persistState();
        transport.broadcast({ type: "state", snapshot: snapshot() });
        renderAll();
    }
    function receiveState(value, force = false) {
        if (value?.schema_version !== 1 || !value.state || !validRevision(value.revision)) return;
        clock = Math.max(clock, value.revision.counter);
        const incoming=normalizeState(value.state),newer=force || compareRevision(value.revision,revision)>0;
        const controls={enabled:state.enabled,styleBoost:state.styleBoost,styleBoostLast:state.styleBoostLast};
        let controlsChanged=false;
        for(const field of ['enabled','styleBoost']){
            const next=controlRevision(value,field);clock=Math.max(clock,next.counter);
            if(force || compareRevision(next,controlRevisions[field])>0){
                controls[field]=incoming[field];if(field==='styleBoost')controls.styleBoostLast=incoming.styleBoostLast;
                controlRevisions[field]={...next};controlsChanged=true;
            }
        }
        if (composing && newer) {
            if (!deferredState || compareRevision(value.revision, deferredState.revision) > 0) deferredState = value;
            if(controlsChanged){state=normalizeState({...state,...controls});persistState();renderAll();}
            return;
        }
        if(!newer && !controlsChanged)return;
        state = normalizeState({...(newer?incoming:state),...controls});if(newer)revision={...value.revision};
        detachMissingCustom(); persistState(); renderAll();
    }

    function setStyleBoostEnabled(enabled) {
        if(!!state.styleBoost===(enabled===true))return;
        commit({styleBoost:enabled?state.styleBoostLast:''});
    }

    function loadCustomRecords() {
        const records = [], errors = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key?.startsWith(keys.custom)) continue;
                try {
                    const record = JSON.parse(localStorage.getItem(key));
                    const valid = validateCustom(record?.name, record?.text);
                    if (record?.schema_version !== 1 || !valid.ok || key !== keys.custom + String(record.id).replace(/^custom:/, "") ||
                        !/^custom:[0-9a-f-]{36}$/i.test(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error("record_schema");
                    records.push(record);
                } catch { errors.push(key); }
            }
        } catch { errors.push("storage_unavailable"); }
        if (errors.length) persistenceWarning = "records_unreadable";
        records.sort((a, b) => a.name.localeCompare(b.name));
        return { records, errors };
    }
    function detachMissingCustom() {
        if (!state.customPresetId) return;
        const result = loadCustomRecords();
        if (!result.errors.length && !result.records.some(item => item.id === state.customPresetId)) {
            state.customPresetId = null; state.loadedCustomRevision = 0;
        }
    }
    function customDirty() { return state.customName.trim() !== state.customBaselineName.trim() || state.customDraft.trim() !== state.customBaselineText.trim(); }
    function saveCustomRecord(name, text, id = null, expectedRevision = 0) {
        const valid = validateCustom(name, text);
        if (!valid.ok) return valid;
        const { records, errors } = loadCustomRecords();
        if (errors.length) return { ok: false, reason: "records_unreadable" };
        if (records.some(record => record.id !== id && record.name === valid.name)) return { ok: false, reason: "duplicate_name" };
        const old = id && records.find(record => record.id === id);
        if (id && (!old || old.revision !== expectedRevision)) return { ok: false, reason: "revision_conflict" };
        const record = { schema_version: 1, id: id || `custom:${uuid()}`, name: valid.name, text: valid.text, revision: old ? old.revision + 1 : 1, updated_at: new Date().toISOString() };
        if (!writeJSON(keys.custom + record.id.slice(7), record)) return { ok: false, reason: "storage_failed" };
        return { ok: true, record };
    }
    function planImport(value, bytes = 0) {
        if (bytes > 2097152) return { ok: false, reason: "import_too_large" };
        const rows = Array.isArray(value) ? value : value?.schema_version === 1 ? value.presets : null;
        if (!Array.isArray(rows) || rows.length > 500) return { ok: false, reason: "import_invalid" };
        const existing = loadCustomRecords();
        if (existing.errors.length) return { ok: false, reason: "records_unreadable" };
        const names = new Set(existing.records.map(record => record.name));
        const plan = [], rejected = [];
        for (let index = 0; index < rows.length; index++) {
            const valid = validateCustom(rows[index]?.name, rows[index]?.text);
            if (!valid.ok) { rejected.push({ index, reason: valid.reason }); continue; }
            const original = valid.name;
            let suffix = 2;
            while (names.has(valid.name)) valid.name = `${original} (import ${suffix++})`;
            if (codePoints(valid.name) > 80) { rejected.push({ index, reason: "name_too_long" }); continue; }
            names.add(valid.name); plan.push({ name: valid.name, text: valid.text, renamed: valid.name !== original, index });
        }
        return { ok: true, plan, rejected };
    }
    function importCustomPresets(plan) {
        let saved = 0;
        for (const row of plan) {
            const result = saveCustomRecord(row.name, row.text);
            if (!result.ok) return { ok: false, saved, remaining: plan.slice(saved), reason: result.reason };
            saved++;
        }
        return { ok: true, saved, remaining: [] };
    }
    function exportCustomPresets() {
        const value = loadCustomRecords();
        if (value.errors.length) return { ok: false, reason: "records_unreadable" };
        return { ok: true, value: { schema_version: 1, presets: value.records.map(({ name, text }) => ({ name, text })) } };
    }

    function appRoot() { return typeof gradioApp === "function" ? gradioApp() : document; }
    function insertIntoPrompt(target, text) {
        if (isStandalone || !ready) return { ok: false, reason: "not_ready" };
        if (state.enabled !== true) return { ok: false, reason: "disabled" };
        if (!["txt2img", "img2img"].includes(target)) return { ok: false, reason: "invalid_target" };
        if (typeof text !== "string" || !text.trim() || codePoints(text) > 16000) return { ok: false, reason: "invalid_text" };
        const input = appRoot().querySelector(`#${target}_prompt textarea`);
        if (!input) return { ok: false, reason: "prompt_missing" };
        const result = splicePrompt(input.value, input.selectionStart, input.selectionEnd, text);
        if (!result.changed) return { ok: false, reason: result.reason };
        input.value = result.value;
        input.setSelectionRange(result.caret, result.caret);
        if (typeof updateInput === "function") updateInput(input);
        else input.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, reason: "inserted" };
    }

    function createTransport() {
        let channel = null;
        try { if (typeof BroadcastChannel === "function") channel = new BroadcastChannel(`${NS}:v1:${scope}`); } catch { /* storage can still connect */ }
        const receiveBC = event => handleMessage(event.data, "broadcast");
        channel?.addEventListener("message", receiveBC);
        const receiveStorage = event => {
            if (event.key === keys.event && event.newValue) {
                try { handleMessage(JSON.parse(event.newValue).message, "storage"); } catch { /* invalid or unrelated event */ }
            } else if (event.key?.startsWith(keys.custom)) {
                detachMissingCustom(); renderAll();
            } else if (event.key?.startsWith(keys.library) && event.newValue) {
                if (readLibraryOperations()) renderAll();
            }
        };
        window.addEventListener("storage", receiveStorage);
        const envelope = message => ({ protocol: NS, version: 1, scope, session, source: instanceId, ...message });
        function send(message, path) {
            try {
                const value = envelope(message);
                if (path === "broadcast") { if (!channel) return false; channel.postMessage(value); }
                else if (path === "storage") localStorage.setItem(keys.event, JSON.stringify({ nonce: uuid(), message: value }));
                else return false;
                return true;
            } catch { return false; }
        }
        return {
            send,
            broadcast(message) { return [send(message, "broadcast"), send(message, "storage")].some(Boolean); },
            close() { channel?.removeEventListener("message", receiveBC); channel?.close(); window.removeEventListener("storage", receiveStorage); },
        };
    }
    function validEnvelope(message) {
        return message && message.protocol === NS && message.version === 1 && message.scope === scope && message.session === session && session &&
            typeof message.source === "string" && message.source.length > 0 && message.source.length <= 200 && message.source !== instanceId &&
            ["connect-request", "connect-ack", "state", "insert-request", "insert-ack"].includes(message.type) &&
            (["connect-request", "state"].includes(message.type) ? !message.recipient || message.recipient === instanceId : message.recipient === instanceId);
    }
    function requestIdValid(value) { return typeof value === "string" && value.length > 0 && value.length <= 200; }
    function handleMessage(message, path) {
        // Library membership is shared by base path, independently of the linked
        // host session. Drafts and insertion still use validEnvelope below.
        if (!disposed && message?.type === 'library-operation' && message.protocol === NS && message.version === 1
            && message.scope === scope && typeof message.source === 'string' && message.source !== instanceId
            && message.source.length > 0 && message.source.length <= 200 && !message.recipient) {
            receiveLibraryOperation(message.operation); return;
        }
        if (disposed || !validEnvelope(message)) return;
        if (message.type === "connect-request") {
            if (!isStandalone && ready && requestIdValid(message.requestId)) transport.send({ type: "connect-ack", recipient: message.source, requestId: message.requestId, snapshot: snapshot() }, path);
        } else if (message.type === "connect-ack") {
            if (!isStandalone || !discovery || message.requestId !== discovery.id || !validRevision(message.snapshot?.revision) || message.snapshot?.schema_version !== 1) return;
            const candidate = discovery.candidates.get(message.source) || { source: message.source, paths: new Set() };
            candidate.paths.add(path); candidate.snapshot = message.snapshot;
            discovery.candidates.set(message.source, candidate);
        } else if (message.type === "state") {
            if (isStandalone && (!connected || message.source !== connected.source)) return;
            receiveState(message.snapshot);
        } else if (message.type === "insert-request") {
            if (isStandalone || !requestIdValid(message.requestId) || !["txt2img", "img2img"].includes(message.target) ||
                typeof message.text !== "string" || !message.text.trim() || codePoints(message.text) > 16000) return;
            const key = JSON.stringify([message.source, message.requestId]);
            let result = processed.get(key);
            if (!result) {
                result = insertIntoPrompt(message.target, message.text);
                processed.set(key, result);
                if (processed.size > 100) processed.delete(processed.keys().next().value);
            }
            transport.send({ type: "insert-ack", recipient: message.source, requestId: message.requestId, ...result }, path);
        } else if (message.type === "insert-ack") {
            if (!isStandalone || !pending || message.source !== pending.source || path !== pending.path || message.requestId !== pending.id || typeof message.ok !== "boolean") return;
            clearTimeout(pending.timer); pending = null;
            setStatus(message.ok ? "inserted" : message.reason || "send_failed");
        }
    }
    function reconnectHost() {
        if (!isStandalone || !session || discovery || pending) return;
        connected = null;
        discovery = { id: uuid(), candidates: new Map(), timer: null };
        setStatus("connecting");
        const sent = transport.broadcast({ type: "connect-request", requestId: discovery.id });
        if (!sent) { discovery = null; setStatus("send_failed"); return; }
        discovery.timer = setTimeout(() => {
            const candidates = [...discovery.candidates.values()];
            discovery = null;
            if (candidates.length !== 1) { setStatus(candidates.length ? "ambiguous" : "disconnected"); return; }
            const candidate = candidates[0];
            connected = { source: candidate.source, path: candidate.paths.has("broadcast") ? "broadcast" : "storage" };
            receiveState(candidate.snapshot, true);
            setStatus("connected");
        }, 350);
    }
    function requestInsert(target) {
        if (!catalog || pending || discovery) return;
        const effect = composeEffect(catalog, state);
        if (!effect.insertable) { setStatus(effect.reason); return; }
        if (!isStandalone) { const result = insertIntoPrompt(target, effect.preview); setStatus(result.ok ? "inserted" : result.reason); return; }
        if (!connected) { setStatus("disconnected"); return; }
        const id = uuid(), { source, path } = connected;
        pending = { id, source, path, timer: setTimeout(() => { pending = null; connected = null; setStatus("uncertain"); }, 1800) };
        if (!transport.send({ type: "insert-request", requestId: id, recipient: source, target, text: effect.preview }, path)) {
            if (pending) clearTimeout(pending.timer);
            pending = null; connected = null; setStatus("send_failed"); return;
        }
        if (pending) setStatus("sending");
    }
    const transport = createTransport();
    restore();
    readLibraryOperations();

    const strings = {
        en: {
            subtitle: "176 prompt effects", enabled: "Enable", preview: "Effect preview", search: "Search effects…", size: "Card size",
            favorites: "Favorites", recent: "Recent", favorite: "Favorite", favorited: "Favorited", library_filters: "Effect filter", drawer_search: "Search recent and favorites...",
            library_unreadable: "Some favorites or history records cannot be read and were preserved. Other records remain available.",
            boost: "Style Boost", off: "Off", Photo: "Photo", Anime: "Anime", All: "All", Custom: "Custom", "Camera FX": "Camera FX", Art: "Art", Light: "Light", Weather: "Weather", "Color Theme": "Color Theme", Finish: "Finish",
            enable_boost:"Enable Style Boost",
            tab: "Open prompter", panel: "Choose in side panel", new_tab: "Open in new tab", close: "Close", copy_custom: "Copy to Custom", copy: "Copy",
            insert_txt2img: "Insert into txt2img", insert_img2img: "Insert into img2img", name: "Preset name", draft: "Custom text", saved: "Saved presets",
            save: "Save", save_as: "Save As", load: "Load", delete: "Delete", import: "Import JSON", export: "Export JSON", draft_copy: "Copy draft",
            storage_note: "Custom presets are stored in this browser, origin and base path. Use JSON to move them.",
            off_note: "Insertion follows Enable on the original WebUI bar. Style Boost only adds the selected style phrase.", dirty: "Unsaved changes", clean: "Draft saved / unchanged",
            discard: "Replace the unsaved Custom name and text?", delete_confirm: "Delete this saved preset? Your current draft will stay.",
            new_name: "Name for a new Custom preset", no_matches: "No matching effects.", retry: "Retry loading", loading: "Loading Prompt Effect…", load_failed: "Could not load effects. Retry loading.",
            asset_base: "Could not locate this extension's script URL.", invalid_catalog: "The effect catalog is invalid.", unknown_preset: "The selected preset is missing. Select another effect.",
            disabled: "Enable on the original WebUI bar is off. Preview and edits are kept.", empty_effect: "The effect text is empty.", inserted: "Inserted into the selected Positive prompt.",
            prompt_missing: "The target Positive prompt is unavailable.", invalid_range: "The prompt selection is invalid. Select the insertion point again.", invalid_target: "Invalid insertion target.", invalid_text: "Invalid effect text.", not_ready: "Effects are not ready.",
            empty_field: "Enter a name and text.", name_too_long: "Names can contain up to 80 characters. Rename the item before importing.", text_too_long: "The text exceeds the character limit.", invalid_type: "The name and text must be strings.",
            duplicate_name: "That name is already used. Choose another name.", revision_conflict: "This preset changed elsewhere. Reload it or use Save As.",
            storage_failed: "Browser storage failed. Your draft is still available here; copy it or export saved presets.",
            records_unreadable: "Some Custom records cannot be read. They were preserved. Copy your draft; repair the browser storage before saving.",
            state_unreadable: "Stored UI state could not be read and was preserved. This page keeps edits in memory.", session_storage: "Session storage is unavailable. Reconnection after reload may be unavailable.",
            custom_saved: "Custom preset saved.", custom_loaded: "Custom preset loaded.", custom_deleted: "Saved preset deleted; draft kept.", choose_saved: "Choose a saved preset.",
            import_too_large: "Import files must be at most 2 MiB.", import_invalid: "Use an array of name/text records or schema_version 1, with at most 500 presets.",
            import_review: "Import preview", import_ready: "Ready", import_rejected: "Rejected", import_confirm: "Add these presets", cancel: "Cancel", imported: "Imported", remaining: "Not saved", renamed: "renamed",
            export_done: "Custom presets exported.", copied: "Copied.", copy_failed: "Clipboard unavailable. Select and copy the text directly.",
            reconnect: "Reconnect", connecting: "Connecting to the original WebUI…", connected: "Connected to the original WebUI.", sending: "Sending…",
            disconnected: "Original WebUI is unavailable. Keep it open and reconnect.", ambiguous: "Multiple WebUI pages share this session. Open a new picker from the intended page.",
            send_failed: "Could not send. No automatic retry was made. Reconnect before inserting again.", uncertain: "No reply. The text may already be inserted; check the original prompt before trying again.",
            modal_busy: "Close the other side panel or dialog before opening Prompt Effect.", resize: "Side panel width", image_missing: "Preview unavailable", popups: "Allow popups to open the picker.", language: "Language",
        },
        ja: {
            subtitle: "エフェクト176件", enabled: "有効", preview: "効果プレビュー", search: "エフェクトを検索…", size: "カードサイズ",
            favorites: "お気に入り", recent: "最近使用", favorite: "お気に入り", favorited: "お気に入り済み", library_filters: "エフェクトの絞り込み", drawer_search: "最近・お気に入りを検索...",
            library_unreadable: "読めないお気に入り・履歴は保持しました。他の記録は引き続き利用できます。",
            boost: "スタイルブースト", off: "なし", Photo: "写真", Anime: "アニメ", All: "すべて", Custom: "カスタム", "Camera FX": "カメラ効果", Art: "アート", Light: "光", Weather: "天候", "Color Theme": "配色", Finish: "仕上げ",
            enable_boost:"スタイルブーストを有効",
            tab: "プロンプターを開く", panel: "サイドパネルで選ぶ", new_tab: "別タブで開く", close: "閉じる", copy_custom: "カスタムへコピー", copy: "コピー",
            insert_txt2img: "txt2imgへ挿入", insert_img2img: "img2imgへ挿入", name: "プリセット名", draft: "カスタム本文", saved: "保存済みプリセット",
            save: "保存", save_as: "別名で保存", load: "読み込み", delete: "削除", import: "JSON取り込み", export: "JSON書き出し", draft_copy: "編集中の本文をコピー",
            storage_note: "カスタムはこのブラウザー・オリジン・ベースパスに保存されます。移動にはJSONを使用します。",
            off_note: "挿入の有効・無効は元のWebUIの外側バーで切り替えます。スタイルブーストは追加のスタイル文だけを制御します。", dirty: "未保存の変更あり", clean: "保存済み／変更なし",
            discard: "未保存のカスタム名と本文を置き換えますか？", delete_confirm: "保存済みプリセットを削除しますか？編集中の本文は残ります。",
            new_name: "新しいカスタムプリセット名", no_matches: "条件に一致するエフェクトがありません。", retry: "再読み込み", loading: "Prompt Effectを読み込み中…", load_failed: "エフェクトを読み込めませんでした。再読み込みしてください。",
            asset_base: "拡張のスクリプトURLを特定できません。", invalid_catalog: "エフェクトのカタログが不正です。", unknown_preset: "選択したプリセットが見つかりません。選び直してください。",
            disabled: "元のWebUIの外側バーで有効がOFFになっています。プレビューと編集内容は保持しています。", empty_effect: "効果文が空です。", inserted: "指定したPositiveへ挿入しました。",
            prompt_missing: "挿入先のPositiveが見つかりません。", invalid_range: "選択範囲が不正です。挿入位置を選び直してください。", invalid_target: "挿入先が不正です。", invalid_text: "効果文が不正です。", not_ready: "エフェクトの準備ができていません。",
            empty_field: "名前と本文を入力してください。", name_too_long: "名前は80文字以内です。取り込む場合は元の名前を短くしてください。", text_too_long: "文字数の上限を超えています。", invalid_type: "名前と本文は文字列で指定してください。",
            duplicate_name: "同名のプリセットがあります。別の名前を入力してください。", revision_conflict: "別の画面で更新されています。再読み込み、または別名で保存してください。",
            storage_failed: "ブラウザーへの保存に失敗しました。編集中の本文は保持しています。コピー、または保存済みJSONの書き出しをご利用ください。",
            records_unreadable: "読み込めないカスタムがあります。元データは保持しています。本文をコピーし、保存領域を確認してください。",
            state_unreadable: "保存済みの表示状態を読めないため保持しました。この画面の編集はメモリー上で続けられます。", session_storage: "セッション保存を使えません。再読み込み後に再接続できない場合があります。",
            custom_saved: "カスタムを保存しました。", custom_loaded: "カスタムを読み込みました。", custom_deleted: "保存済みプリセットを削除しました。編集中の本文は保持しています。", choose_saved: "保存済みプリセットを選択してください。",
            import_too_large: "取り込みは2MiB以内です。", import_invalid: "名前・本文の配列、またはschema_version 1のJSONを指定してください。上限500件です。",
            import_review: "取り込み内容の確認", import_ready: "追加予定", import_rejected: "取り込み不可", import_confirm: "この内容を追加", cancel: "キャンセル", imported: "保存済み", remaining: "未保存", renamed: "改名",
            export_done: "カスタムを書き出しました。", copied: "コピーしました。", copy_failed: "クリップボードを使えません。本文を選択してコピーしてください。",
            reconnect: "再接続", connecting: "元のWebUIへ接続中…", connected: "元のWebUIに接続しました。", sending: "送信中…",
            disconnected: "元のWebUIに接続できません。元の画面を開いて再接続してください。", ambiguous: "同じセッションのWebUIが複数あります。対象のWebUIから別タブを開き直してください。",
            send_failed: "送信できませんでした。自動再送はしていません。再接続してから挿入してください。", uncertain: "応答がありません。反映済みの可能性があるため、再操作の前に元のプロンプトを確認してください。",
            modal_busy: "他のサイドパネルやダイアログを閉じてから開いてください。", resize: "サイドパネル幅", image_missing: "画像なし", popups: "別タブを開くにはポップアップを許可してください。", language: "言語",
        },
    };
    function locale() {
        if (prefs.locale) return prefs.locale;
        const selected = typeof opts !== "undefined" ? opts.localization : window.opts?.localization;
        return /ja|japan|日本/i.test(String(selected || "")) || (!selected && navigator.language?.startsWith("ja")) ? "ja" : "en";
    }
    function t(key) { return strings[locale()][key] || strings.en[key] || key; }
    function esc(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
    function setStatus(value) { status = value; renderAll(); }
    function setText(element, value) { if (element && element.textContent !== value) element.textContent = value; }
    function setValue(element, value) {
        if (!element || element.value === value || element.dataset.pefComposing) return;
        const focused = activeElement() === element;
        const start = focused ? element.selectionStart : null, end = focused ? element.selectionEnd : null;
        const direction = element.selectionDirection, scrollTop = element.scrollTop, scrollLeft = element.scrollLeft;
        element.value = value;
        if (focused && typeof start === "number" && typeof end === "number") {
            element.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length), direction || "none");
            element.scrollTop = scrollTop; element.scrollLeft = scrollLeft;
        }
    }
    function button(action, label, attributes = "") { return `<button type="button" data-pef-action="${action}" ${attributes}>${esc(label)}</button>`; }
    function activeElement() { return appRoot().activeElement || document.activeElement; }
    function confirmDraft() { return !customDirty() || window.confirm(t("discard")); }
    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); setStatus("copied"); }
        catch { setStatus("copy_failed"); }
    }

    function renderPicker(root, panel = false) {
        let view = views.get(root);
        if (!view) {
            root.classList.add("pef-app");
            root.innerHTML = `<header class="pef-header"><div><strong>Prompt Effect</strong><span data-pef-subtitle></span></div><div class="pef-row">
                <select data-pef-field="locale" aria-label="Language"><option value="">Auto</option><option value="ja">日本語</option><option value="en">English</option></select>
                ${panel ? button("close", t("close")) : ""}</div></header>
                <section class="pef-effect"><label><span data-pef-label="preview"></span><textarea data-pef-preview readonly rows="3"></textarea></label>
                <small data-pef-off-note></small></section>
                <div class="pef-toolbar"><input type="search" data-pef-field="query"><label><span data-pef-label="size"></span><input type="range" data-pef-field="cardSize"></label></div>
                <div class="pef-row pef-boost"><label class="pef-boost-enable"><input type="checkbox" data-pef-field="styleBoostEnabled"><span data-pef-label="enable_boost"></span></label>${["", "Photo", "Anime"].map(value => button("boost", t(value || "off"), `data-pef-value="${value}" aria-pressed="false"`)).join("")}</div>
                <nav class="pef-categories" aria-label="${t('library_filters')}">${['all','recent','favorites'].map(value => button('view',t(value==='all'?'All':value),`data-pef-value="${value}" aria-pressed="false"`)).join('')}</nav>
                <div class="pef-count" data-pef-count></div><div class="pef-grid" data-pef-grid></div>
                <section class="pef-custom" data-pef-custom hidden>
                    <div class="pef-row"><label class="pef-grow"><span data-pef-label="name"></span><input type="text" data-pef-field="customName"></label><span data-pef-dirty></span></div>
                    <label><span data-pef-label="draft"></span><textarea data-pef-field="customDraft" rows="5"></textarea></label>
                    <div class="pef-row">${button("save", t("save"))}${button("save-as", t("save_as"))}${button("copy-draft", t("draft_copy"))}</div>
                    <div class="pef-row"><label class="pef-grow"><span data-pef-label="saved"></span><select data-pef-saved></select></label>${button("load", t("load"))}${button("delete", t("delete"))}</div>
                    <div class="pef-row">${button("import", t("import"))}${button("export", t("export"))}<input type="file" data-pef-import accept=".json,application/json" hidden></div>
                    <div data-pef-import-review hidden></div><p class="pef-note" data-pef-label="storage_note"></p>
                </section>
                <div class="pef-footer"><div class="pef-insert-actions">${["txt2img", "img2img"].map(target => button("insert", t(`insert_${target}`), `data-pef-target="${target}" class="pef-primary"`)).join("")}</div>
                    <div class="pef-row">${button("copy-custom", t("copy_custom"))}${button("copy", t("copy"))}${isStandalone ? button("reconnect", t("reconnect")) : button("new-tab", t("new_tab"))}</div>
                    <p data-pef-status role="status" aria-live="polite"></p><p class="pef-note" data-pef-warning></p></div>`;
            // Browse conditions are local to this view. Legacy snapshot fields
            // must not restore a host's search/category into a newly opened picker.
            view = { root, panel, filter: 'all', query:'', category:'All', gridKey: "", language: "", savedKey: "", importPlan: null };
            views.set(root, view);
            arrangePicker(view);
            root.addEventListener("click", handleAction);
            root.addEventListener("input", handleInput);
            root.addEventListener("change", handleChange);
            root.addEventListener("compositionstart", event => {
                if (!event.target.matches("[data-pef-field]")) return;
                event.target.dataset.pefComposing = "true"; composing++;
            });
            root.addEventListener("compositionend", event => {
                if (!event.target.dataset.pefComposing) return;
                delete event.target.dataset.pefComposing; composing = Math.max(0, composing - 1);
                handleInput(event);
                if (!composing && deferredState) { const value = deferredState; deferredState = null; receiveState(value); }
            });
        }
        updatePicker(view);
    }
    function arrangePicker({root, panel}) {
        root.classList.toggle('pef-panel-app', panel);
        const header = root.querySelector('.pef-header');
        const title = header.firstElementChild;
        if (panel) title.innerHTML = `<span>${locale() === 'ja' ? 'クイックエフェクト' : 'Quick Effects'}</span><h2 data-pef-panel-target>${drawerTarget}</h2>`;
        const close = header.querySelector('[data-pef-action="close"]');
        if (close) header.append(close);
        const boost = root.querySelector('.pef-boost');
        // Photo/Anime already toggle off when pressed again, as in Background.
        boost.querySelector('[data-pef-value=""]').hidden = true;
        const localeInput = header.querySelector('[data-pef-field="locale"]');
        const preferences = document.createElement('label'); preferences.className='pef-preferences';
        preferences.innerHTML='<span data-pef-label="language"></span>'; preferences.append(localeInput);
        header.querySelector('.pef-row').remove();
        const actions = document.createElement('div'); actions.className = 'pef-top-actions';
        const inserts=root.querySelector('.pef-insert-actions');
        actions.append(...inserts.children, root.querySelector('[data-pef-action="copy"]')); inserts.remove();
        actions.insertAdjacentHTML('beforeend', button('reset', locale() === 'ja' ? 'プリセットへ戻す' : 'Reset to preset'));
        const navigation=root.querySelector(isStandalone ? '[data-pef-action="reconnect"]' : '[data-pef-action="new-tab"]');
        if(!panel && navigation) actions.append(navigation);
        if(isStandalone && !panel) actions.insertAdjacentHTML('beforeend',button('new-tab',t('new_tab')));
        const scopes=document.createElement('div');scopes.className='pef-scope-controls';scopes.append(boost);
        const controls=document.createElement('div'); controls.className='pef-titlebar-controls'; controls.append(scopes,actions);
        const top = document.createElement('div'); top.className = 'pef-picker-top';
        top.append(header,controls);
        root.prepend(top);
        if(isStandalone && !panel) top.insertAdjacentHTML('beforebegin','<p class="pef-connection" data-pef-connection role="status"></p>');
        const toolbar = root.querySelector('.pef-toolbar');
        const search = toolbar.firstElementChild;
        const label = document.createElement('label'); label.className='pef-search-label'; label.innerHTML=`<span>${locale() === 'ja' ? '検索' : 'Search'}</span>`; label.append(search); toolbar.prepend(label);
        const category = document.createElement('label'); category.className='pef-category-select';
        category.innerHTML=`<span>${locale() === 'ja' ? 'カテゴリ' : 'Category'}</span><select data-pef-field="category">${['All','Photo','Camera FX','Art','Light','Weather','Color Theme','Finish','Custom'].map(c=>`<option value="${c}">${esc(t(c))}</option>`).join('')}</select>`;
        toolbar.insertBefore(category,label.nextSibling);
        const layout = document.createElement('div'); layout.className='pef-library-layout';
        const library = document.createElement('div'); library.className='pef-library';
        const detail = document.createElement('aside'); detail.className='pef-detail';
        detail.innerHTML='<div class="pef-detail-heading"><span>Prompt Effect</span><strong data-pef-detail-name></strong></div>';
        library.append(root.querySelector('[data-pef-count]'),root.querySelector('[data-pef-grid]'));
        detail.append(root.querySelector('.pef-effect'),root.querySelector('[data-pef-custom]'),root.querySelector('.pef-footer'));
        detail.append(preferences);
        layout.append(library,detail); toolbar.after(layout);
        toolbar.append(root.querySelector('.pef-categories'));
        const sizeRow=document.createElement('div'); sizeRow.className='pef-library-size-row';
        const size=root.querySelector('[data-pef-field="cardSize"]');
        const sizeLabel=size.closest('label'); sizeLabel.className='pef-library-size';
        size.min=panel?'130':'148'; size.max=panel?'280':'228'; size.step=panel?'10':'4';
        sizeRow.append(sizeLabel,root.querySelector('[data-pef-count]')); toolbar.append(sizeRow);
    }
    function updatePicker(view) {
        const { root } = view;
        const language = locale();
        if (view.language !== language) {
            view.language = language; view.gridKey = ""; view.savedKey = "";
            setText(root.querySelector('.pef-search-label > span'),language==='ja'?'検索':'Search');
            setText(root.querySelector('.pef-category-select > span'),language==='ja'?'カテゴリ':'Category');
            setText(root.querySelector('[data-pef-action="reset"]'),language==='ja'?'プリセットへ戻す':'Reset to preset');
            root.querySelectorAll('[data-pef-field="category"] option').forEach(node=>setText(node,node.value==='All'?(language==='ja'?'すべてのカテゴリ':'All categories'):t(node.value)));
            root.querySelectorAll("[data-pef-label]").forEach(node => setText(node, t(node.dataset.pefLabel)));
            const labels = { close: "close", save: "save", "save-as": "save_as", "copy-draft": "draft_copy", load: "load", delete: "delete", import: "import", export: "export", "copy-custom": "copy_custom", copy: "copy", reconnect: "reconnect", "new-tab": "new_tab" };
            root.querySelectorAll("[data-pef-action]").forEach(node => {
                const action = node.dataset.pefAction;
                if (labels[action]) setText(node, t(labels[action]));
                if (action === 'view') setText(node,t(node.dataset.pefValue==='all'?'All':node.dataset.pefValue));
                if (action === "boost") setText(node, t(node.dataset.pefValue || "off"));
                if (action === "insert") setText(node, t(`insert_${node.dataset.pefTarget}`));
            });
            root.querySelector('.pef-categories').setAttribute('aria-label',t('library_filters'));
            root.querySelector('[data-pef-field="query"]').placeholder = t(view.panel?'drawer_search':'search');
            root.querySelector('[data-pef-field="query"]').setAttribute("aria-label", t("search"));
            root.querySelector('[data-pef-field="locale"]').setAttribute("aria-label", t("language"));
        }
        setText(root.querySelector("[data-pef-subtitle]"), t("subtitle"));
        setText(root.querySelector('[data-pef-connection]'),t(discovery?'connecting':connected?'connected':status==='ambiguous'?'ambiguous':'disconnected'));
        if(!view.panel) setText(root.querySelector('[data-pef-action="new-tab"]'),language==='ja'?'別ブラウザータブで開く':'Open in browser tab');
        setText(root.querySelector('[data-pef-detail-name]'),state.mode === 'Custom' ? state.customName || t('Custom') : catalog?.presets.find(p=>p.id===state.selectedPresetId)?.name || '');
        setText(root.querySelector('[data-pef-panel-target]'), drawerTarget);
        setValue(root.querySelector('[data-pef-field="category"]'),view.category);
        const effect = catalog ? composeEffect(catalog, state) : { preview: "", insertable: false, reason: "not_ready" };
        setValue(root.querySelector("[data-pef-preview]"), effect.preview);
        setText(root.querySelector("[data-pef-off-note]"), t("off_note"));
        setValue(root.querySelector('[data-pef-field="query"]'),view.query);
        for (const field of ["customName", "customDraft"]) setValue(root.querySelector(`[data-pef-field="${field}"]`), state[field]);
        root.querySelector('[data-pef-field="styleBoostEnabled"]').checked=!!state.styleBoost;
        const cardSize=view.panel?prefs.drawerCardSize:prefs.cardSize;
        setValue(root.querySelector('[data-pef-field="cardSize"]'), String(cardSize));
        setValue(root.querySelector('[data-pef-field="locale"]'), prefs.locale);
        setText(root.querySelector('[data-pef-label="size"]'),view.panel?(language==='ja'?'サムネイルサイズ':'Thumbnail size'):t('size'));
        root.querySelectorAll('[data-pef-action="boost"]').forEach(node => node.setAttribute("aria-pressed", String(node.dataset.pefValue === state.styleBoost)));
        root.querySelectorAll('[data-pef-action="view"]').forEach(node => node.setAttribute('aria-pressed',String(node.dataset.pefValue === view.filter)));
        root.querySelector("[data-pef-custom]").hidden = state.mode !== "Custom";
        setText(root.querySelector("[data-pef-dirty]"), t(customDirty() ? "dirty" : "clean"));
        const records = loadCustomRecords().records;
        const savedKey = JSON.stringify(records.map(item => [item.id, item.name, item.revision]));
        if (view.savedKey !== savedKey) {
            const select = root.querySelector("[data-pef-saved]"), selected = select.value || state.customPresetId || "";
            select.innerHTML = `<option value="">${esc(t("choose_saved"))}</option>` + records.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
            select.value = records.some(item => item.id === selected) ? selected : "";
            view.savedKey = savedKey;
        }
        const filtered = libraryItems(view.filter,records,view);
        const gridKey = JSON.stringify([view.category,view.query,state.mode,state.selectedPresetId,state.customPresetId,cardSize,savedKey,language,view.filter,filtered.map(item=>[item.id,isFavorite(item.id)])]);
        if (view.gridKey !== gridKey) {
            const grid = root.querySelector("[data-pef-grid]");
            grid.style.setProperty("--pef-card-size", `${cardSize}px`);
            grid.innerHTML = filtered.length ? filtered.map(item => {
                const custom=item.id.startsWith('custom:'),chosen=custom?state.mode==='Custom'&&item.id===state.customPresetId:state.mode==='Preset'&&item.id===state.selectedPresetId;
                const favorite=isFavorite(item.id);
                return `<article class="pef-card${chosen?' is-selected':''}" data-pef-id="${esc(item.id)}">
                    <button type="button" class="pef-card-select" data-pef-action="${custom?'load-custom':'preset'}" data-pef-id="${esc(item.id)}" aria-pressed="${chosen}" title="${esc(item.name+'\n'+(item.prompt||item.text))}">
                    ${custom?`<span class="pef-image-missing">${esc(t('Custom'))}</span>`:`<img src="${esc(assetUrl(item.thumbnail))}" alt="" loading="lazy" decoding="async" width="192" height="128">`}
                    <span class="pef-card-copy"><strong>${esc(item.name)}</strong><small>${esc(t(item.category||'Custom'))}</small></span></button>
                    <button type="button" class="pef-favorite" data-pef-action="favorite" data-pef-id="${esc(item.id)}" aria-pressed="${favorite}" aria-label="${esc(t(favorite?'favorited':'favorite')+': '+item.name)}">${esc(t(favorite?'favorited':'favorite'))}</button></article>`;
            }).join("") : `<p class="pef-empty">${esc(t("no_matches"))}</p>`;
            grid.querySelectorAll("img").forEach(img => img.addEventListener("error", () => { const replacement = document.createElement("span"); replacement.className = "pef-image-missing"; replacement.textContent = t("image_missing"); img.replaceWith(replacement); }, { once: true }));
            view.gridKey = gridKey;
        }
        setText(root.querySelector("[data-pef-count]"), `${filtered.length} / ${view.category === "Custom" ? records.length : 176+records.length}`);
        root.querySelectorAll('[data-pef-action="insert"]').forEach(node => {
            node.disabled = !ready || !effect.insertable || !!pending || !!discovery || (isStandalone && !connected);
            node.title = node.disabled ? t(!effect.insertable ? effect.reason : status || "disconnected") : t(`insert_${node.dataset.pefTarget}`);
            node.classList.toggle("pef-current-target", view.panel && node.dataset.pefTarget === drawerTarget);
            node.hidden = view.panel && node.dataset.pefTarget !== drawerTarget;
        });
        root.querySelector('[data-pef-action="copy-custom"]').disabled = !catalog?.presets.some(item => item.id === state.selectedPresetId);
        root.querySelector('[data-pef-action="save"]').disabled = !validateCustom(state.customName, state.customDraft).ok;
        root.querySelector('[data-pef-action="save-as"]').disabled = !state.customDraft.trim();
        const reconnect = root.querySelector('[data-pef-action="reconnect"]');
        if (reconnect) reconnect.disabled = !!discovery || !!pending;
        setText(root.querySelector("[data-pef-status]"), status ? t(status) : !effect.insertable ? t(effect.reason) : "");
        setText(root.querySelector("[data-pef-warning]"), persistenceWarning ? t(persistenceWarning) : "");
        const favoriteReference=appRoot().querySelector(view.panel?'#k2bg-drawer-host .k2bg-favorite':'#k2bg-app .k2bg-favorite');
        // Gradio applies different button padding inside its normal-tab prose.
        // Follow the installed series control just as the common header does.
        if(favoriteReference){const padding=getComputedStyle(favoriteReference).padding;root.querySelectorAll('.pef-favorite').forEach(node=>{if(node.style.padding!==padding)node.style.padding=padding;});}
    }

    function handleInput(event) {
        const field = event.target.dataset?.pefField;
        if (!field || event.isComposing || event.target.dataset.pefComposing) return;
        const view=views.get(event.target.closest('.pef-app'));
        if(field==='query' && view)view.query=event.target.value;
        if (["query", "customName", "customDraft"].includes(field)) commit({ [field]: event.target.value });
        if (field === "cardSize") {
            const panel=views.get(event.target.closest('.pef-app'))?.panel;
            prefs[panel?'drawerCardSize':'cardSize'] = normalizeLibrarySize(event.target.value, panel);
            if (prefsWritable) writeJSON(keys.prefs, { schema_version: 1, ...prefs });
            renderAll();
        }
    }
    async function handleChange(event) {
        const field = event.target.dataset?.pefField;
        const view=views.get(event.target.closest('.pef-app'));
        if (field === "enabled") commit({ enabled: event.target.checked });
        if(field==='styleBoostEnabled')setStyleBoostEnabled(event.target.checked);
        if (field === "category") { if(view)view.category=event.target.value; commit({category:event.target.value,mode:event.target.value==='Custom'?'Custom':'Preset'}); }
        if (field === "locale") { prefs.locale = event.target.value; if (prefsWritable) writeJSON(keys.prefs, { schema_version: 1, ...prefs }); renderAll(); }
        if (!event.target.matches("[data-pef-import]")) return;
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            if (file.size > 2097152) { setStatus("import_too_large"); return; }
            const result = planImport(JSON.parse(await file.text()), file.size);
            if (!result.ok) { setStatus(result.reason); return; }
            view.importPlan = result.plan;
            const review = view.root.querySelector("[data-pef-import-review]");
            review.hidden = false;
            review.innerHTML = `<h3>${esc(t("import_review"))}</h3><p>${esc(t("import_ready"))}: ${result.plan.length} · ${esc(t("import_rejected"))}: ${result.rejected.length}</p>
                <ul>${result.plan.map(item => `<li>${esc(item.name)}${item.renamed ? ` (${esc(t("renamed"))})` : ""}</li>`).join("")}${result.rejected.map(item => `<li>#${item.index + 1}: ${esc(t(item.reason))}</li>`).join("")}</ul>
                ${button("import-confirm", t("import_confirm"), result.plan.length ? "" : "disabled")}${button("import-cancel", t("cancel"))}`;
        } catch { setStatus("import_invalid"); }
        finally { event.target.value = ""; }
    }
    function loadCustom(id) {
        const record = loadCustomRecords().records.find(item => item.id === id);
        if (!record) { setStatus("choose_saved"); return; }
        if (!confirmDraft()) return;
        if (state.mode !== 'Custom' || state.customPresetId !== id) recordLibraryOperation('recent',id);
        commit({ mode: "Custom", category: "Custom", customPresetId: id, customName: record.name, customDraft: record.text,
            loadedCustomRevision: record.revision, customBaselineName: record.name, customBaselineText: record.text });
        setStatus("custom_loaded");
        return true;
    }
    async function handleAction(event) {
        const node = event.target.closest?.("[data-pef-action]");
        if (!node || node.disabled) return;
        const action = node.dataset.pefAction, root = node.closest(".pef-app"), view = views.get(root);
        if (action === 'preset') selectPreset(node.dataset.pefId);
        else if (action === 'favorite') toggleFavorite(node.dataset.pefId);
        else if (action === 'view') { view.filter=node.dataset.pefValue; updatePicker(view); }
        else if (action === "boost") commit({ styleBoost: state.styleBoost === node.dataset.pefValue ? "" : node.dataset.pefValue });
        else if (action === "insert") requestInsert(node.dataset.pefTarget);
        else if (action === "reset") { view.category=catalog?.presets.find(p=>p.id===state.selectedPresetId)?.category || 'All'; commit({mode:'Preset',category:view.category}); }
        else if (action === "copy") { if (catalog) await copyText(composeEffect(catalog, state).preview); }
        else if (action === "copy-draft") await copyText(state.customDraft);
        else if (action === "copy-custom") {
            const preset = catalog?.presets.find(item => item.id === state.selectedPresetId);
            if (preset && confirmDraft()) { view.category='Custom'; commit({ mode: "Custom", category: "Custom", customDraft: preset.prompt, customName: "", customPresetId: null, loadedCustomRevision: 0, customBaselineName: "", customBaselineText: "" }); }
        } else if (action === "save" || action === "save-as") {
            let name = state.customName;
            if (action === "save-as") { name = window.prompt(t("new_name"), state.customName ? `${state.customName} (copy)` : ""); if (name === null) return; }
            const result = saveCustomRecord(name, state.customDraft, action === "save" ? state.customPresetId : null, state.loadedCustomRevision);
            if (!result.ok) { setStatus(result.reason); return; }
            const { record } = result;
            commit({ customName: record.name, customDraft: record.text, customPresetId: record.id, loadedCustomRevision: record.revision, customBaselineName: record.name, customBaselineText: record.text });
            setStatus("custom_saved");
        } else if (action === "load-custom" || action === "load") { if(loadCustom(node.dataset.pefId || root.querySelector("[data-pef-saved]").value)){view.category='Custom';updatePicker(view);} }
        else if (action === "delete") {
            const id = root.querySelector("[data-pef-saved]").value;
            if (!id) { setStatus("choose_saved"); return; }
            if (!window.confirm(t("delete_confirm"))) return;
            try {
                localStorage.removeItem(keys.custom + id.slice(7));
                if (state.customPresetId === id) commit({ customPresetId: null, loadedCustomRevision: 0 });
                setStatus("custom_deleted");
            } catch { setStatus("storage_failed"); }
        } else if (action === "import") root.querySelector("[data-pef-import]").click();
        else if (action === "import-cancel") { view.importPlan = null; root.querySelector("[data-pef-import-review]").hidden = true; }
        else if (action === "import-confirm") {
            if (!view.importPlan) return;
            const result = importCustomPresets(view.importPlan);
            view.importPlan = result.remaining;
            const review = root.querySelector("[data-pef-import-review]");
            review.replaceChildren();
            const message = document.createElement("p");
            message.textContent = `${t("imported")}: ${result.saved}; ${t("remaining")}: ${result.remaining.length}${result.ok ? "" : ` · ${t(result.reason)}`}`;
            review.append(message);
            for (const item of result.remaining) { const entry = document.createElement("p"); entry.textContent = item.name; review.append(entry); }
            renderAll();
        } else if (action === "export") {
            const result = exportCustomPresets();
            if (!result.ok) { setStatus(result.reason); return; }
            const blob = new Blob([JSON.stringify(result.value, null, 2)], { type: "application/json;charset=utf-8" });
            const url = URL.createObjectURL(blob), anchor = document.createElement("a");
            anchor.href = url; anchor.download = "prompt-effect-custom.json"; anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000); setStatus("export_done");
        } else if (action === "close") closeDrawer();
        else if (action === "panel") openDrawer(node.dataset.pefTarget, node);
        else if (action === "tab") openTab();
        else if (action === "new-tab") openBrowserTab();
        else if (action === "reconnect") reconnectHost();
        else if (action === "retry") loadCatalog();
    }

    function resetLibraryFilter(root) {
        const view=views.get(root);
        if(view && (view.filter!=='all' || view.query || view.category!=='All')){view.filter='all';view.query='';view.category='All';updatePicker(view);}
    }

    function openTab() {
        const root = appRoot(), target = root.querySelector("#tab_pef_prompt_effect");
        resetLibraryFilter(root.querySelector('#pef-app'));
        const controls = target?.getAttribute("aria-labelledby");
        const button = controls ? root.querySelector(`[id="${CSS.escape(controls)}"]`) : [...root.querySelectorAll("#tabs > .tab-nav button")].find(node => node.textContent.trim() === "Prompt Effect");
        button?.click();
        target?.scrollIntoView({ block: "nearest" });
    }
    function openBrowserTab() {
        const recipient = isStandalone ? connected?.source || link.get('page') : instanceId;
        if(!session || !recipient) { setStatus('disconnected'); return; }
        const url = new URL(location.href);
        url.hash = `${standaloneHash}?${new URLSearchParams({ host: session, page: recipient })}`;
        // Match Background: noopener must be set at creation time so another
        // extension's host sessionStorage is not cloned into this picker.
        try { window.open(url.href, "_blank", "noopener"); }
        catch { setStatus("popups"); }
    }
    function otherModalOpen() {
        return [...appRoot().querySelectorAll('[role="dialog"][aria-modal="true"]')].some(node => !drawer?.contains(node) && node.getClientRects().length > 0 && !node.closest("[hidden]"));
    }
    function openDrawer(target, opener) {
        if (otherModalOpen()) { setStatus("modal_busy"); return; }
        drawerTarget = ["txt2img", "img2img"].includes(target) ? target : "txt2img";
        drawerOpener = opener || activeElement();
        if (!drawer) {
            drawer = document.createElement("div"); drawer.id = "pef-drawer-host"; drawer.className = "pef-drawer-host";
            drawer.innerHTML = '<button type="button" class="pef-scrim" aria-label="Close"></button><section class="pef-drawer" role="dialog" aria-modal="true" aria-label="Prompt Effect"><div class="pef-resize"><label><span data-pef-resize-label></span><input data-pef-resize type="range" min="320" max="1200" step="10"></label></div><div class="pef-app" id="pef-drawer-app"></div></section>';
            drawer.addEventListener('click', event => { if(event.target.closest('.pef-scrim') || event.target.closest('[data-pef-action="close"]')) { event.stopPropagation(); closeDrawer(); } });
            const edge = document.createElement('div'); edge.className='pef-edge-resizer'; edge.tabIndex=0; edge.setAttribute('role','separator'); edge.setAttribute('aria-label',t('resize')); edge.setAttribute('aria-orientation','vertical');
            drawer.querySelector('.pef-drawer').prepend(edge);
            edge.addEventListener('pointerdown', event => {
                event.preventDefault(); const x=event.clientX, width=drawer.querySelector('.pef-drawer').getBoundingClientRect().width;
                const move=e=>{ prefs.drawerWidth=Math.max(320,Math.min(innerWidth*.94,width+x-e.clientX)); updateDrawerWidth(); };
                const stop=()=>{ window.removeEventListener('pointermove',move); if(prefsWritable)writeJSON(keys.prefs,{schema_version:1,...prefs}); };
                window.addEventListener('pointermove',move); window.addEventListener('pointerup',stop,{once:true});
            });
            edge.addEventListener('keydown', event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();prefs.drawerWidth=Math.max(320,Math.min(innerWidth*.94,prefs.drawerWidth+(event.key==='ArrowLeft'?24:-24)));updateDrawerWidth();if(prefsWritable)writeJSON(keys.prefs,{schema_version:1,...prefs});});
            (appRoot() === document ? document.body : appRoot()).append(drawer);
            drawer.addEventListener("keydown", event => {
                if (event.isComposing || event.keyCode === 229) return;
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDrawer(); }
                if (event.key === "Tab") {
                    const fields = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')].filter(node => node.getClientRects().length);
                    const first = fields[0], last = fields.at(-1), active = activeElement();
                    if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
                }
            });
            drawer.querySelector("[data-pef-resize]").addEventListener("input", event => { prefs.drawerWidth = Number(event.target.value); if (prefsWritable) writeJSON(keys.prefs, { schema_version: 1, ...prefs }); updateDrawerWidth(); });
        }
        drawer.hidden = false;
        drawer.querySelector('.pef-drawer').scrollTop=0;
        setText(drawer.querySelector("[data-pef-resize-label]"), `${t("resize")} · ${drawerTarget}`);
        updateDrawerWidth();
        resetLibraryFilter(drawer.querySelector('.pef-app'));
        renderPicker(drawer.querySelector(".pef-app"), true);
        drawer.querySelector('[data-pef-action="close"]').focus();
    }
    function updateDrawerWidth() {
        if (!drawer) return;
        const maximum = Math.max(320, Math.floor(innerWidth * .94));
        drawer.querySelector(".pef-drawer").style.setProperty("--pef-drawer-width", `${Math.min(maximum, prefs.drawerWidth)}px`);
        const input = drawer.querySelector("[data-pef-resize]");
        input.max = String(maximum); input.value = String(Math.min(maximum, prefs.drawerWidth));
    }
    function closeDrawer() { if (drawer) drawer.hidden = true; drawerOpener?.focus?.(); drawerOpener = null; }

    function renderAll() {
        if (disposed) return;
        lastRender++;
        syncSeriesAppearance();
        for (const [root, view] of views) {
            if (!root.isConnected) { views.delete(root); continue; }
            updatePicker(view);
        }
        const selected = catalog?.presets.find(item => item.id === state.selectedPresetId);
        appRoot().querySelectorAll(".pef-bar").forEach(bar => {
            bar.querySelector("[data-pef-field]").checked = state.enabled;
            const name = state.mode === "Custom" ? state.customName || t("Custom") : selected?.name || t("unknown_preset");
            setText(bar.querySelector("[data-pef-selected]"), name);
            setText(bar.querySelector("[data-pef-bar-status]"), status ? t(status) : loadError ? t("load_failed") : "");
            const image = bar.querySelector("img");
            const src = state.mode === "Preset" && selected ? assetUrl(selected.thumbnail) : "";
            if (src && image.getAttribute("src") !== src) image.src = src;
            image.hidden = !src;
            bar.querySelectorAll("[data-pef-action]").forEach(node => { if (node.dataset.pefAction === "tab") setText(node, t("tab")); if (node.dataset.pefAction === "panel") setText(node, t("panel")); if (node.dataset.pefAction === "new-tab") setText(node, t("new_tab")); });
            setText(bar.querySelector("[data-pef-enable-label]"), t("enabled"));
        });
    }
    function syncSeriesAppearance() {
        const root=appRoot();
        const properties=['background-color','background-image','color','border-color','border-radius','border-width','box-sizing','font-weight','font-size','font-family','line-height','letter-spacing','min-height','padding'];
        const copy=(button,reference,header=false)=>{
            if(!reference)return;
            const appearance=getComputedStyle(reference);
            for(const property of [...properties,...(header?['height']:[])]) {
                const value=appearance.getPropertyValue(property);
                if(button.style.getPropertyValue(property)!==value)button.style.setProperty(property,value);
            }
        };
        for(const target of ['txt2img','img2img']) {
            const reference=root.querySelector(`#k2bg-${target}-bar button.k2bg-primary`);
            if(!reference)continue;
            for(const button of root.querySelectorAll(`#pef-${target}-bar button`)) copy(button,reference);
        }
        for(const picker of root.querySelectorAll('.pef-app')) {
            const panel=picker.classList.contains('pef-panel-app');
            const background=(panel && root.querySelector('#k2bg-drawer-host .k2bg-drawer-top')) || root.querySelector('#k2bg-app .k2bg-titlebar');
            if(!background)continue;
            for(const button of picker.querySelectorAll('.pef-top-actions button,.pef-boost button')) {
                const action=button.dataset.pefAction;
                const selector=action==='boost' ? `[data-k2bg-action="style-boost"][data-value="${button.dataset.pefValue.toLowerCase()}"]`
                    : `[data-k2bg-action="${action==='new-tab'?'standalone':action}"]${action==='insert'?`[data-target="${button.dataset.pefTarget}"]`:''}`;
                copy(button,background.querySelector(selector),true);
            }
            const close=picker.querySelector('[data-pef-action="close"]');
            if(close)copy(close,background.querySelector('[data-k2bg-action="close"]'),true);
        }
    }
    function ensureMounts() {
        if (disposed) return;
        const root = appRoot(), main = root.querySelector("#pef-app");
        if(!navigationRoots.has(root)){
            navigationRoots.add(root);
            root.addEventListener('click',event=>{const tab=event.target.closest?.('#tabs > .tab-nav button');if(tab?.textContent.trim()==='Prompt Effect')resetLibraryFilter(root.querySelector('#pef-app'));},true);
        }
        if (main && !views.has(main)) {
            if (ready) renderPicker(main);
            else showLoading(main);
        }
        if (isStandalone) {
            document.body.classList.add("pef-standalone");
            return;
        }
        const tabs = [...root.querySelectorAll('#tabs > .tab-nav button')];
        const backgroundTab = tabs.find(node=>node.textContent.trim()==='Background Prompter');
        const effectTab = tabs.find(node=>node.textContent.trim()==='Prompt Effect');
        if(backgroundTab && effectTab && backgroundTab.nextElementSibling!==effectTab) backgroundTab.after(effectTab);
        for (const target of ["txt2img", "img2img"]) {
            const container = root.querySelector(`#${target}_prompt_container`);
            if (!container) continue;
            let bar = container.querySelector(`#pef-${target}-bar`);
            if (!bar) {
                bar = document.createElement("div"); bar.id = `pef-${target}-bar`; bar.className = "pef-bar";
                bar.innerHTML = `<span>Prompt Effect</span><img alt="" width="54" height="36" hidden><span class="pef-grow" data-pef-selected></span><span class="pef-bar-actions"><label><input type="checkbox" data-pef-field="enabled"><span data-pef-enable-label>${esc(t("enabled"))}</span></label>${button("tab", t("tab"))}${button("new-tab", t("new_tab"))}${button("panel", t("panel"), `data-pef-target="${target}"`)}</span><span data-pef-bar-status role="status"></span>`;
                bar.addEventListener("click", handleAction);
                bar.addEventListener("change", handleChange);
                bar.querySelector("img").addEventListener("error", event => { event.target.hidden = true; });
                container.append(bar);
            }
            const background = container.querySelector(`#k2bg-${target}-bar`);
            if (background?.parentElement === container && background.nextElementSibling !== bar) background.after(bar);
            syncSeriesAppearance();
            if (ready && !bar.dataset.pefReady) { bar.dataset.pefReady = "true"; renderAll(); }
        }
    }
    function showLoading(root) {
        const signature = `${loadError}:${!!loading}:${locale()}`;
        if (root.dataset.pefLoading === signature) return;
        root.dataset.pefLoading = signature;
        root.innerHTML = `<p role="status">${esc(t(loadError ? "load_failed" : "loading"))}</p>${loadError ? button("retry", t("retry")) : ""}`;
        if (!root.dataset.pefRetryBound) { root.addEventListener("click", event => { if (event.target.closest('[data-pef-action="retry"]')) loadCatalog(); }); root.dataset.pefRetryBound = "true"; }
    }
    async function loadCatalog() {
        if (loading || disposed) return loading;
        loadError = "";
        loading = Promise.resolve().then(async () => {
            try {
                extensionBase = resolveExtensionBase();
                const response = await fetch(`${extensionBase}/data/prompt_effect_presets.json`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                catalog = validateCatalog(await response.json()); ready = true;
                detachMissingCustom();
                ensureMounts();
                for (const root of [appRoot().querySelector("#pef-app"), drawer?.querySelector(".pef-app")].filter(Boolean)) renderPicker(root, root.id === "pef-drawer-app");
                renderAll();
                if (isStandalone) reconnectHost();
            } catch (error) {
                ready = false; loadError = String(error.message || error); setStatus(["asset_base", "invalid_catalog"].includes(loadError) ? loadError : "load_failed");
            } finally {
                loading = null;
                if (!ready) { const root = appRoot().querySelector("#pef-app"); if (root) showLoading(root); }
            }
        });
        return loading;
    }
    function dispose() {
        disposed = true; transport.close();
        if (discovery?.timer) clearTimeout(discovery.timer);
        if (pending?.timer) clearTimeout(pending.timer);
        window.removeEventListener("resize", updateDrawerWidth);
        closeDrawer();
    }
    window.addEventListener("resize", updateDrawerWidth);
    window.addEventListener("pagehide", () => {
        // Keep bfcache pages usable; the document's listeners disappear on real unload.
        if (discovery?.timer) { clearTimeout(discovery.timer); discovery = null; }
        if (pending?.timer) { clearTimeout(pending.timer); pending = null; connected = null; status = "uncertain"; }
    });
    let themeObserver=null;
    const boot = () => {
        if(!themeObserver && typeof MutationObserver==='function' && document.body){
            themeObserver=new MutationObserver(syncSeriesAppearance);
            themeObserver.observe(document.body,{attributes:true,attributeFilter:['class']});
            themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
        }
        ensureMounts(); if (!ready && !loading && !loadError) loadCatalog(); };
    if (typeof onUiLoaded === "function") onUiLoaded(boot);
    else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
    if (typeof onAfterUiUpdate === "function") onAfterUiUpdate(ensureMounts);
    // PEF_TEST_SEAM
})();
