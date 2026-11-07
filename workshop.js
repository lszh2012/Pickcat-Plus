/* =========================================================================
   创意工坊（独立整页）
   -------------------------------------------------------------------------
   这一页只负责「看」和「点」：
     - 清单：内置清单（打包在扩展里）+ 社区清单（GitHub / jsDelivr）
     - 真正的安装/卸载交给页面里的 content script 去做（它才碰得到页面）
     - 本页与 content script 之间通过 chrome.tabs.sendMessage 通信
   为什么不让本页直接写 storage：主题要注入 CSS/DOM、插件要起沙盒，
   这些都只有页面上下文能做。写一半会在两边留下不一致的状态。
   ========================================================================= */
(function () {
    'use strict';

    const CDN_BASES = [
        'https://raw.githubusercontent.com/lszh2012/Pickcat-Plus/main/',
        'https://raw.githubusercontent.com/lszh2012/Pickcat-Plus/master/',
        'https://cdn.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/',
        'https://fastly.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/',
        'https://gcore.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/',
        'https://testingcf.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/'
    ];
    const CACHE_KEY = 'pickcat_ws_catalog_cache';
    const TIER_KEY = 'pickcat_ws_tier';
    const FREE_KEY = 'pickcat_ws_free_consent';
    const STATE_KEY = 'pickcat_ws_state';
    const CONSENT_KEY = 'pickcat_ws_consent';
    const REPO_URL = 'https://github.com/lszh2012/Pickcat-Plus';
    const DOCS_URL = REPO_URL + '/blob/main/DEVELOPER.md';
    const ID_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;
// 图标只认三种：emoji / 官方图床直链 / 小 data URI。
// 图床只存引用不存图 —— 仓库里不放图片，也就不必为人家的图负责。
const IMG_HOST_RE = /^https:\/\/pickcat\.dao3\.fun\/api\/v1\/files\/[A-Za-z0-9_-]{8,64}$/;

    const TIERS = ['safe', 'balanced', 'free'];
    // 不用 emoji：色点交给样式（.dot-safe 等），文字只留档位名
    const TIER_LABEL = { safe: '安全', balanced: '均衡', free: '自由' };
    const TIER_HINT = {
        safe: '不读页面、不联网 —— 主题和小工具放这里',
        balanced: '能读页面、能改编辑区，联网只走白名单',
        free: '能改写整个页面结构 —— 只装你信得过的东西'
    };
    const PERM_LABEL = {
        'dom-read': '读取页面内容',
        'ui-interaction': '在页面上加按钮',
        'notify': '弹提示',
        'clipboard-write': '写剪贴板',
        'storage': '保存设置',
        'network': '联网',
        'dom-write': '改动页面（锚点内）',
        'dom-global': '改动整个页面'
    };

    const el = {
        kw: document.getElementById('kw'),
        sync: document.getElementById('sync'),
        tier: document.getElementById('tier'),
        cols: document.getElementById('cols'),
        status: document.getElementById('status'),
        openPanel: document.getElementById('openPanel'),
        list: document.getElementById('list'),
        empty: document.getElementById('empty'),
        mask: document.getElementById('mask'),
        drawer: document.getElementById('drawer'),
        drawerHead: document.getElementById('drawerHead'),
        drawerBody: document.getElementById('drawerBody'),
        drawerFoot: document.getElementById('drawerFoot'),
        modalMask: document.getElementById('modalMask'),
        modal: document.getElementById('modal'),
        toast: document.getElementById('toast'),
        pageHint: document.getElementById('pageHint')
    };

    const app = {
        catalog: [],
        installed: {},
        safeMode: false,
        tier: 'balanced',
        cat: 'all',
        kw: '',
        cols: 1,
        openId: null,
        syncedAt: 0,
        remoteUpdated: '',
        tabAvailable: null
    };

    /* ---------------- 小工具 ---------------- */
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    let toastTimer = 0;
    function toast(text, ms) {
        el.toast.textContent = text;
        el.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms || 2600);
    }

    const get = (keys) => new Promise((done) => {
        try { chrome.storage.local.get(keys, (r) => done(r || {})); } catch (e) { done({}); }
    });
    const set = (obj) => new Promise((done) => {
        try { chrome.storage.local.set(obj, () => done()); } catch (e) { done(); }
    });

    function tierOf(item) {
        if (item.type === 'theme' && (!item.permissions || !item.permissions.length)) return 'safe';
        const p = item.permissions || [];
        if (p.indexOf('dom-global') >= 0) return 'free';
        if (p.length && (p.indexOf('dom-read') >= 0 || p.indexOf('dom-write') >= 0 || p.indexOf('network') >= 0 || p.indexOf('ui-interaction') >= 0)) return 'balanced';
        if (item.tier && TIERS.indexOf(item.tier) >= 0) return item.tier;
        return 'safe';
    }
    const tierRank = (t) => TIERS.indexOf(t) < 0 ? 0 : TIERS.indexOf(t);
    function tierAllows(item) {
        return tierRank(tierOf(item)) <= tierRank(app.tier);
    }

    function shortHash(h) { return h ? String(h).slice(0, 8) : ''; }

    /* ---------------- 与页面通信 ---------------- */
    function sendCmd(op, payload) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; resolve(v); } };
            try {
                chrome.tabs.query({ url: ['*://pickcat.dao3.fun/*'] }, (tabs) => {
                    if (chrome.runtime.lastError || !tabs || !tabs.length) {
                        app.tabAvailable = false;
                        return done({ ok: false, error: 'no-tab' });
                    }
                    app.tabAvailable = true;
                    const tab = tabs.find((t) => t.active) || tabs[0];
                    chrome.tabs.sendMessage(tab.id, { type: 'pickcat-ws', op: op, payload: payload || {} }, (res) => {
                        if (chrome.runtime.lastError) return done({ ok: false, error: 'no-content' });
                        done(res || { ok: false, error: 'empty' });
                    });
                });
            } catch (e) {
                done({ ok: false, error: 'exception' });
            }
            setTimeout(() => done({ ok: false, error: 'timeout' }), 15000);
        });
    }

    function explainError(r) {
        if (!r) return '未知错误';
        if (r.error === 'no-tab') return '先打开 pickcat.dao3.fun 再来装 —— 主题要作用在页面上，光有这一页做不了喵';
        if (r.error === 'no-content') return '页面还没加载好扩展，刷新一下 pickcat.dao3.fun 再试';
        if (r.error === 'timeout') return '页面没回应，刷新一下试试';
        return r.error || '操作失败';
    }

    /* ---------------- 清单 ---------------- */
    function normalize(raw, base) {
        if (!raw || typeof raw !== 'object') return null;
        const id = String(raw.id || '');
        if (!ID_RE.test(id)) return null;
        const type = raw.type === 'theme' ? 'theme' : 'plugin';
        const item = {
            id: id,
            type: type,
            name: String(raw.name || id).slice(0, 40),
            emoji: String(raw.emoji || (type === 'theme' ? '🎨' : '🧩')).slice(0, 4),
            category: String(raw.category || (type === 'theme' ? 'theme' : 'plugin')),
            author: String(raw.author || '').slice(0, 40),
            version: String(raw.version || '0.0.0').slice(0, 20),
            verified: ['official', 'reviewed'].indexOf(raw.verified) >= 0 ? raw.verified : 'unverified',
            desc: String(raw.desc || '').slice(0, 900),
            permissions: Array.isArray(raw.permissions) ? raw.permissions.slice(0, 8) : [],
            hosts: Array.isArray(raw.hosts) ? raw.hosts.slice(0, 10) : [],
            claims: Array.isArray(raw.claims) ? raw.claims.slice(0, 5) : [],
            settings: Array.isArray(raw.settings) ? raw.settings.slice(0, 12) : [],
            mode: ['dark', 'light', 'any'].indexOf(raw.mode) >= 0 ? raw.mode : 'any',
            preview: raw.preview && typeof raw.preview === 'object' ? raw.preview : null,
            icon: (function () {
                const ic = typeof raw.icon === 'string' ? raw.icon.trim() : '';
                if (!ic || ic.length > 26000) return '';
                if (ic.length <= 4) return ic;                                  // emoji
                if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(ic)) return ic;
                if (IMG_HOST_RE.test(ic)) return ic;                            // 官方图床
                return '';
            })(),
            sha256: String(raw.sha256 || ''),
            source: base ? 'community' : 'builtin',
            hidden: !!raw.hidden,
            tier: raw.tier
        };
        if (type === 'theme') {
            item.htmlClass = raw.htmlClass || ('pickcat-theme-' + id.replace(/^theme[-_]/i, ''));
        }
        return item;
    }

    async function fetchJson(url, ms) {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), ms || 7000) : 0;
        try {
            const res = await fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + '_pcb=' + Date.now(), {
                cache: 'no-store',
                signal: ctl ? ctl.signal : undefined
            });
            if (!res || !res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function loadBuiltin() {
        try {
            const res = await fetch(chrome.runtime.getURL('workshop/builtin.json'), { cache: 'no-store' });
            const json = await res.json();
            return (json.items || []).map((i) => normalize(i, null)).filter(Boolean);
        } catch (e) {
            return [];
        }
    }

    async function loadCommunityCached() {
        const cached = (await get([CACHE_KEY]))[CACHE_KEY];
        if (cached && cached.items && Date.now() - (cached.at || 0) < 10 * 60 * 1000) {
            app.remoteUpdated = cached.updated || '';
            return cached.items.map((i) => normalize(i, '__remote__')).filter(Boolean);
        }
        return null;
    }

    async function fetchCommunity() {
        for (let i = 0; i < CDN_BASES.length; i++) {
            const json = await fetchJson(CDN_BASES[i] + 'workshop/community.json', 7000);
            if (json && Array.isArray(json.items)) {
                const items = json.items.map((it) => normalize(it, CDN_BASES[i])).filter(Boolean);
                app.remoteUpdated = json.updated || '';
                await set({ [CACHE_KEY]: { items: json.items, updated: json.updated || '', at: Date.now() } });
                return items;
            }
        }
        return null;
    }

    async function loadAll(force) {
        el.sync.disabled = true;
        el.sync.textContent = '同步中…';
        const builtin = await loadBuiltin();
        let community = force ? null : await loadCommunityCached();
        if (!community) community = await fetchCommunity();
        if (!community) community = [];

        const seen = {};
        builtin.forEach((i) => { seen[i.id] = 1; });
        const merged = builtin.concat(community.filter((i) => !seen[i.id]));
        app.catalog = merged;
        app.syncedAt = Date.now();
        el.sync.disabled = false;
        el.sync.textContent = '同步';
        render();
    }

    /* ---------------- 状态 ---------------- */
    async function refreshState() {
        const res = await get([STATE_KEY, TIER_KEY, 'pickcat_ws_revoked']);
        const st = res[STATE_KEY] || {};
        app.installed = st.installed || {};
        app.safeMode = !!st.safeMode;
        app.tier = TIERS.indexOf(res[TIER_KEY]) >= 0 ? res[TIER_KEY] : 'balanced';
        el.tier.value = app.tier;
        el.tier.classList.toggle('free', app.tier === 'free');
    }

    /* ---------------- 渲染 ---------------- */
    function visibleItems() {
        const kw = app.kw.trim().toLowerCase();
        return app.catalog.filter((it) => {
            // hidden 的条目（比如测试用的安全实验室）不摆在货架上，但装过的还能在这里管
            if (it.hidden && !app.installed[it.id]) return false;
            if (app.cat === 'installed') {
                if (!app.installed[it.id]) return false;
            } else if (app.cat !== 'all') {
                if (it.category !== app.cat) return false;
            }
            if (!kw) return true;
            return (it.name + ' ' + it.author + ' ' + it.desc + ' ' + it.id).toLowerCase().indexOf(kw) >= 0;
        });
    }

    // 逐段比版本号，1.2.10 > 1.2.9
    function cmpVersion(a, b) {
        const pa = String(a || '0').split('.');
        const pb = String(b || '0').split('.');
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const na = parseInt(pa[i], 10) || 0;
            const nb = parseInt(pb[i], 10) || 0;
            if (na !== nb) return na > nb ? 1 : -1;
        }
        return 0;
    }

    function updOf(item) {
        const rec = app.installed[item.id];
        if (!rec || !item.version || !rec.version) return null;
        if (cmpVersion(rec.version, item.version) >= 0) return null;
        return { from: rec.version, to: item.version };
    }

    function badgeOf(item) {
        if (item.verified === 'official') return '<span class="badge">内置</span>';
        if (item.verified === 'reviewed') return '<span class="badge">已审核</span>';
        return '<span class="badge warn">社区 · 未经审核</span>';
    }

    function tagsHtml(item) {
        const out = [];
        const t = tierOf(item);
        out.push('<span class="tag tier-' + t + '"><i class="dot dot-' + t + '"></i>' + TIER_LABEL[t] + '</span>');
        if (item.mode === 'dark') out.push('<span class="tag">深色专用</span>');
        if (item.mode === 'light') out.push('<span class="tag">浅色专用</span>');
        (item.permissions || []).forEach((p) => {
            out.push('<span class="tag' + (p === 'network' ? ' net' : '') + '">' + esc(PERM_LABEL[p] || p) + '</span>');
        });
        if ((item.claims || []).length) out.push('<span class="tag claim">接管 ' + item.claims.length + ' 项设置</span>');
        return out.join('');
    }

    function previewHtml(item) {
        const bg = item.preview && item.preview.bg;
        if (bg) return 'style="background-image:linear-gradient(var(--bg-soft),var(--bg-soft)),' + esc(bg) + '"';
        return '';
    }

    // 缩略区内容：预览图 > 预览渐变 > 图标 > emoji
    function thumbInner(item, style) {
        const img = item.preview && item.preview.image;
        if (img) return '<img class="thumb-img" src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
        if (style) return '';
        if (item.icon && item.icon.length > 4) return '<img class="thumb-img" src="' + esc(item.icon) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
        return '<span class="thumb-emo">' + esc(item.icon || item.emoji || '📦') + '</span>';
    }

    function cardHtml(item) {
        const inst = !!app.installed[item.id];
        const cls = 'card' + (inst ? ' installed' : '');
        const bg = item.preview && item.preview.bg;
        const thumbStyle = bg ? ' style="background-image:' + esc(bg) + '"' : '';
        return '<div class="' + cls + '" data-id="' + esc(item.id) + '">' +
            '<div class="thumb"' + thumbStyle + '>' + thumbInner(item, thumbStyle) + '</div>' +
            '<div class="card-body">' +
            '<div class="card-title"><h3>' + esc(item.name) + '</h3>' + badgeOf(item) + (inst ? '<span class="badge">已安装</span>' : '') + (updOf(item) ? '<span class="badge warn">可更新</span>' : '') + '</div>' +
            (item.author ? '<div class="author">by ' + esc(item.author) + '</div>' : '') +
            '<p class="card-desc">' + esc(item.desc) + '</p>' +
            '<div class="tags">' + tagsHtml(item) + '</div>' +
            '</div></div>';
    }

    function render() {
        el.list.style.setProperty('--cols', app.cols);
        // 单列走「分隔线列表」，两/三列才变成带边框的格子（样式里按这个属性分叉）
        el.list.setAttribute('data-cols', String(app.cols));
        const items = visibleItems();
        el.list.innerHTML = items.map(cardHtml).join('');
        el.empty.style.display = items.length ? 'none' : 'block';
        el.empty.textContent = app.cat === 'installed' ? '还没有装任何东西喵' : '没找到匹配的条目喵';

        const count = (f) => app.catalog.filter(f).length;
        document.getElementById('n-all').textContent = app.catalog.length;
        document.getElementById('n-theme').textContent = count((i) => i.category === 'theme');
        document.getElementById('n-plugin').textContent = count((i) => i.category === 'plugin');
        document.getElementById('n-ai').textContent = count((i) => i.category === 'ai');
        document.getElementById('n-link').textContent = count((i) => i.category === 'link');
        document.getElementById('n-installed').textContent = Object.keys(app.installed).length;

        const when = app.remoteUpdated ? ' · 清单 ' + app.remoteUpdated.replace('T', ' ').slice(0, 16) : '';
        el.status.textContent = '已安装 ' + Object.keys(app.installed).length + ' 个 · 共 ' + app.catalog.length + ' 个' + when;
        checkTabHint();
    }

    function checkTabHint() {
        chrome.tabs.query({ url: ['*://pickcat.dao3.fun/*'] }, (tabs) => {
            const has = !chrome.runtime.lastError && tabs && tabs.length;
            app.tabAvailable = !!has;
            el.pageHint.classList.toggle('show', !has);
            el.pageHint.innerHTML = has ? '' :
                '没有检测到已打开的 PICKCAT 页面。安装 / 卸载需要页面来应用效果 —— ' +
                '请先在新标签打开 <a href="https://pickcat.dao3.fun/" target="_blank" rel="noopener">pickcat.dao3.fun</a>，再回来操作喵。';
        });
    }

    /* ---------------- 详情 ---------------- */
    function openDetail(id) {
        const item = app.catalog.find((i) => i.id === id);
        if (!item) return;
        app.openId = id;
        const inst = app.installed[id];
        const t = tierOf(item);

        const thumbStyle = item.preview && item.preview.bg ? ' style="background-image:' + esc(item.preview.bg) + '"' : '';
        el.drawerHead.innerHTML = '<div class="thumb"' + thumbStyle + '>' + thumbInner(item, thumbStyle) + '</div>' +
            '<div class="drawer-title"><h2>' + esc(item.name) + '</h2>' +
            '<div class="author">' + (item.author ? 'by ' + esc(item.author) : '—') + ' · v' + esc(item.version) + '</div>' +
            '<div class="tags" style="margin-top:6px">' + badgeOf(item) + tagsHtml(item) + '</div></div>';

        const rows = [
            ['类型', item.type === 'theme' ? '个性主题（纯数据）' : '功能插件（会跑代码）'],
            ['等级', TIER_LABEL[t] + ' · ' + TIER_HINT[t]],
            ['来源', item.source === 'builtin' ? '随扩展打包' : '社区投稿（未审核）'],
            ['状态', inst
                ? (updOf(item) ? '已安装 v' + inst.version + ' · 可更新到 v' + item.version
                    : (inst.enabled === false ? '已安装 · 已停用' : '已安装'))
                : '未安装']
        ];
        if (item.sha256) rows.push(['指纹', '<code>' + esc(shortHash(item.sha256)) + '</code>（完整值见清单）']);
        if (item.hosts && item.hosts.length) rows.push(['域名白名单', item.hosts.map(esc).join('<br>')]);

        let html = '';
        if (item.preview && item.preview.image) html += '<div class="preview"><img src="' + esc(item.preview.image) + '" alt="" referrerpolicy="no-referrer"></div>';
        else if (item.preview && item.preview.bg) html += '<div class="preview" style="background-image:' + esc(item.preview.bg) + '"></div>';
        html += '<p>' + esc(item.desc) + '</p>';
        html += '<div class="section-label">信息</div><dl class="kv">' +
            rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>';

        if ((item.permissions || []).length) {
            html += '<div class="section-label">这个包会做什么</div><div class="perm-list">' +
                item.permissions.map((p) => '<span class="tag' + (p === 'network' ? ' net' : '') + '">' + esc(PERM_LABEL[p] || p) + '</span>').join('') +
                '</div>';
        }
        if ((item.claims || []).length) {
            html += '<div class="section-label">会接管你的设置</div>';
            html += item.claims.map((c) => '<p style="font-size:13px;color:var(--text-muted)"><b>' +
                esc(c.label || c.key) + '</b> → ' + esc(c.value) +
                (c.reason ? '<br>' + esc(c.reason) : '') + '</p>').join('');
        }
        if ((item.settings || []).length) {
            html += '<div class="section-label">可配置项</div>';
            html += item.settings.map((s) => '<p style="font-size:13px;color:var(--text-muted)">· <b>' +
                esc(s.label || s.key) + '</b>' + (s.hint ? '：' + esc(s.hint) : '') + '</p>').join('');
        }
        if (item.type === 'plugin') {
            html += '<div class="section-label">说明</div><p style="font-size:13px;color:var(--text-muted)">' +
                '插件跑在沙盒里，看不到你的账号、Cookie 和输入框内容；联网要申报域名，由扩展代发。' +
                '装完之后可以在 PICKCAT 页面的设置面板里改它的设置。</p>';
        }
        el.drawerBody.innerHTML = html;

        el.drawerFoot.innerHTML = '';
        if (inst) {
            const up = updOf(item);
            if (up) {
                const upBtn = document.createElement('button');
                upBtn.className = 'btn primary';
                upBtn.textContent = '更新到 v' + up.to;
                upBtn.addEventListener('click', () => doUpdate(item));
                el.drawerFoot.appendChild(upBtn);
            }
            const unBtn = document.createElement('button');
            unBtn.className = 'btn danger';
            unBtn.textContent = '卸载';
            unBtn.addEventListener('click', () => doUninstall(item));
            el.drawerFoot.appendChild(unBtn);
            const closeBtn = document.createElement('button');
            closeBtn.className = 'btn';
            closeBtn.textContent = '关闭';
            closeBtn.addEventListener('click', closeDetail);
            el.drawerFoot.appendChild(closeBtn);
        } else {
            const addBtn = document.createElement('button');
            addBtn.className = 'btn primary';
            addBtn.textContent = tierAllows(item) ? '安装' : '需要先放开到 ' + TIER_LABEL[t];
            addBtn.disabled = !tierAllows(item);
            addBtn.addEventListener('click', () => doInstall(item));
            el.drawerFoot.appendChild(addBtn);
            const closeBtn = document.createElement('button');
            closeBtn.className = 'btn';
            closeBtn.textContent = '关闭';
            closeBtn.addEventListener('click', closeDetail);
            el.drawerFoot.appendChild(closeBtn);
        }

        el.drawer.classList.add('open');
        el.mask.classList.add('open');
    }

    function closeDetail() {
        app.openId = null;
        el.drawer.classList.remove('open');
        el.mask.classList.remove('open');
    }

    /* ---------------- 弹窗 ---------------- */
    function openModal(html) {
        el.modal.innerHTML = html;
        el.modalMask.classList.add('open');
    }
    function closeModal() { el.modalMask.classList.remove('open'); }

    function confirmInstallDialog(item) {
        return new Promise((resolve) => {
            const perms = (item.permissions || []).map((p) =>
                '<li>' + esc(PERM_LABEL[p] || p) + '</li>').join('') || '<li>（没有特殊权限）</li>';
            const hosts = (item.hosts || []).length
                ? '<li>联网只限：' + item.hosts.map(esc).join('、') + '</li>' : '';
            openModal(
                '<h3>这个插件会跑代码</h3>' +
                '<p class="sub">主题是纯数据不弹这个。插件会在隔离沙盒里执行，签一次就够，以后不再问。</p>' +
                '<ul>' + perms + hosts + '</ul>' +
                '<div class="check"><input type="checkbox" id="agree"><label for="agree">我读完了，愿意承担安装第三方插件的风险。</label></div>' +
                '<div class="modal-foot"><button class="btn" id="no">先不用</button>' +
                '<button class="btn primary" id="yes" disabled>同意并继续</button></div>'
            );
            const agree = el.modal.querySelector('#agree');
            const yes = el.modal.querySelector('#yes');
            agree.addEventListener('change', () => { yes.disabled = !agree.checked; });
            el.modal.querySelector('#no').addEventListener('click', () => { closeModal(); resolve(false); });
            yes.addEventListener('click', async () => {
                await set({ [CONSENT_KEY]: { v: 1, at: Date.now() } });
                closeModal();
                resolve(true);
            });
        });
    }

    function freeDisclaimerDialog() {
        return new Promise((resolve) => {
            openModal(
                '<h3>开启「自由」等级</h3>' +
                '<p class="sub">这一档允许插件改写整个页面的结构。除非你明确知道自己在做什么、或者确实需要这个档位的插件，否则不要开。</p>' +
                '<div class="warnbox">开着的期间，任何标了「自由」的包都能改掉页面上的任何东西 —— 包括你正在看的评论区和输入框。</div>' +
                '<div class="check"><input type="checkbox" id="a1"><label for="a1">我知道风险，并且只会在需要时开它。</label></div>' +
                '<div class="check" style="display:block"><label for="a2">给我一个字一个字打「自由」确认：</label>' +
                '<input type="text" id="a2" placeholder="自由" autocomplete="off"></div>' +
                '<div class="modal-foot"><button class="btn" id="no">算了</button>' +
                '<button class="btn primary" id="yes" disabled>我明白，开启</button></div>'
            );
            const a1 = el.modal.querySelector('#a1');
            const a2 = el.modal.querySelector('#a2');
            const yes = el.modal.querySelector('#yes');
            const check = () => { yes.disabled = !(a1.checked && a2.value.trim() === '自由'); };
            a1.addEventListener('change', check);
            a2.addEventListener('input', check);
            el.modal.querySelector('#no').addEventListener('click', () => { closeModal(); resolve(false); });
            yes.addEventListener('click', async () => {
                await set({ [FREE_KEY]: { v: 1, at: Date.now() } });
                closeModal();
                resolve(true);
            });
        });
    }

    /* ---------------- 动作 ---------------- */
    async function doInstall(item) {
        if (!tierAllows(item)) { toast('先把右上角「允许安装」放开到 ' + TIER_LABEL[tierOf(item)]); return; }
        if (item.type === 'plugin') {
            const consent = (await get([CONSENT_KEY]))[CONSENT_KEY];
            if (!consent) {
                const ok = await confirmInstallDialog(item);
                if (!ok) return;
            }
        }
        toast('正在安装「' + item.name + '」…', 4000);
        const r = await sendCmd('install', { id: item.id, skipConfirm: true });
        if (!r || !r.ok) { toast(explainError(r), 6000); return; }
        await refreshState();
        render();
        openDetail(item.id);
        toast(item.type === 'theme' ? '已应用主题「' + item.name + '」' : '已安装「' + item.name + '」');
    }

    async function doUpdate(item) {
        toast('正在更新「' + item.name + '」…', 4000);
        const r = await sendCmd('update', { id: item.id });
        if (!r || !r.ok) { toast(explainError(r), 6000); return; }
        await refreshState();
        render();
        openDetail(item.id);
        toast('「' + item.name + '」已更新到 v' + item.version);
    }

    async function doUninstall(item) {
        const r = await sendCmd('uninstall', { id: item.id });
        if (!r || !r.ok) { toast(explainError(r), 6000); return; }
        await refreshState();
        render();
        closeDetail();
        toast('已卸载「' + item.name + '」');
    }

    /* ---------------- 事件 ---------------- */
    el.kw.addEventListener('input', () => { app.kw = el.kw.value; render(); });
    el.cols.addEventListener('change', () => { app.cols = parseInt(el.cols.value, 10) || 1; render(); });
    el.sync.addEventListener('click', async () => {
        toast('正在同步社区清单…', 2000);
        await loadAll(true);
        toast('同步完成 · 共 ' + app.catalog.length + ' 个条目');
    });
    el.tier.addEventListener('change', async () => {
        const want = el.tier.value;
        if (want === 'free') {
            const signed = (await get([FREE_KEY]))[FREE_KEY];
            if (!signed) {
                const ok = await freeDisclaimerDialog();
                if (!ok) { el.tier.value = app.tier; return; }
            }
        }
        app.tier = want;
        el.tier.classList.toggle('free', want === 'free');
        await set({ [TIER_KEY]: want });
        render();
        toast('允许安装已切到 ' + TIER_LABEL[want]);
    });

    document.querySelectorAll('.cat').forEach((node) => {
        node.addEventListener('click', () => {
            const cat = node.dataset.cat;
            if (cat === '__docs') { window.open(DOCS_URL, '_blank', 'noopener'); return; }
            if (cat === '__repo') { window.open(REPO_URL, '_blank', 'noopener'); return; }
            document.querySelectorAll('.cat').forEach((n) => n.classList.remove('active'));
            node.classList.add('active');
            app.cat = cat;
            render();
        });
    });

    el.list.addEventListener('click', (e) => {
        const card = e.target.closest('.card');
        if (card && card.dataset.id) openDetail(card.dataset.id);
    });
    el.mask.addEventListener('click', closeDetail);
    el.modalMask.addEventListener('click', (e) => { if (e.target === el.modalMask) closeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (el.modalMask.classList.contains('open')) closeModal();
        else if (el.drawer.classList.contains('open')) closeDetail();
    });
    el.openPanel.addEventListener('click', () => {
        chrome.tabs.query({ url: ['*://pickcat.dao3.fun/*'] }, (tabs) => {
            if (chrome.runtime.lastError || !tabs || !tabs.length) {
                toast('先打开 pickcat.dao3.fun 喵', 3000);
                return;
            }
            chrome.tabs.update(tabs[0].id, { active: true });
        });
    });

    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch[STATE_KEY] || ch[TIER_KEY]) { refreshState().then(() => { render(); if (app.openId) openDetail(app.openId); }); }
    });

    /* ---------------- 启动 ---------------- */
    (async function boot() {
        await refreshState();
        app.cols = 1;
        render();
        await loadAll(false);
    })();
})();
