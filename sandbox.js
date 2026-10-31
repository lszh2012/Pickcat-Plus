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

    /* ---------- 1. Worker 生命周期 ---------- */

    let worker = null;
    let workerStubbed = [];
    let runTimer = null;
    let runPluginId = null;
    let lastBeat = Date.now();
    let beatTimer = null;
    const runningIds = new Set();
    const callTimers = new Map();

    function broadcastCrash(reason) {
        const ids = runPluginId ? [runPluginId] : Array.from(runningIds);
        console.warn(TAG, '插件卡死，已强制终止：' + (ids.join(', ') || '(unknown)') + '（' + reason + '）');
        toParent({
            type: 'crashed',
            payload: { id: ids[0] || null, ids: ids, reason: reason }
        });
        runPluginId = null;
        runningIds.clear();
    }

    function clearRunTimer() {
        if (runTimer) { clearTimeout(runTimer); runTimer = null; }
    }

    function killWorker(reason) {
        clearRunTimer();
        if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
        callTimers.forEach((t) => clearTimeout(t));
        callTimers.clear();
        if (worker) {
            try { worker.terminate(); } catch (e) { }
            worker = null;
        }
        broadcastCrash(reason);
        spawnWorker();
    }


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
            const id = 'c' + (++seq);
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('调用 ' + method + ' 超时'));
            }, 25000);
            pending.set(id, { resolve: resolve, reject: reject, timer: timer });
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
        if (d.type === 'run') { loadPlugin(d.payload); return; }
        if (d.type === 'stop') {
            plugins.delete((d.payload || {}).id);
            post({ type: 'plugin-unloaded', payload: { id: (d.payload || {}).id } });
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

            log: function () {
                const args = Array.prototype.slice.call(arguments).map(function (a) {
                    try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
                }).join(' ');
                console.log(TAG, '[plugin:' + meta.id + ']', args);
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

        const rec = {
            meta: payload.meta || { id: id },
            data: payload.data || {},
            handlers: { buttons: new Map(), postChange: [] }
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
                    console.log(TAG, '插件已就绪：' + id);
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

    console.log(TAG, 'ready, 已拦截:', STUBBED.join(','));

    // 心跳：每 2 秒报一次活着。沙盒页靠它判断"是不是死循环了"。
    // 关键点：await 等待期间事件循环是空的，定时器照常触发；
    // 只有真正把线程占满的同步死循环才会让心跳断掉。
    setInterval(function () {
        try { post({ type: 'heartbeat' }); } catch (e) { }
    }, 2000);

    post({ type: 'worker-ready', self: { stubbedNet: STUBBED, netLeaked: NET_LEAKED, at: Date.now() } });
})();
`;

    let workerUrlCache = null;
    function workerUrl() {
        if (!workerUrlCache) {
            workerUrlCache = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
        }
        return workerUrlCache;
    }

    function spawnWorker() {
        try {
            worker = new Worker(workerUrl());
        } catch (e) {
            console.warn(TAG, 'Worker 创建失败，插件系统不可用：' + (e && e.message));
            toParent({ type: 'worker-failed', payload: { error: String(e && e.message || e) } });
            return;
        }

        worker.onerror = function (e) {
            console.warn(TAG, 'Worker 内部错误：' + (e && e.message));
        };

        worker.onmessage = function (ev) {
            const d = ev.data;
            if (!d || d.__pickcat !== ENV) return;

            if (d.type === 'worker-ready') {
                const s = d.self || {};
                workerStubbed = s.stubbedNet || [];
                console.log(TAG, 'worker ready, 已拦截:', workerStubbed.join(','));
                return;
            }

            if (d.type === 'heartbeat') {
                lastBeat = Date.now();
                return;
            }

            if (d.type === 'run-ok') {
                clearRunTimer();
                return;
            }

            if (d.type === 'call') {
                // 宿主回复超时也算卡死：说明 Worker 在回调里死循环了。
                // 但 fetch 除外 —— 大模型接口本身就可能跑 20 秒以上，
                // 那条链路有自己的 30 秒超时，别把慢网络误判成死循环。
                if (d.method !== 'fetch' && d.id && !callTimers.has(d.id)) {
                    callTimers.set(d.id, setTimeout(() => {
                        callTimers.delete(d.id);
                        killWorker('能力调用 20 秒无响应');
                    }, CALL_TIMEOUT));
                }
                toParent(d);
                return;
            }

            toParent(d);
        };

        worker.postMessage({ __pickcat: ENV, type: 'ping' });

        // 心跳看门狗：Worker 每 2 秒报一次活着，超过 12 秒没动静就当它死循环了。
        // 这是唯一能抓到"点击回调里死循环"的手段 —— 那种情况下没有任何
        // 未完成的 RPC，20 秒调用超时永远不会触发。
        lastBeat = Date.now();
        if (beatTimer) clearInterval(beatTimer);
        beatTimer = setInterval(function () {
            if (!worker) return;
            if (Date.now() - lastBeat > 12000) {
                killWorker('插件 12 秒没有心跳（疑似死循环）');
            }
        }, 3000);
    }

    /* ---------- 2. 宿主 → Worker ---------- */

    window.addEventListener('message', function (ev) {
        const d = ev.data;
        if (!d || d.__pickcat !== ENV) return;

        if (d.type === 'call-reply') {
            const t = callTimers.get(d.id);
            if (t) { clearTimeout(t); callTimers.delete(d.id); }
            if (worker) worker.postMessage(d);
            return;
        }

        if (d.type === 'run') {
            const id = (d.payload || {}).id;
            runPluginId = id;
            if (id) runningIds.add(id);
            // 注意：这里**不再**用「启动 N 秒没跑完就算卡死」。
            // 插件初始化里 await 一次慢网络是完全合法的（比如大模型接口），
            // 用总时长判卡死会误杀。真正的判据是心跳：
            // 等待 await 时事件循环是空的，心跳照发；只有同步死循环才会断。
            if (worker) worker.postMessage(d);
            else toParent({ type: 'crashed', payload: { id: id, reason: '插件运行时未启动' } });
            return;
        }

        if (d.type === 'stop') {
            const sid = (d.payload || {}).id;
            if (runPluginId === sid) { runPluginId = null; clearRunTimer(); }
            if (sid) runningIds.delete(sid);
            if (worker) worker.postMessage(d);
            return;
        }

        if (d.type === 'storage-sync' || d.type === 'event') {
            if (worker) worker.postMessage(d);
            return;
        }

        if (d.type === 'revive') {
            // 宿主侧「重试」：重建一个干净的 Worker
            killWorker('用户手动重启插件');
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

    spawnWorker();

    const self = {
        origin: (function () { try { return String(location.origin); } catch (e) { return 'unknown'; } })(),
        hasChromeApi: (function () { try { return typeof chrome !== 'undefined' && !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; } })(),
        canEval: (function () { try { return new Function('return 1+1')() === 2; } catch (e) { return false; } })(),
        stubbedNet: STUBBED,
        netLeaked: NET_LEAKED,
        worker: true,
        at: Date.now()
    };

    console.log(TAG, 'ready', self);
    toParent({ type: 'ready', self: self });
})();
