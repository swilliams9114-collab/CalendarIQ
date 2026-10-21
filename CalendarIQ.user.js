// ==UserScript==
// @name         CalendarIQ
// @namespace    CalendarIQ
// @version      0.3.1
// @description  Torn calendar, personal events and optional Loot Rangers NPC reminders in the profile menu.
// @match        https://*.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      api.lzpt.io
// @homepageURL  https://github.com/swilliams9114-collab/CalendarIQ
// @downloadURL  https://raw.githubusercontent.com/swilliams9114-collab/CalendarIQ/main/CalendarIQ.user.js
// @updateURL    https://raw.githubusercontent.com/swilliams9114-collab/CalendarIQ/main/CalendarIQ.user.js
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';
    function initialize() {
    if (window.top !== window.self || document.getElementById('calendariq')) return;
    if (!document.body) { setTimeout(initialize, 50); return; }
    const STORE = 'calendariq_v1';
    const HOUR = 3600000, DAY = 24 * HOUR, TTL = 6 * HOUR;
    // Public NPC schedule supplied by Loot Rangers (LZPT).
    const NPC_URL = 'https://api.lzpt.io/loot', NPC_TTL = 10 * 60000;
    let npcBusy = false, npcError = '', npcController = null, npcGeneration = 0;
    // External schedule is opt-in. No Torn key is ever included in this request.
    let state;
    try { state = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { state = {}; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    state.seen = state.seen && typeof state.seen === 'object' ? state.seen : {};
    state.custom = Array.isArray(state.custom) ? state.custom : [];
    npcError = typeof state.npcLastError === 'string' ? state.npcLastError : '';
    let busy = false, error = '', retryAt = 0, editingId = null;
    function save() {
        try { localStorage.setItem(STORE, JSON.stringify(state)); }
        catch (_) { error = 'Device storage unavailable. Settings may not survive a reload.'; }
    }
    function slotSeconds(slot) {
        if (!/^\d{2}:\d{2}$/.test(slot || '')) return null;
        const [h, m] = slot.split(':').map(Number);
        return h < 24 && m < 60 ? h * 3600 + m * 60 : null;
    }
    function eventTimes(e, slot) {
        let start = Number(e.start), end = Number(e.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
        let exact = e.fixed_start_time === true;
        if (e.fixed_start_time === false && slotSeconds(slot) !== null) {
            // Torn staff clarification: personal one-day events start the previous day
            // and last 48 hours; longer events retain their API start date.
            // https://www.torn.com/forums.php?a=0&b=0&f=19&p=threads&t=16516871
            const offset = slotSeconds(slot);
            const short = end - start < 86400;
            start = Math.floor(start / 86400) * 86400 + offset - (short ? 86400 : 0);
            end = (Math.floor(end / 86400) + 1) * 86400 + offset - 1;
            exact = true;
        }
        return { start: start * 1000, end: end * 1000, exact };
    }
    function phase(e, now) {
        if (!e.exact || now > e.end) return '';
        if (now >= e.start) return 'Active now';
        if (e.custom && e.remind === 'none') return '';
        const lead = e.custom ? Number(e.remind || 24) * HOUR : DAY;
        if (e.start - now > lead) return '';
        return e.start - now <= HOUR ? 'Starts within 1 hour' : 'Starts within ' + (lead / HOUR) + ' hours';
    }
    function parseInput(value, zone) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return NaN;
        const date = new Date(value + (zone === 'tct' ? 'Z' : ''));
        if (!Number.isFinite(date.getTime())) return NaN;
        // Reject normalized invalid dates and local times skipped by daylight saving.
        const out = zone === 'tct' ? date.toISOString().slice(0,16) :
            date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' +
            String(date.getDate()).padStart(2,'0') + 'T' + String(date.getHours()).padStart(2,'0') + ':' + String(date.getMinutes()).padStart(2,'0');
        return out === value ? date.getTime() : NaN;
    }
    function shiftDays(ms, days, zone) {
        const d = new Date(ms);
        if (zone === 'local') d.setDate(d.getDate() + days);
        else d.setUTCDate(d.getUTCDate() + days);
        return d.getTime();
    }
    function customOccurrences(e, now) {
        const start = parseInput(e.startInput, e.zone), end = parseInput(e.endInput, e.zone);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
        const days = e.repeat === 'weekly' ? 7 : e.repeat === 'daily' ? 1 : 0;
        let index = days ? Math.max(0, Math.floor((now - end) / (days * DAY)) - 2) : 0;
        const results = [];
        for (let tries = 0; tries < 8 && results.length < 2; tries++, index++) {
            const a = shiftDays(start, index * days, e.zone), b = shiftDays(end, index * days, e.zone);
            if (b >= now) results.push({ ...e, start:a, end:b, exact:true, custom:true,
                seriesId:e.id, id:'custom:' + e.id + '|' + a });
            if (!days) break;
        }
        return results;
    }
    function plain(value) {
        // Remove markup before decoding entities; never parse resource-bearing API HTML.
        const text = String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ');
        const decoder = document.createElement('textarea'); decoder.innerHTML = text;
        return decoder.value.replace(/\s+/g,' ').trim();
    }
    function entries() {
        const official = state.year === new Date().getUTCFullYear() ? (Array.isArray(state.events) ? state.events : []) : [];
        return [...official.flatMap(e => {
            const t = eventTimes(e, state.slot);
            return t ? [{ ...e, ...t, id: e.title + '|' + e.start + '|' + e.end }] : [];
        }), ...state.custom.flatMap(e => customOccurrences(e, Date.now()))].sort((a,b) => a.start-b.start);
    }
    function npcFresh(now) {
        const n = state.npc;
        return !!n && Number.isFinite(n.updated) && now >= n.updated && now - n.updated < NPC_TTL &&
            Number.isFinite(n.current) && Math.abs(now - n.current) < NPC_TTL;
    }
    function npcPhase(now) {
        const n = state.npc;
        if (!state.npcEnabled || !npcFresh(now)) return '';
        if (n.attack) return 'Group attack underway';
        const remaining = n.clear - now;
        if (remaining <= 0) return '';
        if (remaining <= 5 * 60000) return 'Starts within 5 minutes';
        if (remaining <= 15 * 60000) return 'Starts within 15 minutes';
        return '';
    }
    function npcNoticeKey(phase) {
        return 'npc:' + state.npc.clear + '|' + phase;
    }
    function normalizeNpc(data, now) {
        const t = data?.time;
        if (!t || typeof t.attack !== 'boolean' || typeof t.current !== 'number' ||
            typeof t.clear !== 'number' || !Number.isSafeInteger(t.current) || !Number.isSafeInteger(t.clear) ||
            t.clear < 0 || Math.abs(t.current * 1000 - now) >= NPC_TTL ||
            !Array.isArray(data.order) || data.order.length > 30 ||
            !data.npcs || typeof data.npcs !== 'object' || Array.isArray(data.npcs)) {
            throw new Error('Invalid or outdated schedule');
        }
        const seen = new Set();
        const order = data.order.map(value => {
            const id = String(value), n = data.npcs[id];
            if (!/^\d{1,9}$/.test(id) || seen.has(id) || !n || typeof n.name !== 'string' ||
                !n.name.trim() || !Number.isFinite(n.hosp_out) || n.hosp_out < 0 || typeof n.next !== 'boolean') {
                throw new Error('Invalid NPC order');
            }
            seen.add(id);
            return { id, name:n.name.trim().slice(0,80), next:n.next, hospOut:n.hosp_out * 1000 };
        });
        if ((t.attack || t.clear > 0) && !order.some(n => n.next)) throw new Error('Missing attack order');
        return { clear:t.clear * 1000, current:t.current * 1000, attack:t.attack,
            reason:typeof t.reason === 'string' ? t.reason.slice(0,200) : '', order, updated:now };
    }
    // Prefer TornPDA's documented bridge for external requests. Fetch is the browser fallback.
    function requestNpc(signal) {
        return new Promise((resolve, reject) => {
            let finished = false, handle;
            const finish = (fn, value) => {
                if (finished) return;
                finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
                fn(value);
            };
            const cancel = () => {
                finish(reject, new Error('NPC request cancelled or timed out'));
                try { handle?.abort?.(); } catch (_) {}
            };
            const timer = setTimeout(cancel, 15000);
            signal.addEventListener('abort', cancel, { once:true });
            if (signal.aborted) { cancel(); return; }
            const nativeResponse = r => {
                if (!r || !Number.isFinite(Number(r.status))) {
                    finish(reject, new Error('Invalid network response')); return;
                }
                const headers = String(r.responseHeaders || '');
                finish(resolve, { ok:Number(r.status) >= 200 && Number(r.status) < 300, status:Number(r.status),
                    headers:{ get:name => {
                        const row = headers.split(/\r?\n/).find(line => line.slice(0,line.indexOf(':')).trim().toLowerCase() === name.toLowerCase());
                        return row ? row.slice(row.indexOf(':')+1).trim() : null;
                    } }, json:async () => JSON.parse(r.responseText) });
            };
            try {
                if (typeof PDA_httpGet === 'function') {
                    Promise.resolve(PDA_httpGet(NPC_URL, {})).then(nativeResponse, e => finish(reject,e));
                } else if (typeof window.flutter_inappwebview?.callHandler === 'function') {
                    Promise.resolve(window.flutter_inappwebview.callHandler('PDA_httpGet', NPC_URL, {}))
                        .then(nativeResponse, e => finish(reject,e));
                } else if (typeof GM_xmlhttpRequest === 'function') {
                    handle = GM_xmlhttpRequest({ method:'GET', url:NPC_URL, anonymous:true, timeout:15000,
                        onload:nativeResponse, onerror:() => finish(reject,new Error('NPC connection failed')),
                        ontimeout:cancel, onabort:cancel });
                } else {
                    fetch(NPC_URL, { credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', signal })
                        .then(r => finish(resolve,r), e => finish(reject,e));
                }
            } catch (e) { finish(reject,e); }
        });
    }
    function renderNpc(now) {
        const box = $('.cq-npc'); box.replaceChildren(); box.hidden = !state.npcEnabled;
        if (!state.npcEnabled) return;
        node('h3', 'Loot Rangers · NPC attacks', box);
        const n = state.npc, fresh = npcFresh(now);
        node('small', npcBusy ? 'Checking schedule…' : npcError ||
            (n ? 'Checked: ' + new Date(n.updated).toLocaleString() : 'No schedule downloaded yet.'), box);
        const next = Math.max(state.npcNextAt || 0, state.npcRetryAt || 0, state.npcRateLimitUntil || 0);
        if (!npcBusy && next > now) node('small', 'Next automatic check in ' + countdown(next-now) + '. Refresh can retry after the request cooldown.', box);
        if (n) {
            if (!fresh) node('strong', 'Saved schedule is stale · NPC alerts paused', box);
            node('p', n.attack ? (fresh ? 'Group attack underway' : 'Last reported: group attack underway') :
                !n.clear ? 'No attack currently scheduled' : n.clear > now ? 'Group starts in ' + countdown(n.clear-now) :
                'Scheduled time has passed · waiting for an update', box);
            if (n.clear) node('small', 'Group start: ' + date(n.clear), box);
            if (!n.clear && n.reason) node('p', n.reason, box);
            const targets = n.order.filter(x => x.next);
            if ((n.clear || n.attack) && targets.length) {
                node('p', 'Attack order: ' + targets.map(x => x.name).join(' → '), box);
                if (n.attack) node('small', 'Hospital status at last check: ' + targets.map(x =>
                    x.name + (x.hospOut > n.current ? ' (in hospital)' : ' (out of hospital)')).join(', '), box);
            }
        }
        const link = node('a', 'View Loot Rangers schedule', box);
        link.href = 'https://www.tornstats.com/loot'; link.target = '_blank'; link.rel = 'noopener noreferrer';
        node('small', 'Community schedule; times may change. The group start applies to the order above. Reminders: 15 and 5 minutes before, while Torn is open.', box);
    }
    async function refreshNpc(force = false) {
        const now = Date.now();
        if (!state.npcEnabled || document.hidden || npcBusy) return;
        if (now < (state.npcRateLimitUntil || 0) || now < (state.npcAttemptAt || 0) + 60000 ||
            (!force && now < Math.max(state.npcNextAt || 0, state.npcRetryAt || 0))) {
            render(); return;
        }
        npcBusy = true; npcError = ''; delete state.npcLastError;
        state.npcAttemptAt = now;
        // Persist a throttle before requesting; reloads and sibling tabs reuse it.
        state.npcRetryAt = now + 60000;
        state.npcNextAt = now + 5 * 60000 + Math.floor(Math.random() * 30000);
        save(); render();
        const generation = npcGeneration;
        const controller = new AbortController(); npcController = controller;
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await requestNpc(controller.signal);
            if (!state.npcEnabled || generation !== npcGeneration) return;
            if (!response.ok) {
                if (response.status === 429) {
                    const header = response.headers.get('Retry-After');
                    const wait = header && /^\d+$/.test(header) ? Number(header)*1000 : Date.parse(header || '')-Date.now();
                    state.npcRateLimitUntil = Date.now() + Math.max(15*60000, Number.isFinite(wait) ? Math.min(wait, DAY) : 0);
                    state.npcRetryAt = state.npcRateLimitUntil;
                }
                throw new Error('HTTP ' + response.status);
            }
            const data = normalizeNpc(await response.json(), Date.now());
            if (!state.npcEnabled || generation !== npcGeneration) return;
            state.npc = data; pruneSeen(); save();
        } catch (err) {
            if (state.npcEnabled && generation === npcGeneration) {
                npcError = err.message === 'HTTP 429' ? 'Loot Rangers rate limit reached; waiting before retry.' :
                    err.message === 'Invalid or outdated schedule' ? 'Loot Rangers returned an outdated schedule. Check device date/time; will retry.' :
                    'Loot Rangers connection failed or timed out; saved schedule retained. Tap Refresh to retry after one minute.';
                state.npcLastError = npcError;
                state.npcRetryAt = Math.max(state.npcRetryAt || 0, Date.now() + 5*60000);
                save();
            }
        } finally {
            clearTimeout(timeout);
            if (npcController === controller) npcController = null;
            npcBusy = false; render();
        }
    }
    function pruneSeen() {
        const ids = new Set(entries().map(e => e.id));
        state.seen = Object.fromEntries(Object.entries(state.seen).filter(([k,v]) =>
            (ids.has(k.slice(0,k.lastIndexOf('|'))) || (state.npc && k.startsWith('npc:' + state.npc.clear + '|'))) && Date.now()-v < 90*DAY));
    }
    const root = document.createElement('div'); root.id = 'calendariq';
    root.innerHTML = `<style>
#calendariq{font:13px/1.45 Arial,sans-serif;color:#eee;position:fixed;right:10px;bottom:85px;z-index:1000000}
#calendariq button{background:#343943;color:#eee;border:1px solid #68717e;border-radius:6px;padding:8px;cursor:pointer;font:inherit}
#calendariq .cq-launch{box-shadow:0 2px 8px #0008}#calendariq .cq-hot{border-color:#7bcf91;color:#a3efb6}
#calendariq .cq-panel{position:fixed;right:12px;top:90px;width:min(350px,calc(100vw - 24px));max-height:calc(100vh - 180px);max-height:calc(100dvh - 180px);overflow:auto;background:#20242b;border:1px solid #59616c;border-radius:9px;padding:12px;box-sizing:border-box;box-shadow:0 4px 20px #0009}
#calendariq [hidden]{display:none!important}#calendariq h3{margin:0 0 8px;font-size:16px}#calendariq p{margin:5px 0}
#calendariq .cq-row{border-top:1px solid #454c56;padding:10px 0}#calendariq small{display:block;color:#b8c2ce}
#calendariq input,#calendariq select,#calendariq textarea{width:100%;box-sizing:border-box;background:#13161b;color:white;border:1px solid #69727d;padding:8px;margin:5px 0 10px;font-size:16px}
#calendariq .cq-tools{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap}#calendariq table{width:100%;border-collapse:collapse;font-size:11px}#calendariq td{border:1px solid #59616c;padding:4px}
#calendariq .cq-alert{border-left:3px solid #7bcf91;padding-left:8px;margin-bottom:10px}#calendariq a{color:#a5c9ff}

#calendariq-menu button{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;padding:0 10px 0 5px;border:0;background:transparent;color:inherit;font:inherit;line-height:34px;min-height:34px;cursor:pointer}
#calendariq-menu button:hover{color:#fff;background:#ffffff12}#calendariq-menu svg{width:19px;height:19px;flex-shrink:0;color:#999;margin-right:3px}
#calendariq-dot{position:absolute;bottom:0;left:0;width:8px;height:8px;border-radius:50%;border:2px solid #222;box-shadow:0 0 3px #0009;z-index:5;pointer-events:none!important}
#calendariq-dot[hidden]{display:none!important}#calendariq-dot[data-status="soon"]{background:#e5af3d}#calendariq-dot[data-status="active"]{background:#6acb7b}
#calendariq textarea{min-height:65px;resize:vertical}#calendariq label{display:block}#calendariq .cq-npc{border-top:1px solid #454c56;padding:10px 0;margin-top:10px}#calendariq input[type="checkbox"]{width:auto;margin:8px 6px 8px 0}#calendariq .cq-editor{border-top:1px solid #454c56;margin-top:10px;padding-top:10px}
</style><button class="cq-launch" type="button">CalendarIQ</button>
<section class="cq-panel" hidden aria-label="CalendarIQ"><h3>CalendarIQ</h3>
<div class="cq-tools"><button type="button" data-action="add">Add Event</button><button type="button" data-action="refresh">Refresh</button><button type="button" data-action="settings">Settings</button><button type="button" data-action="close">Close</button></div>
<small class="cq-status"></small><div class="cq-settings" hidden>
<p>API, privacy &amp; script behaviour · v0.3.1</p><table><tr><td>Purpose</td><td>Calendar and NPC schedule reminders; no automated attacks, purchases, messages or other gameplay actions.</td></tr><tr><td>Key access</td><td>Public Only; torn/calendar only.</td></tr><tr><td>Storage</td><td>Key, settings, custom events, latest calendars, optional Loot Rangers schedule and dismissed reminders stored on this device in Torn local storage.</td></tr><tr><td>Sharing</td><td>Torn key sent only to api.torn.com. If enabled, CalendarIQ contacts api.lzpt.io for the public Loot Rangers schedule without your Torn key or personal events. That service receives your IP address and normal connection metadata.</td></tr></table>
<label><input class="cq-npc-enabled" type="checkbox">Show Loot Rangers NPC schedule and reminders</label><small>Optional third-party feed. Checks about every 5–6 minutes while Torn is visible. Amber dot within 15 minutes; green when the feed reports an attack underway.</small>
<label>API key<input class="cq-key" type="password" autocomplete="off" placeholder="Public Only key; leave blank to keep saved key"></label>
<label>Your Torn calendar time slot (TCT)<input class="cq-slot" type="time"></label>
<small>Copy the time slot from Torn's calendar. Without it, personal-time events show API dates only and cannot trigger exact reminders. Update this setting if you change your Torn slot.</small>
<div class="cq-tools"><button type="button" data-action="save">Save</button><button type="button" data-action="erase">Delete saved data</button></div></div>
<form class="cq-editor" hidden>
<h3 class="cq-editor-title">Add event</h3>
<label>Event name<input name="title" required maxlength="100" placeholder="AS Weekly Race"></label>
<label>Brief description<textarea name="description" maxlength="1000" placeholder="Track, laps, password or other details"></textarea></label>
<label>Enter times in<select name="zone"><option value="tct">TCT (Torn time / UTC)</option><option value="local">Local device time</option></select></label>
<label>Start<input name="startInput" type="datetime-local" required></label>
<label>End<input name="endInput" type="datetime-local" required></label>
<label>Repeat<select name="repeat"><option value="none">Once</option><option value="weekly">Weekly</option><option value="daily">Daily</option></select></label>
<label>Advance reminder<select name="remind"><option value="24">24 hours before + 1 hour before</option><option value="1">1 hour before</option><option value="48">48 hours before + 1 hour before</option><option value="none">No advance reminder</option></select></label>
<small>TCT repeats keep Torn time. Local repeats keep the same time on your device. Active events always show the green dot.</small>
<p class="cq-form-error" role="alert"></p><div class="cq-tools"><button type="submit">Save Event</button><button type="button" data-action="cancel">Cancel</button></div></form>
<div class="cq-alerts" aria-live="polite"></div><div class="cq-npc" hidden></div><div class="cq-events"></div>
<small>In-page reminders only, while Torn is open. Dates include TCT and your device time. Personal-time dates follow Torn's documented calendar adjustment; confirm unusual events on the calendar.</small>
<a href="https://www.torn.com/calendar.php">Open Torn calendar</a></section>`;
    document.body.appendChild(root);
    const $ = s => root.querySelector(s);
    const panel = $('.cq-panel');
    const form = $('.cq-editor');
    function openPanel() { panel.hidden = false; render(); refreshNpc(!state.npc); }
    function editEvent(event) {
        form.reset(); editingId = event?.id || null;
        $('.cq-editor-title').textContent = event ? 'Edit event' : 'Add event';
        $('.cq-form-error').textContent = '';
        if (event) ['title','description','zone','startInput','endInput','repeat','remind'].forEach(k => { form.elements[k].value = event[k] || ''; });
        form.hidden = false; $('.cq-settings').hidden = true; openPanel();
        form.scrollIntoView?.({ block:'nearest' });
    }
    // Match Torn's published header layout. No requests, clicks, or gameplay actions.
    // Re-attach when Torn replaces the header during navigation.
    let indicatorStatus = '', menuObserver = null, mountQueued = false;
    function profileMenus() {
        const known = [...document.querySelectorAll('.settings-menu')].filter(menu =>
            menu.closest('.avatar') || /view profile/i.test(menu.textContent));
        if (known.length) return known;
        // Some responsive layouts no longer retain the old header class names.
        const candidates = [];
        document.querySelectorAll('a,button').forEach(link => {
            if (link.textContent.trim().toLowerCase() !== 'view profile') return;
            let parent = link.parentElement;
            for (let i = 0; parent && parent !== document.body && i < 6; i++, parent = parent.parentElement) {
                const text = parent.textContent;
                if (text.length < 2000 && /settings/i.test(text) && /logout|log out/i.test(text)) {
                    candidates.push(parent); break;
                }
            }
        });
        return [...new Set(candidates)];
    }
    function mountHeader() {
        // Visible fallback remains available even if a WebView starts hidden.
        const launcher = $('.cq-launch');
        if (document.hidden) { launcher.hidden = false; return; }
        let mounted = false;
        profileMenus().forEach(menu => {
            const avatar = menu.closest('.avatar') || menu.parentElement;
            const target = avatar.querySelector('.top_header_button .profile-image-wrapper') ||
                avatar.querySelector('.top_header_button .icon-wrapper') || avatar.querySelector('.top_header_button');
            if (target) {
                let dot = avatar.querySelector('#calendariq-dot');
                if (!dot) {
                    dot = document.createElement('span'); dot.id = 'calendariq-dot';
                    dot.setAttribute('aria-hidden','true'); target.appendChild(dot);
                }
                dot.hidden = !indicatorStatus; dot.dataset.status = indicatorStatus;
            }
            if (!menu.querySelector('#calendariq-menu')) {
                const item = document.createElement(menu.tagName === 'UL' || menu.tagName === 'OL' ? 'li' : 'div');
                item.id = 'calendariq-menu'; item.className = 'link';
                item.innerHTML = '<button type="button" aria-label="Open CalendarIQ"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18M7 15h3m4 0h3"/></svg><span>CalendarIQ</span></button>';
                const settings = [...menu.querySelectorAll('a,button,.link-text')].find(n => n.textContent.trim().toLowerCase() === 'settings');
                let row = settings;
                while (row && row.parentElement !== menu) row = row.parentElement;
                menu.insertBefore(item, row || menu.querySelector('.server-info') || null);
                item.querySelector('button').addEventListener('click', e => {
                    e.preventDefault(); e.stopPropagation(); avatar.classList.remove('active'); openPanel();
                });
            }
            // A hidden desktop menu must not remove the only reachable mobile button.
            if (avatar.getClientRects().length && getComputedStyle(avatar).visibility !== 'hidden') mounted = true;
        });
        launcher.hidden = mounted;
    }
    function watchHeader() {
        menuObserver?.disconnect();
        if (document.hidden) return;
        mountHeader();
        menuObserver = new MutationObserver(records => {
            if (!records.some(r => [...r.addedNodes,...r.removedNodes].some(n => n.nodeType === 1 && !n.id?.startsWith('calendariq') && !root.contains(n)))) return;
            if (mountQueued) return;
            mountQueued = true;
            requestAnimationFrame(() => { mountQueued = false; mountHeader(); });
        });
        menuObserver.observe(document.body, { childList:true, subtree:true });
    }
    form.addEventListener('submit', e => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(form)); values.title = values.title.trim();
        const start = parseInput(values.startInput, values.zone), end = parseInput(values.endInput, values.zone);
        let message = !values.title ? 'Enter an event name.' : !Number.isFinite(start) || !Number.isFinite(end) ? 'Enter valid dates and times.' :
            end < start ? 'End must be at or after the start.' : values.repeat === 'none' && end < Date.now() ? 'Choose an event that has not ended.' : '';
        const period = values.repeat === 'daily' ? DAY : values.repeat === 'weekly' ? 7*DAY : Infinity;
        if (!message && end-start >= period) message = 'The event must end before its next repeat.';
        if (!message && !editingId && state.custom.length >= 100) message = 'You have 100 custom events. Delete an old event first.';
        if (message) { $('.cq-form-error').textContent = message; return; }
        const id = editingId || (window.crypto?.randomUUID?.() || Date.now().toString(36)+Math.random().toString(36).slice(2));
        const event = { ...values, id };
        const index = state.custom.findIndex(x => x.id === id);
        if (index >= 0) state.custom[index] = event; else state.custom.push(event);
        state.seen = Object.fromEntries(Object.entries(state.seen).filter(([key]) => !key.startsWith('custom:'+id+'|')));
        pruneSeen(); save(); form.hidden = true; editingId = null; render();
    });
    function node(tag, text, parent) {
        const n = document.createElement(tag); n.textContent = text; parent.appendChild(n); return n;
    }
    function date(ms) {
        const tct = new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
        const local = new Date(ms).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        return tct + ' TCT · ' + local + ' local';
    }
    function countdown(ms) {
        const minutes = Math.max(1, Math.ceil(ms / 60000));
        return minutes >= 1440 ? Math.floor(minutes / 1440) + 'd ' + Math.floor(minutes % 1440 / 60) + 'h' :
            minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm' : minutes + 'm';
    }
    function render() {
        const now = Date.now(), all = entries();
        const stale = !state.updated || now - state.updated > TTL;
        const upcoming = all.filter(e => e.end >= now - (e.exact ? 0 : DAY));
        const available = upcoming.filter(e => e.custom || !stale);
        const due = available.filter(e => {
            const p = phase(e, now); return p && !state.seen[e.id + '|' + p];
        });
        const npcAlert = npcPhase(now);
        const npcDue = npcAlert && !state.seen[npcNoticeKey(npcAlert)];
        const dueCount = due.length + (npcDue ? 1 : 0);
        const launcher = $('.cq-launch');
        launcher.textContent = 'CalendarIQ' + (dueCount ? ' · ' + dueCount : '');
        launcher.classList.toggle('cq-hot', dueCount > 0);
        indicatorStatus = npcAlert === 'Group attack underway' || available.some(e => e.exact && now >= e.start && now <= e.end) ? 'active' :
            npcAlert || available.some(e => e.exact && e.start > now && e.start-now <= DAY) ? 'soon' : '';
        mountHeader();
        $('.cq-status').textContent = busy ? 'Refreshing…' : error || (!state.key ? 'Custom events ready. Add a Public Only API key in Settings for Torn events.' :
            'Updated: ' + (state.updated ? new Date(state.updated).toLocaleString() : 'never') + (stale ? ' · Torn data stale; official reminders paused' : ''));
        const alerts = $('.cq-alerts'); alerts.replaceChildren();
        due.forEach(e => {
            const p = phase(e, now), box = node('div', '', alerts); box.className = 'cq-alert';
            node('strong', e.title + ' — ' + p, box);
            node('p', (e.custom ? String(e.description || '') : plain(e.description)).slice(0, 220) || 'No description.', box);
            const dismiss = node('button', 'Dismiss', box); dismiss.type = 'button';
            dismiss.onclick = () => { state.seen[e.id + '|' + p] = now; save(); render(); };
        });
        if (npcDue) {
            const box = node('div', '', alerts); box.className = 'cq-alert';
            node('strong', 'Loot Rangers — ' + npcAlert, box);
            node('p', 'Order: ' + state.npc.order.filter(x => x.next).map(x => x.name).join(' → '), box);
            const dismiss = node('button', 'Dismiss', box); dismiss.type = 'button';
            const key = npcNoticeKey(npcAlert);
            dismiss.onclick = () => { state.seen[key] = now; save(); render(); };
        }
        renderNpc(now);
        const list = $('.cq-events'); list.replaceChildren();
        if (!upcoming.length) node('p', 'No upcoming events. Add your own event or load the Torn calendar.', list);
        upcoming.forEach(e => {
            const box = node('div', '', list); box.className = 'cq-row';
            node('strong', e.title, box);
            node('small', e.custom ? 'Custom event' + (e.repeat !== 'none' ? ' · repeats ' + e.repeat : '') : 'Torn event', box);
            node('small', e.exact ? (now >= e.start ? 'Active · ends in ' + countdown(e.end - now) : 'Starts in ' + countdown(e.start - now)) : 'API dates · set your time slot for personal-time events', box);
            node('small', 'Start: ' + date(e.start), box); node('small', 'End: ' + date(e.end), box);
            const desc = e.custom ? String(e.description || '') : plain(e.description);
            node('p', desc.length > 240 ? desc.slice(0, 237) + '…' : desc || 'No description.', box);
            if (e.custom) {
                const tools = node('div', '', box); tools.className = 'cq-tools';
                const edit = node('button', 'Edit', tools); edit.type = 'button';
                edit.onclick = () => editEvent(state.custom.find(x => x.id === e.seriesId));
                const remove = node('button', 'Delete', tools); remove.type = 'button';
                remove.onclick = () => {
                    if (!confirm(e.repeat === 'none' ? 'Delete this custom event?' : 'Delete this event and all its repeats?')) return;
                    state.custom = state.custom.filter(x => x.id !== e.seriesId);
                    if (editingId === e.seriesId) { form.hidden = true; editingId = null; }
                    pruneSeen(); save(); render();
                };
            }
        });
    }
    async function refresh(force = false) {
        if (busy || !state.key || Date.now() < retryAt) return;
        if (!force && state.year === new Date().getUTCFullYear() && Date.now() - (state.updated || 0) < TTL) return;
        busy = true; error = ''; render();
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
        const key = state.key;
        try {
            const url = new URL('https://api.torn.com/v2/torn/calendar');
            url.searchParams.set('key', key); url.searchParams.set('comment', 'CalendarIQ');
            const response = await fetch(url.href, { credentials:'omit', signal:controller.signal, redirect:'error' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            if (data.error) throw new Error('Torn API error ' + data.error.code + ': ' + String(data.error.error || 'Request failed').replaceAll(key, '[key]'));
            if (!Array.isArray(data.calendar?.events) || !Array.isArray(data.calendar?.competitions)) throw new Error('Unexpected calendar response.');
            if (state.key !== key) return;
            state.events = [...data.calendar.events, ...data.calendar.competitions].map(e => ({ title:String(e.title || 'Event'), description:String(e.description || ''), start:e.start, end:e.end, fixed_start_time:e.fixed_start_time }));
            state.updated = Date.now(); state.year = new Date().getUTCFullYear();
            pruneSeen();
            retryAt = Date.now() + 60000; save();
        } catch (err) {
            if (state.key === key) error = err.name === 'AbortError' ? 'API request timed out. Try again later.' :
                (String(err.message).startsWith('HTTP') || String(err.message).startsWith('Torn API') || String(err.message).startsWith('Unexpected') ? err.message : 'API unavailable. Check connection and try again later.');
            retryAt = Date.now() + 5 * 60000;
        } finally { clearTimeout(timeout); busy = false; render(); }
    }
    $('.cq-launch').onclick = () => { panel.hidden = !panel.hidden; render(); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') panel.hidden = true; });
    root.addEventListener('click', e => {
        const action = e.target.dataset.action;
        if (action === 'close') panel.hidden = true;
        if (action === 'add') editEvent();
        if (action === 'cancel') { form.hidden = true; editingId = null; }
        if (action === 'refresh') { refresh(true); refreshNpc(true); }
        if (action === 'settings') { $('.cq-settings').hidden = !$('.cq-settings').hidden; $('.cq-slot').value = state.slot || ''; $('.cq-npc-enabled').checked = !!state.npcEnabled; }
        if (action === 'save') {
            const key = $('.cq-key').value.trim(), slot = $('.cq-slot').value;
            if (key && !/^[a-zA-Z0-9]{16}$/.test(key)) { error = 'Enter a valid 16-character Torn API key.'; render(); return; }
            if (slot && slotSeconds(slot) === null) { error = 'Enter a valid TCT time.'; render(); return; }
            if (key && key !== state.key) { state.key = key; state.updated = 0; state.events = []; retryAt = 0; }
            if (state.slot !== slot) state.seen = Object.fromEntries(Object.entries(state.seen).filter(([k]) => k.startsWith('custom:') || k.startsWith('npc:')));
            const enabled = $('.cq-npc-enabled').checked;
            if (!!state.npcEnabled !== enabled) {
                npcGeneration++; npcController?.abort(); npcError = '';
                state.npcEnabled = enabled;
                if (!enabled) { delete state.npc; delete state.npcNextAt; delete state.npcLastError; }
            }
            state.slot = slot; error = ''; $('.cq-key').value = ''; save(); $('.cq-settings').hidden = true; render(); refresh(); refreshNpc();
        }
        if (action === 'erase' && confirm('Delete CalendarIQ key, custom events, calendar, settings and reminders from this device?')) {
            npcGeneration++; npcController?.abort(); npcError = '';
            state = { seen:{}, custom:[] }; $('.cq-npc-enabled').checked = false; localStorage.removeItem(STORE); $('.cq-key').value = ''; $('.cq-slot').value = ''; error = ''; render();
        }
    });
    window.addEventListener('storage', e => {
        if (e.key !== STORE) return;
        const wasEnabled = !!state.npcEnabled;
        try { const updated = JSON.parse(e.newValue || '{}'); if (updated && typeof updated === 'object') state = { ...updated, seen:updated.seen || {}, custom:Array.isArray(updated.custom) ? updated.custom : [] }; } catch (_) {}
        if (wasEnabled && !state.npcEnabled) { npcGeneration++; npcController?.abort(); }
        npcError = typeof state.npcLastError === 'string' ? state.npcLastError : ''; render();
    });
    document.addEventListener('visibilitychange', () => { watchHeader(); if (!document.hidden) { render(); refresh(); refreshNpc(); } });
    setInterval(() => { if (!document.hidden) { render(); refresh(); refreshNpc(); } }, 30000);
    // The indicator never opens the panel; use the dropdown entry.
    $('.cq-slot').value = state.slot || '';
    pruneSeen(); save(); watchHeader(); render(); refresh(); refreshNpc();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once:true });
    } else initialize();
})();

