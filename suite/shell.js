/* ============================================================
 * PICKCAT Plus · 主题套装 / WinUI
 * shell.js —— 左侧导航栏 + 顶栏结构配合
 * 只负责「外壳」，不改任何页面数据。
 * ============================================================ */
(function () {
    'use strict';

    const NS = window.__PICKCAT_SUITE__;
    if (!NS) return;

    const ICONS = {
        menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
        home: '<path d="M4 10.8 12 4l8 6.8V20h-5.4v-5.2h-5.2V20H4z"/>',
        works: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.4"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.4"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.4"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.4"/>',
        forum: '<path d="M20 11.2c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.43L4 19l1.2-3.3C4.45 14.6 4 12.98 4 11.2 4 7.6 7.6 4.7 12 4.7s8 2.9 8 6.5z"/><path d="M8.5 10h7M8.5 13h4.5"/>',
        bell: '<path d="M18 16.5H6l1.2-1.8V10a4.8 4.8 0 0 1 9.6 0v4.7z"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>',
        gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19 13.4a7.6 7.6 0 0 0 0-2.8l2-1.5-2-3.4-2.4 1a7.8 7.8 0 0 0-2.4-1.4L14 2.8h-4l-.2 2.5a7.8 7.8 0 0 0-2.4 1.4l-2.4-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2.8l-2 1.5 2 3.4 2.4-1a7.8 7.8 0 0 0 2.4 1.4l.2 2.5h4l.2-2.5a7.8 7.8 0 0 0 2.4-1.4l2.4 1 2-3.4z"/>'
    };

    function icon(name) {
        return '<svg class="pcs-ico" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    }

    function item(route, iconName, label, href) {
        return '<a class="pcs-item" data-nav="' + route + '" href="' + href + '" title="' + label + '">' +
            icon(iconName) + '<span class="pcs-label">' + label + '</span></a>';
    }

    const Shell = {
        mounted: false,
        rail: null,

        mount: function () {
            if (this.mounted || document.querySelector('.pcs-rail')) return;
            const self = this;

            const avatarLink = document.querySelector('header a[href^="/profile/"]');
            const avatarHref = avatarLink ? avatarLink.getAttribute('href') : '/login';
            const avatarImg = avatarLink && avatarLink.querySelector('img');
            const avatarSrc = (avatarImg && avatarImg.getAttribute('src')) || chrome.runtime.getURL('icons/icon128.png');

            const rail = NS.el('aside', 'pcs-rail');
            rail.setAttribute('data-pickcat-suite', '');
            rail.setAttribute('aria-label', 'PICKCAT 导航');
            rail.innerHTML =
                '<button class="pcs-burger" type="button" aria-label="展开导航" aria-expanded="false">' + icon('menu') + '</button>' +
                '<nav class="pcs-nav">' +
                    item('home', 'home', '首页', '/') +
                    item('works', 'works', '作品', '/works') +
                    item('forum', 'forum', '论坛', '/forum') +
                '</nav>' +
                '<div class="pcs-fill"></div>' +
                '<a class="pcs-avatar" href="' + avatarHref + '" title="我的主页"><img alt="" src="' + avatarSrc + '"></a>' +
                '<button class="pcs-item" type="button" data-action="notify" title="通知">' + icon('bell') + '<span class="pcs-label">通知</span></button>' +
                '<button class="pcs-item" type="button" data-action="settings" title="PICKCAT 设置">' + icon('gear') + '<span class="pcs-label">设置</span></button>';

            document.body.appendChild(rail);
            this.rail = rail;
            this.mounted = true;

            rail.addEventListener('click', function (e) {
                const burger = e.target.closest('.pcs-burger');
                if (burger) {
                    const open = !rail.classList.contains('is-open');
                    rail.classList.toggle('is-open', open);
                    document.documentElement.classList.toggle('pickcat-suite-rail-open', open);
                    burger.setAttribute('aria-expanded', String(open));
                    burger.setAttribute('aria-label', open ? '收起导航' : '展开导航');
                    return;
                }

                const action = e.target.closest('[data-action]');
                if (action) {
                    if (action.dataset.action === 'notify') self.notify();
                    if (action.dataset.action === 'settings') self.openSettings();
                    return;
                }

                const link = e.target.closest('a[data-nav]');
                if (!link) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                const href = link.getAttribute('href');
                if (!href || href.charAt(0) !== '/') return;
                e.preventDefault();
                NS.navigate(href);
            });

            NS.onRoute(function () { self.syncActive(); });
            this.syncActive();
        },

        syncActive: function () {
            if (!this.rail) return;
            const path = location.pathname;
            let active = 'home';
            if (path.indexOf('/works') === 0) active = 'works';
            else if (path.indexOf('/forum') === 0) active = 'forum';
            NS.qsa('[data-nav]', this.rail).forEach(function (link) {
                const on = link.getAttribute('data-nav') === active;
                link.classList.toggle('is-active', on);
                if (on) link.setAttribute('aria-current', 'page');
                else link.removeAttribute('aria-current');
            });
        },

        notify: function () {
            const btn = document.querySelector('header button[aria-label*="通知"], header [aria-label*="通知"]');
            if (btn) { btn.click(); return; }
            NS.toast('没有找到通知入口');
        },

        openSettings: function () {
            const host = document.getElementById('pickcat-settings-host');
            const root = host && host.shadowRoot;
            if (!root) { NS.toast('设置面板还在加载，请稍后再试'); return; }
            const panel = root.getElementById('settings-panel');
            const zone = root.getElementById('hover-zone');
            if (!panel) { NS.toast('设置面板还在加载，请稍后再试'); return; }
            if (panel.classList.contains('open')) {
                panel.classList.remove('open');
                if (zone) zone.style.display = 'flex';
                return;
            }
            panel.classList.add('open');
            if (zone) zone.style.display = 'none';
        },

        unmount: function () {
            if (this.rail) this.rail.remove();
            this.rail = null;
            this.mounted = false;
            document.documentElement.classList.remove('pickcat-suite-rail-open');
        }
    };

    NS.shell = Shell;
})();
