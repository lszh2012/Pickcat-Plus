/* ============================================================
 * PICKCAT Plus · 主题套装 / WinUI
 * core.js —— 命名空间、路由监听、样式注入、通用小工具
 *
 * 约定：
 *  - 所有注入 DOM 必带 data-pickcat-suite，关闭时整棵移除
 *  - 所有 CSS 只挂在 html.pickcat-suite-winui 下，绝不影响未开启的用户
 *  - 页面模块只通过 window.__PICKCAT_SUITE__ 交流，不互相引用
 * ============================================================ */
(function () {
    'use strict';

    if (window.__PICKCAT_SUITE__) return;

    const CSS_BASE = 'suite/';
    const NS = {
        version: '0.1.0',
        state: { enabled: false, route: '' },
        pages: {},
        _routeFns: [],
        _routeTimer: null,
        _lastRoute: null
    };

    NS.log = function () {
        try {
            if (window.__PICKCAT_DEV__) console.info.apply(console, ['[suite]'].concat([].slice.call(arguments)));
        } catch (e) { /* ignore */ }
    };

    NS.qs = function (sel, root) {
        return (root || document).querySelector(sel);
    };

    NS.qsa = function (sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    };

    NS.el = function (tag, className, html) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (html != null) node.innerHTML = html;
        return node;
    };

    NS.ready = function (fn) {
        if (document.body) { fn(); return; }
        document.addEventListener('DOMContentLoaded', fn, { once: true });
    };

    NS.currentRoute = function () {
        return location.pathname + location.search;
    };

    /* 站内 SPA 跳转：Vue Router 监听 popstate，pushState 后补发一次即可。 */
    NS.navigate = function (url) {
        if (!url) return;
        try {
            if (url === NS.currentRoute()) return;
            history.pushState({}, '', url);
            window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        } catch (e) {
            location.href = url;
        }
    };

    /* 路由变化回调：popstate + 轮询兜底（Vue Router 内部跳转不一定触发 popstate） */
    NS.onRoute = function (fn) {
        if (typeof fn !== 'function') return;
        NS._routeFns.push(fn);
        if (!NS._routeTimer) {
            const fire = function (force) {
                const route = NS.currentRoute();
                if (!force && route === NS._lastRoute) return;
                NS._lastRoute = route;
                NS.state.route = route;
                NS._routeFns.forEach(function (cb) {
                    try { cb(route); } catch (e) { console.warn('[suite] route handler failed', e); }
                });
            };
            NS._fireRoute = fire;
            window.addEventListener('popstate', function () { fire(false); });
            NS._routeTimer = setInterval(function () { fire(false); }, 250);
            fire(true);
        }
    };

    /* 以 <style> 文本注入：避免页面 CSP 拦截 chrome-extension:// 的 <link> */
    NS.injectCSS = function (id, file) {
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.setAttribute('data-pickcat-suite', '');
        (document.head || document.documentElement).appendChild(style);

        fetch(chrome.runtime.getURL(CSS_BASE + file)).then(function (res) {
            return res.text();
        }).then(function (text) {
            if (style.isConnected) style.textContent = text;
        }).catch(function () {
            style.remove();
            const link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            link.href = chrome.runtime.getURL(CSS_BASE + file);
            link.setAttribute('data-pickcat-suite', '');
            (document.head || document.documentElement).appendChild(link);
        });
    };

    NS.removeCSS = function (id) {
        const node = document.getElementById(id);
        if (node) node.remove();
    };

    /* 等某个选择器出现，最多等 timeout 毫秒 */
    NS.waitFor = function (sel, timeout) {
        return new Promise(function (resolve) {
            const found = document.querySelector(sel);
            if (found) { resolve(found); return; }
            let done = false;
            const finish = function (node) {
                if (done) return;
                done = true;
                observer.disconnect();
                clearTimeout(timer);
                resolve(node);
            };
            const observer = new MutationObserver(function () {
                const node = document.querySelector(sel);
                if (node) finish(node);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            const timer = setTimeout(function () { finish(document.querySelector(sel)); }, timeout || 8000);
        });
    };

    NS.toast = function (text) {
        let node = document.getElementById('pickcat-suite-toast');
        if (!node) {
            node = document.createElement('div');
            node.id = 'pickcat-suite-toast';
            node.setAttribute('data-pickcat-suite', '');
            node.style.cssText = [
                'position:fixed', 'left:50%', 'bottom:32px', 'transform:translate(-50%,12px)',
                'z-index:2147483000', 'padding:10px 16px', 'border-radius:8px',
                'background:rgba(32,32,32,.88)', 'color:#fff', 'font:13px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif',
                'box-shadow:0 8px 24px rgba(0,0,0,.18)', 'opacity:0', 'pointer-events:none',
                'transition:opacity .18s ease,transform .18s ease', 'backdrop-filter:blur(12px)'
            ].join(';');
            document.body.appendChild(node);
        }
        node.textContent = text;
        requestAnimationFrame(function () {
            node.style.opacity = '1';
            node.style.transform = 'translate(-50%,0)';
        });
        clearTimeout(node._timer);
        node._timer = setTimeout(function () {
            node.style.opacity = '0';
            node.style.transform = 'translate(-50%,12px)';
        }, 2200);
    };

    window.__PICKCAT_SUITE__ = NS;
})();
