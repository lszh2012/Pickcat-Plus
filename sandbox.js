/* ============================================================
 * PICKCAT Plus · 沙盒中继 (sandbox.js)
 *
 * 这个文件已经不再执行插件代码了 —— 它只做三件事：
 *   1. 中继：宿主(content.js) ⇄ 插件 Worker，消息原样转发
 *   2. 看门狗：Worker 卡死（死循环 / 无响应）就 terminate()，并向宿主报 crashed
 *   3. 兜底自检：确认网络 API 桩生效、报告 origin / canEval
 *
 * 为什么要有 Worker：单线程里一个 while(true){} 会让整个线程永不回到
 * 事件循环，连 setTimeout 都不会触发，主线程没法自救。Worker 有独立
 * 线程，主线程可以随时 terminate()，这就是唯一的"拔电源"手段。
 * ============================================================ */

(function () {
    'use strict';

    const TAG = '[pickcat-sandbox]';
// 日志策略：默认安静，宿主开了「开发者模式」才会把这些细节打出来。
let DEV_MODE = false;
function slog() {
    if (!DEV_MODE) return;
    console.info.apply(console, arguments);
}
    const ENV = 1;

    // 启动超时：插件 init 里卡住超过这么久，判定卡死
    const RUN_TIMEOUT = 8000;
    // 单次能力调用超时：插件在按钮回调里死循环时，用这个抓出来
    const CALL_TIMEOUT = 20000;

    /* ---------- 0. 兜底桩（Worker 里也有一份，这里双保险） ---------- */

    const STUBBED = [];
    function stubGlobals() {
        const thrower = (name) => function () {
            throw new Error('插件不能直接使用 ' + name + '，请改用 PickcatPlus.fetch() 并在清单里声明 hosts 白名单');
        };
        ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].forEach((name) => {
            const stub = thrower(name);
            const targets = [window];
            try { if (typeof globalThis !== 'undefined' && globalThis !== window) targets.push(globalThis); } catch (e) { }
            targets.forEach((obj) => {
                try { delete obj[name]; } catch (e) { }
                try {
                    Object.defineProperty(obj, name, { value: stub, writable: true, configurable: true });
                } catch (e) {
                    try { obj[name] = stub; } catch (e2) { }
                }
            });
            STUBBED.push(name);
        });
        try {
            if (navigator.sendBeacon) {
                Object.defineProperty(navigator, 'sendBeacon', { value: thrower('navigator.sendBeacon'), configurable: true });
                STUBBED.push('navigator.sendBeacon');
            }
        } catch (e) { }
    }

    function toParent(msg) {
        try {
            window.parent.postMessage(Object.assign({ __pickcat: ENV }, msg), '*');
        } catch (e) { }
    }

    // 每插件一个 Worker，生命周期管理见下面「2. 宿主 → Worker」之前的池实现
    /* ---------- Worker 源码（内联，避免 null origin 取不到扩展资源） ---------- */

    const WORKER_SRC = String.raw`/* ============================================================
 * PICKCAT Plus · 插件 Worker (plugin-worker.js)
 *
 * 插件代码**只**跑在这里，不跑在沙盒 iframe 的线程上。
 * 目的只有一个：while(true){} 之类把线程卡死时，主线程还能
 * worker.terminate() 一刀砍掉，页面和扩展都不受影响。
 *
 * 这里的环境：
 *   - 没有 document / window / DOM / chrome.*
 *   - origin 继承沙盒页（null），母页 CSP 也管不到 worker 的网络；
 *     但 worker 里没有原生 fetch（被我们抹掉），唯一出口是
 *     PickcatPlus.fetch() → postMessage 给沙盒页 → 宿主 → background
 * ============================================================ */

(function () {
    'use strict';

    const TAG = '[pickcat-worker]';
    // Worker 是独立线程，没有 chrome.*，开关由宿主经中继转发过来
    let DEV_MODE = false;
    function slog() {
        if (!DEV_MODE) return;
        console.info.apply(console, arguments);
    }
    const ENV = 1;

    /* ---------- 0. 抹掉原生网络 API ---------- */

    const STUBBED = [];
    function stubGlobals() {
        const thrower = (name) => function () {
            throw new Error('插件不能直接使用 ' + name + '，请改用 PickcatPlus.fetch() 并在清单里声明 hosts 白名单');
        };
        ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'].forEach((name) => {
            const stub = thrower(name);
            const targets = [self];
            try { if (typeof globalThis !== 'undefined' && globalThis !== self) targets.push(globalThis); } catch (e) { }
            targets.forEach((obj) => {
                try { delete obj[name]; } catch (e) { }
                try {
                    Object.defineProperty(obj, name, { value: stub, writable: true, configurable: true });
                } catch (e) {
                    try { obj[name] = stub; } catch (e2) { }
                }
            });
            STUBBED.push(name);
        });
    }

    /* ---------- 1. RPC（全部经沙盒页中继给宿主） ---------- */

    let seq = 0;
    const pending = new Map();

    function post(msg) {
        try {
            self.postMessage(Object.assign({ __pickcat: ENV }, msg));
        } catch (e) { }
    }

    function call(method, args, pluginId) {
        return new Promise((resolve, reject) => {
            // 已经停止/卸载的插件不许再调 API —— 否则一个还没跑完的 async 回调
            // 会在「应急逃生」关掉之后把界面又建回来（看起来就是死而复生）。
            if (pluginId && stopped.has(pluginId)) {
                reject(new Error('插件已停止'));
                return;
            }
            const id = 'c' + (++seq);
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('调用 ' + method + ' 超时'));
            }, 25000);
            pending.set(id, { resolve: resolve, reject: reject, timer: timer, pluginId: pluginId || '' });
            post({ type: 'call', id: id, method: method, args: args || {}, pluginId: pluginId || 'unknown' });
        });
    }

    self.addEventListener('message', function (ev) {
        const d = ev.data;
        if (!d || d.__pickcat !== ENV) return;

        if (d.type === 'call-reply') {
            const p = pending.get(d.id);
            if (!p) return;
            pending.delete(d.id);
            clearTimeout(p.timer);
            if (d.ok) p.resolve(d.data);
            else p.reject(new Error((d.data && d.data.error) || '调用失败'));
            return;
        }
        if (d.type === 'dev') {
            DEV_MODE = !!(d.payload && d.payload.on);
            try {
                if (worker) worker.postMessage({ __pickcat: ENV, type: 'dev', payload: { on: DEV_MODE } });
            } catch (e) { }
            return;
        }
        if (d.type === 'run') { slog(TAG, '▶ 运行插件：' + ((d.payload || {}).id)); loadPlugin(d.payload); return; }
        if (d.type === 'stop') {
            const sid = (d.payload || {}).id;
            slog(TAG, '■ 停止插件：' + sid);
            stopped.add(sid);
            plugins.delete(sid);
            // 把这个插件所有还在路上的调用直接掐掉，别让回调在停止后继续改页面
            pending.forEach((p, cid) => {
                if (p.pluginId !== sid) return;
                pending.delete(cid);
                clearTimeout(p.timer);
                p.reject(new Error('插件已停止'));
            });
            post({ type: 'plugin-unloaded', payload: { id: sid } });
            return;
        }
        if (d.type === 'storage-sync') {
            const rec = plugins.get((d.payload || {}).id);
            if (rec) rec.data = (d.payload || {}).data || {};
            return;
        }
        if (d.type === 'event') { dispatchEventToPlugins(d.payload); return; }
    });

    /* ---------- 2. 插件注册表 ---------- */

    const plugins = new Map();
    // 被停止（卸载 / 应急逃生）过的插件 id：它们的 async 回调可能还没跑完，
    // 用这个集合把它们后续的每一次 API 调用都挡掉。
    const stopped = new Set();

    function hasPerm(rec, perm) {
        const granted = (rec.meta && rec.meta.granted) || [];
        return granted.indexOf(perm) !== -1;
    }

    function requirePerm(rec, perm) {
        if (!hasPerm(rec, perm)) {
            throw new Error('插件 ' + (rec.meta.id || '?') + ' 没有申请「' + perm + '」权限，已拒绝该调用');
        }
    }

    function dispatchEventToPlugins(payload) {
        const name = (payload || {}).name;
        if (name === 'button-click') {
            plugins.forEach((rec, id) => {
                const h = rec.handlers.buttons.get(payload.buttonId);
                if (h) safeInvoke(id, rec, h, payload);
            });
            return;
        }
        if (name === 'post-change') {
            plugins.forEach((rec, id) => {
                (rec.handlers.postChange || []).forEach((cb) => safeInvoke(id, rec, cb, payload.data));
            });
            return;
        }
        if (name === 'dom-change') {
            plugins.forEach((rec, id) => {
                (rec.handlers.domChange || []).forEach((cb) => safeInvoke(id, rec, cb, payload.anchor));
            });
        }
    }

    function safeInvoke(pluginId, rec, fn, arg) {
        try {
            const r = fn(arg);
            if (r && typeof r.then === 'function') r.catch((e) => reportError(pluginId, e));
        } catch (e) {
            reportError(pluginId, e);
        }
    }

    function reportError(pluginId, e) {
        const text = String((e && (e.stack || e.message)) || e);
        console.error(TAG, '[plugin:' + pluginId + ']', text);
        post({ type: 'log', payload: { pluginId: pluginId, level: 'error', text: text } });
    }

    /* ---------- 3. 插件 API ---------- */

    function makeApi(rec) {
        const meta = rec.meta;
        const data = () => rec.data || (rec.data = {});
        const rpc = (m, a) => call(m, a, meta.id);

        return {
            meta: {
                id: meta.id,
                name: meta.name,
                version: meta.version,
                author: meta.author,
                hosts: meta.hosts || []
            },
            version: '1.0.0',

            getPostContent: function () {
                requirePerm(rec, 'dom-read');
                return rpc('getPostContent', {});
            },

            addInteractionButton: function (opt, onClick) {
                requirePerm(rec, 'ui-interaction');
                if (typeof onClick !== 'function') throw new Error('addInteractionButton 需要第二个参数是函数');
                const buttonId = meta.id + '::' + (opt.id || opt.label || 'btn');
                rec.handlers.buttons.set(buttonId, onClick);
                rpc('addInteractionButton', {
                    buttonId: buttonId,
                    icon: String(opt.icon || '✨'),
                    label: String(opt.label || meta.name || '插件')
                }).catch((e) => reportError(meta.id, e));
                return Promise.resolve(buttonId);
            },

            showCard: function (opt) {
                requirePerm(rec, 'ui-interaction');
                return rpc('showCard', {
                    title: String(opt.title || ''),
                    text: String(opt.text || ''),
                    loading: opt.loading === true
                });
            },

            updateCard: function (cardId, text) {
                requirePerm(rec, 'ui-interaction');
                return rpc('updateCard', { cardId: cardId, text: String(text) });
            },

            closeCard: function (cardId) {
                requirePerm(rec, 'ui-interaction');
                return rpc('closeCard', { cardId: cardId });
            },

            showToast: function (text) {
                requirePerm(rec, 'notify');
                return rpc('showToast', { text: String(text) });
            },

            copy: function (text) {
                requirePerm(rec, 'clipboard-write');
                return rpc('copy', { text: String(text) });
            },

            storage: {
                get: function (key) {
                    requirePerm(rec, 'storage');
                    return Promise.resolve(data()[key]);
                },
                set: function (key, value) {
                    requirePerm(rec, 'storage');
                    data()[key] = value;
                    return rpc('storage.set', { key: key, value: value });
                },
                all: function () {
                    requirePerm(rec, 'storage');
                    return Promise.resolve(JSON.parse(JSON.stringify(data())));
                }
            },

            fetch: function (url, opts) {
                requirePerm(rec, 'network');
                return gatedFetch(rec, url, opts);
            },

            onPostChange: function (cb) {
                if (typeof cb !== 'function') return;
                rec.handlers.postChange.push(cb);
            },

            /* ---- DOM（Tier B / Tier C）----
             * 注意：这里没有任何 DOM 对象。每次调用都是「请宿主代我做」，
             * 宿主那边会再校验一遍节点归不归这个插件管。
             * 句柄是字符串，只在本次页面生命周期内有效。
             */
            dom: {
                query: function (selector, opt) {
                    requirePerm(rec, 'dom-read');
                    const o = opt || {};
                    return rpc('dom.query', { selector: String(selector || ''), anchor: o.anchor, limit: o.limit });
                },
                text: function (handle) {
                    requirePerm(rec, 'dom-read');
                    return rpc('dom.text', { handle: handle });
                },
                attr: function (handle, name) {
                    requirePerm(rec, 'dom-read');
                    return rpc('dom.attr', { handle: handle, name: String(name || '') });
                },
                setAttr: function (handle, name, value) {
                    requirePerm(rec, 'dom-write');
                    return rpc('dom.setAttr', { handle: handle, name: String(name || ''), value: value });
                },
                addClass: function (handle, cls) {
                    requirePerm(rec, 'dom-write');
                    return rpc('dom.addClass', { handle: handle, class: String(cls || '') });
                },
                removeClass: function (handle, cls) {
                    requirePerm(rec, 'dom-write');
                    return rpc('dom.removeClass', { handle: handle, class: String(cls || '') });
                },
                style: function (handle, prop, value) {
                    requirePerm(rec, 'dom-write');
                    return rpc('dom.style', { handle: handle, prop: String(prop || ''), value: String(value === undefined ? '' : value) });
                },
                setText: function (handle, text) {
                    requirePerm(rec, 'dom-write');
                    return rpc('dom.setText', { handle: handle, text: String(text === undefined ? '' : text) });
                },
                insert: function (handle, html, position) {
                    requirePerm(rec, 'dom-write');
                    return rpc('dom.insert', { handle: handle, html: String(html || ''), position: String(position || 'end') });
                },
                observe: function (opt) {
                    requirePerm(rec, 'dom-read');
                    const o = opt || {};
                    return rpc('dom.observe', { anchor: o.anchor });
                },
                onChange: function (cb) {
                    if (typeof cb !== 'function') return;
                    rec.handlers.domChange.push(cb);
                }
            },

            log: function () {
                const args = Array.prototype.slice.call(arguments).map(function (a) {
                    try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
                }).join(' ');
                slog(TAG, '[plugin:' + meta.id + ']', args);
                post({ type: 'log', payload: { pluginId: meta.id, level: 'info', text: args } });
            }
        };
    }

    function makeResp(r) {
        const headers = r.headers || {};
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            statusText: r.statusText || '',
            url: r.url || '',
            redirected: false,
            type: 'basic',
            headers: {
                get: function (k) { return headers[String(k).toLowerCase()] || null; },
                has: function (k) { return !!headers[String(k).toLowerCase()]; }
            },
            text: function () { return Promise.resolve(r.body || ''); },
            json: function () {
                try { return Promise.resolve(JSON.parse(r.body || 'null')); }
                catch (e) { return Promise.reject(new Error('响应不是合法 JSON')); }
            }
        };
    }

    async function gatedFetch(rec, url, opts) {
        let u;
        try {
            u = new URL(String(url));
        } catch (e) {
            throw new Error('非法 URL：' + url);
        }
        if (u.protocol !== 'https:') throw new Error('插件网络请求只允许 https');
        const host = u.hostname.toLowerCase();
        const allowed = (rec.meta.hosts || []).some(function (h) {
            h = String(h).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
            return host === h || host.slice(-(h.length + 1)) === '.' + h;
        });
        if (!allowed) {
            throw new Error('域名 ' + host + ' 不在该插件的 hosts 白名单内，请求已被拦截');
        }

        const o = opts || {};
        const method = String(o.method || 'GET').toUpperCase();
        let body;
        if (typeof o.body === 'string') body = o.body;
        else if (o.body !== undefined && o.body !== null) body = String(o.body);

        const res = await call('fetch', {
            url: u.toString(),
            method: method,
            headers: o.headers || {},
            body: body
        }, rec.meta.id);

        if (!res || res.ok !== true) throw new Error((res && res.error) || '网络请求失败');
        return makeResp(res);
    }

    /* ---------- 4. 加载插件 ---------- */

    function loadPlugin(payload) {
        if (!payload || !payload.id) return;
        const id = payload.id;
        plugins.delete(id);
        stopped.delete(id);          // 重新运行 = 解除停止标记

        const rec = {
            meta: payload.meta || { id: id },
            data: payload.data || {},
            handlers: { buttons: new Map(), postChange: [], domChange: [] }
        };
        plugins.set(id, rec);

        const code = String(payload.code || '');
        if (!code.trim()) {
            reportError(id, new Error('插件代码为空'));
            return;
        }

        const api = makeApi(rec);
        let fn;
        try {
            fn = new Function(
                'PickcatPlus',
                '"use strict";\nreturn (async () => {\n' + code + '\n})();\n//# sourceURL=pickcat-plugin:' + id + '.js'
            );
        } catch (e) {
            reportError(id, e);
            return;
        }

        try {
            const ret = fn(api);
            if (ret && typeof ret.then === 'function') {
                ret.then(function () {
                    slog(TAG, '插件已就绪：' + id);
                    post({ type: 'log', payload: { pluginId: id, level: 'ready', text: '插件已就绪' } });
                    post({ type: 'run-ok', payload: { id: id } });
                }).catch(function (e) { reportError(id, e); });
            } else {
                post({ type: 'run-ok', payload: { id: id } });
            }
        } catch (e) {
            reportError(id, e);
        }
    }

    /* ---------- 5. 开机 ---------- */

    stubGlobals();

    const NET_NAMES = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
    const NET_LEAKED = NET_NAMES.filter((name) => {
        try {
            const v = new Function('return typeof ' + name + ' === "undefined" ? undefined : ' + name)();
            if (typeof v !== 'function') return false;
            return String(v).indexOf('插件不能直接使用') === -1;
        } catch (e) {
            return false;
        }
    });

    slog(TAG, 'ready, 已拦截:', STUBBED.join(','));

    // 心跳：每 2 秒报一次活着。沙盒页靠它判断"是不是死循环了"。
    // 关键点：await 等待期间事件循环是空的，定时器照常触发；
    // 只有真正把线程占满的同步死循环才会让心跳断掉。
    setInterval(function () {
        try { post({ type: 'heartbeat' }); } catch (e) { }
    }, 2000);

    post({ type: 'worker-ready', self: { stubbedNet: STUBBED, netLeaked: NET_LEAKED, at: Date.now() } });
})();
`;

    /* ---------- 每插件一个 Worker ----------
     *
     * 早期版本所有插件共用同一个 Worker：省事，但一个插件写个
     * while(true) 就会把别的插件一起拖死（还只能靠心跳整体重启）。
     * 现在改成「一个插件一个线程」：
     *   - 谁死循环就掐谁，别的插件照跑
     *   - 插件 A 改全局变量污染不到插件 B
     *   - 停用/卸载 = 直接 terminate，比往线程里塞消息干净
     * 代价是每个插件多一个 Worker，几十个插件才会明显吃内存。
     */

    let workerUrlCache = null;
    function workerUrl() {
        if (!workerUrlCache) {
            workerUrlCache = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
        }
        return workerUrlCache;
    }

    const pool = new Map();        // pluginId -> { w, lastBeat, calls: Map<callId, timer>, alive }
    const callOwner = new Map();   // callId -> pluginId（把 worker 的调用号映射回插件）
    let workerStubbed = [];
    let beatTimer = null;

    function poolEntry(id) {
        return pool.get(id) || null;
    }

    function killOne(id, reason, silent) {
        const ent = pool.get(id);
        if (!ent) return false;
        try { ent.calls.forEach((t) => clearTimeout(t)); } catch (e) { }
        try { ent.w.terminate(); } catch (e) { }
        pool.delete(id);
        callOwner.forEach((owner, cid) => { if (owner === id) callOwner.delete(cid); });
        if (!silent) {
            console.warn(TAG, '插件 ' + id + ' 已停止：' + reason);
            toParent({ type: 'crashed', payload: { id: id, ids: [id], reason: reason } });
        }
        return true;
    }

    function resetAll(reason) {
        Array.from(pool.keys()).forEach((id) => killOne(id, reason || 'reset', true));
        pool.clear();
        callOwner.clear();
    }

    function spawnFor(id) {
        let ent = pool.get(id);
        if (ent) { killOne(id, '重新启动', true); }

        let w;
        try {
            w = new Worker(workerUrl());
        } catch (e) {
            console.warn(TAG, 'Worker 创建失败：' + (e && e.message));
            toParent({ type: 'worker-failed', payload: { error: String(e && e.message || e) } });
            return null;
        }

        ent = { w: w, lastBeat: Date.now(), calls: new Map(), alive: true };
        pool.set(id, ent);

        w.onerror = function (e) {
            console.warn(TAG, '[' + id + '] Worker 内部错误：' + (e && e.message));
        };

        w.onmessage = function (ev) {
            const d = ev.data;
            if (!d || d.__pickcat !== ENV) return;

            if (d.type === 'worker-ready') {
                const s = d.self || {};
                workerStubbed = s.stubbedNet || workerStubbed;
                slog(TAG, '[' + id + '] worker ready, 已拦截:', workerStubbed.join(','));
                return;
            }

            if (d.type === 'heartbeat') {
                ent.lastBeat = Date.now();
                return;
            }

            if (d.type === 'run-ok') {
                return;
            }

            if (d.type === 'call') {
                // 宿主回复超时也算卡死，但 fetch 豁免（大模型接口本来就能跑很久）
                if (d.method !== 'fetch' && d.id) {
                    callOwner.set(d.id, id);
                    ent.calls.set(d.id, setTimeout(() => {
                        ent.calls.delete(d.id);
                        killOne(id, '能力调用 20 秒无响应');
                    }, CALL_TIMEOUT));
                } else if (d.id) {
                    callOwner.set(d.id, id);
                }
                if (d.payload && typeof d.payload === 'object' && !d.payload.__pluginId) {
                    d.payload.__pluginId = id;
                }
                toParent(d);
                return;
            }

            if (d.type === 'log' && d.payload && !d.payload.pluginId) d.payload.pluginId = id;
            toParent(d);
        };

        w.postMessage({ __pickcat: ENV, type: 'ping' });

        // 每个 Worker 自己一份心跳看门狗的数据；总定时器只跑一个
        if (!beatTimer) {
            beatTimer = setInterval(function () {
                const now = Date.now();
                Array.from(pool.entries()).forEach(([pid, e]) => {
                    if (now - e.lastBeat > 12000) {
                        killOne(pid, '插件 12 秒没有心跳（疑似死循环）');
                    }
                });
            }, 3000);
        }

        return ent;
    }

    function postTo(id, msg) {
        const ent = poolEntry(id);
        if (!ent) return false;
        try { ent.w.postMessage(msg); return true; } catch (e) { return false; }
    }

    function postAll(msg) {
        let any = false;
        pool.forEach((ent) => { try { ent.w.postMessage(msg); any = true; } catch (e) { } });
        return any;
    }

    /* ---------- 2. 宿主 → Worker ---------- */

    window.addEventListener('message', function (ev) {
        const d = ev.data;
        if (!d || d.__pickcat !== ENV) return;

        if (d.type === 'call-reply') {
            const owner = callOwner.get(d.id);
            if (owner) {
                const ent = poolEntry(owner);
                if (ent) {
                    const t = ent.calls.get(d.id);
                    if (t) { clearTimeout(t); ent.calls.delete(d.id); }
                    try { ent.w.postMessage(d); } catch (e) { }
                }
                callOwner.delete(d.id);
            }
            return;
        }

        if (d.type === 'dev') {
            DEV_MODE = !!(d.payload && d.payload.on);
            postAll(d);
            return;
        }

        if (d.type === 'run') {
            const id = (d.payload || {}).id;
            if (!id) return;
            // 重启：先干掉旧的，再起一个干净线程
            if (!spawnFor(id)) return;
            postTo(id, d);
            return;
        }

        if (d.type === 'stop') {
            const sid = (d.payload || {}).id;
            if (sid) killOne(sid, '插件被停用', true);
            return;
        }

        if (d.type === 'storage-sync') {
            postAll(d);
            return;
        }

        if (d.type === 'event') {
            const p = d.payload || {};
            // 按钮点击只发给它自己的插件；其余广播
            if (p.name === 'button-click' && p.buttonId && p.buttonId.indexOf('::') > 0) {
                postTo(String(p.buttonId).split('::')[0], d);
            } else {
                postAll(d);
            }
            return;
        }

        if (d.type === 'revive') {
            const rid = (d.payload || {}).id;
            if (rid) {
                killOne(rid, '用户手动重启插件', true);
            } else {
                resetAll('用户手动重启插件');
            }
            return;
        }

        if (d.type === 'reset') {
            // 应急逃生：全部就地销毁
            resetAll('应急逃生');
            toParent({ type: 'worker-reset', payload: {} });
            return;
        }
    });


    /* ---------- 3. 开机 ---------- */

    stubGlobals();

    const NET_NAMES = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
    const NET_LEAKED = NET_NAMES.filter((name) => {
        try {
            const v = new Function('return typeof ' + name + ' === "undefined" ? undefined : ' + name)();
            if (typeof v !== 'function') return false;
            return String(v).indexOf('插件不能直接使用') === -1;
        } catch (e) {
            return false;
        }
    });

    // Worker 按需创建（每插件一个），开机只做自检

    const self = {
        origin: (function () { try { return String(location.origin); } catch (e) { return 'unknown'; } })(),
        hasChromeApi: (function () { try { return typeof chrome !== 'undefined' && !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; } })(),
        canEval: (function () { try { return new Function('return 1+1')() === 2; } catch (e) { return false; } })(),
        stubbedNet: STUBBED,
        netLeaked: NET_LEAKED,
        worker: true,
        at: Date.now()
    };

    slog(TAG, 'ready', self);
    toParent({ type: 'ready', self: self });
})();
