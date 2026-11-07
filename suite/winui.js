/* ============================================================
 * PICKCAT Plus · 主题套装 / WinUI
 * winui.js —— 入口：开关、样式装配、设置面板 tab
 * ============================================================ */
(function () {
    'use strict';

    const NS = window.__PICKCAT_SUITE__;
    if (!NS) return;

    const KEY = 'pickcat_suite_winui';
    const HTML = document.documentElement;

    /* 初版隐藏：兼容性尚未达标，暂不公开展示。
     * 这里只关入口与自动应用，代码全部保留；改回 false 即恢复设置 tab。
     * 调试时可在控制台执行：__PICKCAT_SUITE__.winui.enable() */
    const HIDDEN = true;

    let enabled = false;
    let snapshot = null;
    let themeObserver = null;
    let tabUI = null;

    function keepLight() {
        if (!enabled) return;
        if (!HTML.classList.contains('light') || HTML.classList.contains('dark')) {
            HTML.classList.remove('dark');
            HTML.classList.add('light');
        }
    }

    function enable() {
        if (enabled) return;
        enabled = true;
        NS.state.enabled = true;

        snapshot = {
            dark: HTML.classList.contains('dark'),
            light: HTML.classList.contains('light')
        };

        HTML.classList.add('pickcat-suite-winui');
        keepLight();

        const host = document.getElementById('pickcat-settings-host');
        if (host) host.classList.add('pickcat-suite-on');

        NS.injectCSS('pickcat-suite-theme', 'theme.css');
        NS.injectCSS('pickcat-suite-shell', 'shell.css');

        if (themeObserver) themeObserver.disconnect();
        themeObserver = new MutationObserver(keepLight);
        themeObserver.observe(HTML, { attributes: true, attributeFilter: ['class'] });

        NS.waitFor('header', 10000).then(function () {
            if (enabled) NS.shell.mount();
        });

        refreshTab();
    }

    function disable() {
        if (!enabled) return;
        enabled = false;
        NS.state.enabled = false;

        if (themeObserver) {
            themeObserver.disconnect();
            themeObserver = null;
        }

        NS.shell.unmount();
        NS.removeCSS('pickcat-suite-theme');
        NS.removeCSS('pickcat-suite-shell');
        HTML.classList.remove('pickcat-suite-winui', 'pickcat-suite-rail-open');

        const host = document.getElementById('pickcat-settings-host');
        if (host) host.classList.remove('pickcat-suite-on');

        if (snapshot) {
            HTML.classList.toggle('dark', snapshot.dark === true);
            HTML.classList.toggle('light', snapshot.light === true);
            snapshot = null;
        }

        refreshTab();
    }

    function setEnabled(on) {
        chrome.storage.local.set({ [KEY]: on === true }, function () {
            if (on === true) enable();
            else disable();
            refreshTab();
        });
    }

    /* ---------------- 设置面板 tab ---------------- */
    function applyTabStyles(root) {
        if (root.querySelector('style[data-suite-tab-style]')) return;
        const style = document.createElement('style');
        style.setAttribute('data-suite-tab-style', '');
        style.textContent = [
            '.suite-note{margin:0;font-size:11.5px;line-height:1.65;color:var(--text-muted)}',
            '.suite-note b{color:var(--text-main);font-weight:600}',
            '.suite-ver{font-size:10.5px;color:var(--text-muted);border:1px solid var(--border);border-radius:999px;padding:2px 8px;white-space:nowrap}',
            '.suite-actions{display:flex;gap:8px;margin-top:2px}',
            '.suite-actions .ws-btn{flex:1}',
            '.suite-actions .ws-btn[disabled]{opacity:.45;cursor:not-allowed}',
            '.suite-preview{margin:0;padding:8px 10px;border-radius:8px;background:var(--bg-sunken);border:1px dashed var(--border);font-size:11px;line-height:1.6;color:var(--text-muted)}',
            '.nav-item svg.suite-tab-icon{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;background:none}',
            '@media (min-width:1024px){:host(.pickcat-suite-on) #hover-zone{display:none!important}}'
        ].join('\n');
        root.appendChild(style);
    }

    function ensureTab() {
        const host = document.getElementById('pickcat-settings-host');
        const root = host && host.shadowRoot;
        if (!root) return false;

        if (root.querySelector('[data-suite-tab]')) {
            tabUI = {
                nav: root.querySelector('[data-suite-tab].nav-item'),
                tab: root.getElementById('tab-suite'),
                toggle: root.getElementById('suiteWinuiToggle'),
                status: root.getElementById('suiteStatus'),
                off: root.getElementById('suiteOffBtn')
            };
            refreshTab();
            return true;
        }

        const navInner = root.querySelector('.nav-inner');
        const content = root.querySelector('.content-area');
        if (!navInner || !content) return false;

        host.classList.toggle('pickcat-suite-on', enabled);
        applyTabStyles(root);

        const nav = NS.el('div', 'nav-item');
        nav.setAttribute('data-suite-tab', '');
        nav.setAttribute('data-tab', 'tab-suite');
        nav.title = '主题套装';
        nav.innerHTML =
            '<svg class="suite-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v13H4z"/><path d="M4 10h16M9 10v8.5"/></svg>' +
            '<span class="nav-text">主题套装</span>';
        const aboutNav = navInner.querySelector('[data-tab="tab-about"]');
        navInner.insertBefore(nav, aboutNav || null);

        const tab = NS.el('div', 'tab-content');
        tab.id = 'tab-suite';
        tab.setAttribute('data-suite-tab', '');
        tab.innerHTML =
            '<div class="section-title">🪟 主题套装 · WinUI</div>' +
            '<div class="row-card">' +
                '<div class="row-info">' +
                    '<div class="row-title">WinUI 外观</div>' +
                    '<div class="row-desc">Windows 11 Fluent：左侧导航、磨砂玻璃、8px 圆角</div>' +
                '</div>' +
                '<label class="toggle-switch">' +
                    '<input type="checkbox" id="suiteWinuiToggle">' +
                    '<span class="toggle-slider"></span>' +
                '</label>' +
            '</div>' +
            '<div class="row-card" style="flex-direction:column;align-items:stretch;gap:10px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                    '<span class="row-desc" id="suiteStatus">未开启</span>' +
                    '<span class="suite-ver">P1 · 外壳</span>' +
                '</div>' +
                '<div class="suite-actions">' +
                    '<button class="ws-btn" type="button" id="suiteOffBtn" disabled>恢复原生外观</button>' +
                    '<button class="ws-btn" type="button" id="suiteReloadBtn">刷新页面</button>' +
                '</div>' +
            '</div>' +
            '<p class="suite-preview">当前进度：左侧导航 + 顶栏 + 全局 WinUI 观感。<br>下一步会接入首页仪表盘、作品页与论坛列表。</p>' +
            '<p class="suite-note"><b>仅桌面端生效</b>（窗口宽度 ≥ 1024px）。开启时会临时切换为浅色主题；关闭后恢复原来的配色。<br>与「创意工坊」的纯 CSS 主题同时开启可能互相覆盖，建议二选一。</p>' +
            '<p class="suite-note" style="opacity:.75">设计参考：Bli-Hus × Xuzho 的 PICKCAT 概念设计。</p>';
        content.appendChild(tab);

        tabUI = {
            nav: nav,
            tab: tab,
            toggle: root.getElementById('suiteWinuiToggle'),
            status: root.getElementById('suiteStatus'),
            off: root.getElementById('suiteOffBtn')
        };

        tabUI.nav.addEventListener('click', function (e) {
            e.stopPropagation();
            root.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
            root.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
            nav.classList.add('active');
            tab.classList.add('active');
            refreshTab();
        });

        /* 点其它 tab 时把我们的高亮/内容收起来（content.js 的事件只认识它自己的节点） */
        navInner.addEventListener('click', function (e) {
            if (e.target.closest('[data-suite-tab]')) return;
            nav.classList.remove('active');
            tab.classList.remove('active');
        }, true);

        tabUI.toggle.addEventListener('change', function () {
            setEnabled(tabUI.toggle.checked);
            refreshTab();
        });

        tabUI.off.addEventListener('click', function () {
            setEnabled(false);
        });

        root.getElementById('suiteReloadBtn').addEventListener('click', function () {
            location.reload();
        });

        refreshTab();
        return true;
    }

    function refreshTab() {
        if (!tabUI) return;
        if (tabUI.toggle) tabUI.toggle.checked = enabled;
        if (tabUI.status) {
            tabUI.status.textContent = enabled
                ? '已开启 · 当前页立即生效'
                : '未开启 · 页面保持原样';
        }
        if (tabUI.off) tabUI.off.disabled = !enabled;
    }

    function bootTab() {
        if (ensureTab()) return;
        let tries = 0;
        const timer = setInterval(function () {
            tries++;
            if (ensureTab() || tries > 40) clearInterval(timer);
        }, 250);
    }

    function boot() {
        /* 隐藏期不读存储、不自动应用、不注册设置 tab；
         * 避免旧存储里开着的人刷新后仍然看到半成品外观。 */
        if (HIDDEN) return;

        NS.ready(function () {
            chrome.storage.local.get([KEY], function (res) {
                if (res[KEY] === true) enable();
                bootTab();
            });

            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== 'local' || !changes[KEY]) return;
                if (changes[KEY].newValue === true) enable();
                else disable();
                refreshTab();
            });
        });
    }

    NS.winui = {
        enable: enable,
        disable: disable,
        isEnabled: function () { return enabled; },
        hidden: HIDDEN,
        version: NS.version
    };

    boot();
})();
