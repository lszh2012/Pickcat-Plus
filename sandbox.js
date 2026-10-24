/* ============================================================
 * PICKCAT Plus · 沙盒运行时 (sandbox.js)  —— 阶段 1
 *
 * 运行环境：manifest 里声明的 sandbox 页面
 *   - origin === "null"，拿不到任何 chrome.* API
 *   - 允许 eval / new Function（MV3 给沙盒的唯一特权）
 *   - 与主程序只通过 postMessage 通信（协议见 ENV）
 *
 * 这里做四件事：
 *   1. RPC 桥：插件的每一次 API 调用，转发给 content.js 执行
 *   2. 网络闸门：删除原生 fetch/XHR/WS，只留受 hosts 白名单约束的 PickcatPlus.fetch
 *   3. 插件加载器：new Function 包裹插件代码，支持顶层 await
 *   4. 错误兜底：插件崩了只影响自己，不影响主程序
 * ============================================================ */

(function () {
    'use strict';

    const TAG = '[pickcat-sandbox]';
    const ENV = 1;

    /* ============================================================
     * 0. 网络闸门：先把原生网络 API 抄进口袋，再从全局抹掉
     * ============================================================ */

    const nativeFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;

    const STUBBED = [];
    function stubGlobals() {
        const thrower = (name) => function () {
            throw new Error('插件不能直接使用 ' + name + '，请改用 PickcatPlus.fetch() 并在清单里声明 hosts 白名单');
        };
        ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].forEach((name) => {
            const stub = thrower(name);
            // 浏览器里 window === globalThis === self，但某些环境（含测试用的 vm）三者不一致，
            // 所以凡是能拿到的全局对象都盖一层，避免从别的入口摸到原生实现
            const targets = [window];
            try { if (typeof globalThis !== 'undefined' && globalThis !== window) targets.push(globalThis); } catch (e) { }
            try { if (typeof self !== 'undefined' && self !== window && self !== globalThis) targets.push(self); } catch (e) { }
            targets.forEach((obj) => {
                // 先尝试删除（Window 上的原生方法通常 configurable，删掉后原型链也拿不到）
                try { delete obj[name]; } catch (e) { /* 删不掉就靠下面的覆盖 */ }
                // 无论如何都覆盖一层：即使属性挂在原型链上、delete 无效，defineProperty 也能立起自己的桩
                try {
                    Object.defineProperty(obj, name, { value: stub, writable: true, configurable: true });
                } catch (e) {
                    try { obj[name] = stub; } catch (e2) { /* 彻底拦不住，只能记一笔 */ }
                }
            });
            STUBBED.push(name);
        });
        try {
            if (navigator.sendBeacon) {
                Object.defineProperty(navigator, 'sendBeacon', { value: thrower('navigator.sendBeacon'), configurable: true });
                STUBBED.push('navigator.sendBeacon');
            }
        } catch (e) { /* 忽略 */ }
    }

    /* ============================================================
     * 1. RPC 桥
     * ============================================================ */

    let seq = 0;
    const pending = new Map();

    function post(msg) {
        try {
            window.parent.postMessage(Object.assign({ __pickcat: ENV }, msg), '*');
        } catch (e) { /* 父窗口已关闭 */ }
    }

    function call(method, args, pluginId) {
        return new Promise((resolve, reject) => {
            const id = 'c' + (++seq);
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('调用 ' + method + ' 超时'));
            }, 30000);
            pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            post({ type: 'call', id: id, method: method, args: args || {}, pluginId: pluginId || 'unknown' });
        });
    }

    let currentPluginId = null;

    window.addEventListener('message', function (ev) {
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
        if (d.type === 'stop') { plugins.delete(d.payload.id); removeButtons(d.payload.id); return; }
        if (d.type === 'storage-sync') {
            const rec = plugins.get(d.payload.id);
            if (rec) rec.data = d.payload.data || {};
            return;
        }
        if (d.type === 'event') { dispatchEventToPlugins(d.payload); return; }
    });

    /* ============================================================
     * 2. 插件注册表
     * ============================================================ */

    const plugins = new Map(); // id -> { meta, data, handlers }

    function hasPerm(rec, perm) {
        const granted = (rec.meta && rec.meta.granted) || [];
        return granted.indexOf(perm) !== -1;
    }

    function requirePerm(rec, perm) {
        if (!hasPerm(rec, perm)) {
            throw new Error('插件 ' + (rec.meta.id || '?') + ' 没有申请「' + perm + '」权限，已拒绝该调用');
        }
    }

    function removeButtons(pluginId) {
        // 按钮 DOM 由 content.js 按 pluginId 前缀清理
        buttonIdsByPlugin.delete(pluginId);
        post({ type: 'plugin-unloaded', payload: { id: pluginId } });
    }

    const buttonIdsByPlugin = new Map();

    function noteButton(pluginId, buttonId) {
        if (!buttonIdsByPlugin.has(pluginId)) buttonIdsByPlugin.set(pluginId, []);
        buttonIdsByPlugin.get(pluginId).push(buttonId);
    }

    function dispatchEventToPlugins(payload) {
        const name = payload.name;
        if (name === 'button-click') {
            // 按钮点击只回给注册它的那个插件
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
        currentPluginId = pluginId;
        try {
            const r = fn(arg);
            if (r && typeof r.then === 'function') r.catch((e) => reportError(pluginId, e));
        } catch (e) {
            reportError(pluginId, e);
        } finally {
            currentPluginId = null;
        }
    }

    function reportError(pluginId, e) {
        const text = String((e && (e.stack || e.message)) || e);
        console.error(TAG, '[plugin:' + pluginId + ']', text);
        post({ type: 'log', payload: { pluginId: pluginId, level: 'error', text: text } });
    }

    /* ============================================================
     * 3. 插件 API 工厂
     * ============================================================ */

    function makeApi(rec) {
        const meta = rec.meta;
        const data = () => rec.data || (rec.data = {});
        const rpc = (m, a) => call(m, a, meta.id);

        const api = {
            meta: {
                id: meta.id,
                name: meta.name,
                version: meta.version,
                author: meta.author,
                hosts: meta.hosts || []
            },
            version: '1.0.0',

            /* ---- 页面读取 ---- */
            getPostContent: function () {
                requirePerm(rec, 'dom-read');
                return rpc('getPostContent', {});
            },

            /* ---- UI ---- */
            addInteractionButton: function (opt, onClick) {
                requirePerm(rec, 'ui-interaction');
                if (typeof onClick !== 'function') throw new Error('addInteractionButton 需要第二个参数是函数');
                const buttonId = meta.id + '::' + (opt.id || opt.label || 'btn');
                rec.handlers.buttons.set(buttonId, onClick);
                noteButton(meta.id, buttonId);
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

            /* ---- 通知 ---- */
            showToast: function (text) {
                requirePerm(rec, 'notify');
                return rpc('showToast', { text: String(text) });
            },

            /* ---- 剪贴板 ---- */
            copy: function (text) {
                requirePerm(rec, 'clipboard-write');
                return rpc('copy', { text: String(text) });
            },

            /* ---- 配置存储（按插件 id 命名空间隔离） ---- */
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

            /* ---- 网络（唯一出口，受 hosts 白名单约束） ---- */
            fetch: function (url, opts) {
                requirePerm(rec, 'network');
                return gatedFetch(rec, url, opts);
            },

            /* ---- 事件 ---- */
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

        return api;
    }

    async function gatedFetch(rec, url, opts) {
        if (!nativeFetch) throw new Error('沙盒网络不可用');
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

        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, 60000);
        const options = Object.assign({}, opts || {}, { signal: ctrl.signal });
        try {
            return await nativeFetch(u.toString(), options);
        } finally {
            clearTimeout(timer);
        }
    }

    /* ============================================================
     * 4. 插件加载
     * ============================================================ */

    function loadPlugin(payload) {
        if (!payload || !payload.id) return;
        const id = payload.id;
        // 支持重载：先清掉旧的
        plugins.delete(id);
        buttonIdsByPlugin.delete(id);

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
        currentPluginId = id;
        let fn;
        try {
            // 用 async 箭头包裹，插件里可以直接 await
            fn = new Function(
                'PickcatPlus',
                '"use strict";\nreturn (async () => {\n' + code + '\n})();\n//# sourceURL=pickcat-plugin:' + id + '.js'
            );
        } catch (e) {
            currentPluginId = null;
            reportError(id, e);
            return;
        }

        try {
            const ret = fn(api);
            if (ret && typeof ret.then === 'function') {
                ret.then(function () {
                    console.log(TAG, '插件已就绪：' + id);
                    post({ type: 'log', payload: { pluginId: id, level: 'ready', text: '插件已就绪' } });
                }).catch(function (e) { reportError(id, e); });
            }
        } catch (e) {
            reportError(id, e);
        } finally {
            currentPluginId = null;
        }
    }

    /* ============================================================
     * 5. 开机
     * ============================================================ */

    stubGlobals();

    // 桩装上之后再自检一遍：用和插件代码相同的名字解析路径去取值，
    // 如果拿到的不是我们的桩（还能直接调用原生实现），就在 ready 里如实上报
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
    if (NET_LEAKED.length) {
        console.warn(TAG, '网络桩未完全生效，以下 API 仍可直接调用：' + NET_LEAKED.join(', '));
    }

    const self = {
        origin: (function () { try { return String(location.origin); } catch (e) { return 'unknown'; } })(),
        hasChromeApi: (function () { try { return typeof chrome !== 'undefined' && !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; } })(),
        canEval: (function () { try { return new Function('return 1+1')() === 2; } catch (e) { return false; } })(),
        stubbedNet: STUBBED,
        netLeaked: NET_LEAKED,
        at: Date.now()
    };

    console.log(TAG, 'ready', self);
    post({ type: 'ready', self: self });
})();
