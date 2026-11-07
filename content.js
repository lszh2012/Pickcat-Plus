// 控制台策略：默认只说一句话（版本号），排查问题请在设置面板里打开「开发者模式」。
let PICKCAT_DEV = false;
let devPushHook = null;   // 工坊模块挂上来之后，用它把开关同步进沙盒
let pickcatBannerDone = false;
function pickcatVersion() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
}
function dbg() {
    if (!PICKCAT_DEV) return;
    console.info.apply(console, arguments);
}
function pickcatBanner() {
    if (pickcatBannerDone) return;
    pickcatBannerDone = true;
    console.info('[PICKCAT Plus] v' + pickcatVersion() + (PICKCAT_DEV ? ' · 开发者模式已开启' : ''));
}

// ==========================================
// 模块 0：核心数据配置与通信
// ==========================================
let config = {
    hideCat: false,
    kitten4: false,
    categoryList: false,
    creationGrid: false,
    maskEnabled: false,
    bgUrl: '',
    bgBase64: '',
    cursorStyle: 'default',
    customCursor: ''
};

function safeGetURL(path) {
    try {
        if (chrome.runtime && chrome.runtime.id) return chrome.runtime.getURL(path);
    } catch (e) { return path; }
    return path;
}

// 读取页面“显式声明”的主题，返回 'dark' | 'light' | null（没声明）
function detectExplicitTheme() {
    const roots = [];
    if (document.documentElement) roots.push(document.documentElement);
    if (document.body && document.body !== document.documentElement) roots.push(document.body);

    for (let i = 0; i < roots.length; i++) {
        const el = roots[i];
        try {
            if (el.classList.contains('dark')) return 'dark';
            if (el.classList.contains('light')) return 'light';

            const theme = (el.getAttribute('data-theme') || '').trim().toLowerCase();
            if (theme === 'dark') return 'dark';
            if (theme === 'light') return 'light';

            const colorMode = (el.getAttribute('data-color-mode') || '').trim().toLowerCase();
            if (colorMode === 'dark') return 'dark';
            if (colorMode === 'light') return 'light';
        } catch (e) { /* 忽略单个节点异常 */ }
    }

    // 没有 class / attribute 时，看 CSS 的 color-scheme（Tailwind v4、原生 dark: 常用）
    if (roots[0]) {
        try {
            const scheme = String(getComputedStyle(roots[0]).colorScheme || '').toLowerCase();
            if (scheme.includes('dark') && !scheme.includes('light')) return 'dark';
            if (scheme.includes('light') && !scheme.includes('dark')) return 'light';
        } catch (e) { /* 忽略 */ }
    }

    return null;
}

function isDarkMode() {
    let explicit = null;
    try { explicit = detectExplicitTheme(); } catch (e) { explicit = null; }

    // ★ 网站自己声明了主题，就听网站的；不再让系统深色覆盖网站的亮色
    if (explicit === 'dark') return true;
    if (explicit === 'light') return false;

    // 网站完全没声明主题，才跟随系统
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
        return false;
    }
}

// ==========================================
// 模块 1：外观（背景、遮罩、指针）
// ==========================================
function injectCursorStyle(cursorStyle, customBase64) {
    let cursorStyleTag = document.getElementById('pickcat-cursor-style');
    if (!cursorStyle || cursorStyle === 'default') {
        if (cursorStyleTag) cursorStyleTag.remove();
        return;
    }
    if (!cursorStyleTag) {
        cursorStyleTag = document.createElement('style');
        cursorStyleTag.id = 'pickcat-cursor-style';
        document.head.appendChild(cursorStyleTag);
    }
    // custom 但没存自定义图时，直接当默认指针处理（否则会去请求不存在的 cursors/custom.png）
    if (cursorStyle === 'custom' && !customBase64) {
        if (cursorStyleTag) cursorStyleTag.remove();
        return;
    }
    let normal = cursorStyle === 'custom' ? customBase64 : safeGetURL(`cursors/${cursorStyle}.png`);
    cursorStyleTag.textContent = `
        html, body, div, span, p, h1, h2, h3, h4, h5, h6, li, ul, ol, table, tr, td, th, main, header, footer, section, article, textarea, input, a, button, [role="button"], select, option, summary, img, canvas, svg, video { cursor: url('${normal}'), auto !important; }
        a, a *, button, button *, [role="button"], .cursor-pointer, select, option, summary, [onclick], .btn { cursor: url('${normal}'), pointer !important; }
        input, textarea, [contenteditable="true"], p, span, .prose, .markdown-body { cursor: url('${normal}'), text !important; }
    `;
}

// ==========================================
// 自适应剥离站点「大背景层」
// 站点每次改版都会换容器类名（2026-10 的新版把背景画在
// div.flex.min-h-[var(--page-scroll-height,100dvh)]...bg-muted 上，
// 老的 body / #root / .min-h-dvh 全都不匹配了），所以不再靠写死选择器，
// 改成按「尺寸 + 实际计算出的背景」现场判定：占屏幕 ≥70% 宽、≥50% 高
// 且真的画了底色/背景图的元素才打标记，CSS 只对带标记的元素透明化。
// 标记是纯 attribute，随时可整批摘掉，不动任何 React 节点。
// ==========================================
const BG_STRIP_ATTR = 'data-pickcat-bg-strip';
let bgStripActive = false;
let bgStripObserver = null;
let bgStripTimer = 0;
// 两个来源都可能要求「把站点的大背景层扒掉」：
//   ① 用户自己设了背景图（bgHasCustom）
//   ② 当前主题自带整页背景（bgThemeStrip，主题清单里 pageBackground: true）
// 以前只有 ①，于是主题自己画背景时会被站点那层不透明的 bg-muted 挡住 —— 背景"没了"。
let bgHasCustom = false;
let bgThemeStrip = false;

function syncBgStrip() {
    if (bgHasCustom || bgThemeStrip) {
        if (!bgStripActive) startBgStrip();
        else scheduleBgStrip(0);
    } else {
        stopBgStrip();
    }
}

function ensureBgStripStyle() {
    let st = document.getElementById('pickcat-bg-strip-style');
    if (!st) {
        st = document.createElement('style');
        st.id = 'pickcat-bg-strip-style';
        // 只剥「底色 / 背景图」，绝不碰 backdrop-filter ——
        // 站点（以及 PickScribe 这类扩展）的弹窗毛玻璃就靠它，剥掉之后
        // 遮罩变透明，底下正文直接透上来，看着像「布局崩了」。
        st.textContent = `[${BG_STRIP_ATTR}="1"] { background-color: transparent !important; background-image: none !important; }`;
        (document.head || document.documentElement).appendChild(st);
    }
}

function contentRoot() {
    // 页面的「主内容」根节点。只沿着它的祖先链往上找背景层，
    // 因为背景层一定是包住内容的容器；而弹窗遮罩、第三方扩展的浮层
    // 都是内容的「兄弟」，从祖先链里根本走不到，天然不会误伤。
    return document.querySelector('main') ||
        document.querySelector('#__nuxt') ||
        document.querySelector('article') ||
        document.body;
}

function stripBigBackgrounds() {
    if (!bgStripActive || !document.body) return 0;
    let hits = 0;
    let node = contentRoot();
    while (node && node !== document.documentElement) {
        const parent = node.parentElement;
        if (!parent || parent === document.documentElement) break;
        // 自己的面板 / 提示层一律不碰
        if (parent.id === 'pickcat-settings-host' || parent.id === 'pickcat-ws-toast') {
            node = parent;
            continue;
        }
        const s = getComputedStyle(parent);
        const bgc = s.backgroundColor;
        const paints = (bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent')
            || (s.backgroundImage && s.backgroundImage !== 'none');
        // 带毛玻璃的层是遮罩而不是背景，绝不剥（弹窗的模糊全靠它）
        const bf = s.backdropFilter || s.webkitBackdropFilter;
        const isBlur = !!(bf && bf !== 'none');
        // fixed 定位的祖先一定是「盖在页面上的层」，不是背景 —— 弹窗变暗/模糊就靠它
        const isOverlay = s.position === 'fixed';
        // 半透明的底色 = 压暗用的遮罩，不是背景（站点会把 body 的底色临时改成半透明）
        let alpha = 1;
        const mA = /rgba?\(([^)]+)\)/.exec(bgc || '');
        if (mA) {
            const parts = mA[1].split(',');
            if (parts.length >= 4) alpha = parseFloat(parts[3]);
        }
        const isDim = bgc && bgc !== 'transparent' && bgc.indexOf('rgba(') === 0 && alpha < 0.9;
        if (paints && !isBlur && !isOverlay && !isDim) {
            if (parent.getAttribute(BG_STRIP_ATTR) !== '1') {
                parent.setAttribute(BG_STRIP_ATTR, '1');
                hits++;
            }
        }
        node = parent;
    }
    return hits;
}

function scheduleBgStrip(delay) {
    if (bgStripTimer) clearTimeout(bgStripTimer);
    bgStripTimer = setTimeout(() => {
        bgStripTimer = 0;
        try { stripBigBackgrounds(); } catch (e) { /* 布局未就绪时忽略 */ }
    }, typeof delay === 'number' ? delay : 600);
}

function stopBgStrip() {
    bgStripActive = false;
    if (bgStripTimer) { clearTimeout(bgStripTimer); bgStripTimer = 0; }
    if (bgStripObserver) {
        try { bgStripObserver.disconnect(); } catch (e) { /* ignore */ }
        bgStripObserver = null;
    }
    const marked = document.querySelectorAll('[' + BG_STRIP_ATTR + ']');
    for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(BG_STRIP_ATTR);
    const st = document.getElementById('pickcat-bg-strip-style');
    if (st) st.remove();
}

function startBgStrip() {
    ensureBgStripStyle();
    bgStripActive = true;
    // 站点是 SPA，首屏/hydrate/换页都可能晚一步才画出背景层，多打几枪
    [0, 400, 1200, 2600].forEach((d) => {
        setTimeout(() => { if (bgStripActive) { try { stripBigBackgrounds(); } catch (e) { /* ignore */ } } }, d);
    });
    if (!bgStripObserver && document.body) {
        bgStripObserver = new MutationObserver(() => {
            if (bgStripActive) scheduleBgStrip(600);
        });
        bgStripObserver.observe(document.body, { childList: true, subtree: true });
    }
}

function applyBackground(bgUrl, bgBase64, maskEnabled) {
    let finalUrl = bgBase64 ? bgBase64 : bgUrl;
    // 关键：只有真的设了自定义背景，才允许把站点的背景层扒掉。
    // 否则（没设背景时）连 .bg-canvas 这种装饰层一起被 background-image:none 干掉，
    // 会导致「隐藏大猫」开关怎么切都看不到猫。
    const hasBg = !!(finalUrl && String(finalUrl).trim().length >= 5);

    if (!hasBg) {
        document.documentElement.style.removeProperty('background-image');
        document.documentElement.style.removeProperty('background-size');
        document.documentElement.style.removeProperty('background-position');
        document.documentElement.style.removeProperty('background-attachment');
        document.documentElement.style.removeProperty('background-repeat');
    } else {
        // 主题包支持纯 CSS 渐变（不走图床，零请求、零字节）
        const isGradient = /^(repeating-)?(linear|radial|conic)-gradient\(/i.test(String(finalUrl).trim());
        let finalBgImage = isGradient ? String(finalUrl).trim() : `url('${finalUrl}')`;
        if (maskEnabled) {
            const isDark = isDarkMode();
            const maskColor = isDark ? 'rgba(15, 15, 15, 0.85)' : 'rgba(255, 255, 255, 0.85)';
            finalBgImage = `linear-gradient(${maskColor}, ${maskColor}), ${isGradient ? String(finalUrl).trim() : `url('${finalUrl}')`}`;
        }
        document.documentElement.style.setProperty('background-image', finalBgImage, 'important');
        document.documentElement.style.setProperty('background-size', 'cover', 'important');
        document.documentElement.style.setProperty('background-position', 'center', 'important');
        document.documentElement.style.setProperty('background-attachment', 'fixed', 'important');
        document.documentElement.style.setProperty('background-repeat', 'no-repeat', 'important');
    }
    let style = document.getElementById('pickcat-custom-theme-style');
    if (!style) {
        style = document.createElement('style');
        style.id = 'pickcat-custom-theme-style';
        document.head.appendChild(style);
    }
    style.textContent = `
        ${hasBg ? `body { background-color: transparent !important; background-image: none !important; }` : ''}
        .pickcat-grid-layout { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 12px !important; width: 100% !important; }
        .pickcat-category-listified { display: flex !important; flex-direction: column !important; gap: 12px !important; width: 100% !important; }
        [data-pickcat-hidden] { display: none !important; }
    `;

    // 站点的大背景层靠「现场判定」处理，别写死类名（站点一改版就失效）
    bgHasCustom = hasBg;
    syncBgStrip();
}

function applyHideCat(hide) {
    let style = document.getElementById('pickcat-hide-cat-style');
    if (hide) {
        if (!style) {
            style = document.createElement('style');
            style.id = 'pickcat-hide-cat-style';
            document.head.appendChild(style);
        }
        style.textContent = `
            img[src*="home-decoration"], img[src*="search-decoration"], img[src*="post-composer-decoration"] { display: none !important; }
            [style*="home-decoration"], [style*="search-decoration"] { background-image: none !important; }
        `;
    } else {
        if (style) style.remove();
    }
}

// ==========================================
// 模块 2：社区优化
// ==========================================
// ---- 创作栏快捷入口（Kitten3 / Kitten4 / BoxPlay / VOXA）----
// 做法统一：克隆站点现有的 KittenN 卡片，只换标题 / 图标 / 链接 / 简介，
// 原节点一根手指都不动，关掉开关就把克隆删掉，页面当场回到原样。
const KITTEN3_DESC = '和搭积木一样有趣的编程';
const CREATION_SHORTCUTS = [
    { id: 'pickcat-custom-kitten4', title: 'Kitten4', url: 'https://kitten4.codemao.cn/', icon: 'icons/kitten4.png', desc: '体验全新升级的源码编辑器' },
    { id: 'pickcat-custom-kitten3', title: 'Kitten3', url: 'https://kitten.codemao.cn/', icon: 'icons/kitten3.png', desc: KITTEN3_DESC },
    { id: 'pickcat-custom-boxplay', title: 'BoxPlay', url: 'https://boxplay.dao3.fun/', icon: 'icons/boxplay.png', desc: '把想象变成作品' },
    { id: 'pickcat-custom-voxa', title: 'VOXA', url: 'https://staging-local.dao3.fun/voxa/', icon: 'icons/dao3.png', desc: '岛3模型在线编辑器' }
];
const SHORTCUT_BY_TITLE = {};
CREATION_SHORTCUTS.forEach(sc => { SHORTCUT_BY_TITLE[sc.title] = sc; });

function injectCreationShortcuts() {
    // 开关关着：把已经插进去的克隆全撤掉（不等刷新）
    if (!config.kitten4) { removeCreationShortcuts(); return; }

    // 先修一遍历史遗留：老版本在搜索结果页上误把帖子链接当模板，
    // 克隆出来的入口长得跟帖子一样（文字是整句标题）。
    // 新克隆会打上 data-pickcat-sc 标记，没有标记的就是那批坏东西，直接删掉重建。
    document.querySelectorAll('a[id^="pickcat-custom-"]').forEach((el) => {
        if (el.getAttribute('data-pickcat-sc') !== el.id) el.remove();
    });

    // 找站点原生的 KittenN 卡片当模板。
    // 关键：必须是「创作栏里的编辑器入口」，不能是正文里提到 KittenN 的帖子
    // （搜索结果页上那种 a 的 textContent 里也有 KittenN，拿它当模板会把整页带歪）。
    const isEditorEntry = (link) => {
        if (CREATION_SHORTCUTS.some(sc => sc.id === link.id)) return false;
        const href = link.getAttribute('href') || '';
        if (!href) return false;
        if (href.indexOf('/forum') >= 0 || href.indexOf('/post') >= 0 ||
            href.indexOf('/search') >= 0 || href.indexOf('/profile') >= 0) return false;
        if (!(/codemao\.cn/i.test(href) || /dao3\.fun/i.test(href))) return false;
        // 原生入口没有 aria-label（只有主标题 "KittenN"），帖子链接的主标题则是一整句。
        const label = shortLabelOf(link);
        if (!label || label.length > 24) return false;
        return link.textContent.includes('KittenN');
    };

    let template = null;
    document.querySelectorAll('a').forEach(link => {
        if (template) return;
        if (isEditorEntry(link)) template = link;
    });
    if (!template) return;

    const parent = template.parentNode;
    if (!parent || !parent.isConnected) return;

    // 按顺序接在 KittenN 后面：Kitten4 → Kitten3 → BoxPlay → VOXA
    let anchor = template;
    CREATION_SHORTCUTS.forEach(sc => {
        let node = document.getElementById(sc.id);
        if (!node) {
            node = template.cloneNode(true);
            node.id = sc.id;
            node.href = sc.url;
            node.target = '_blank';
            // 标记「这是我做的入口」：下次进来靠它认出「历史遗留的坏克隆」。
            node.setAttribute('data-pickcat-sc', sc.id);
            node.setAttribute('aria-label', sc.title);
            const img = node.querySelector('img');
            if (img) {
                // 站点的图标是 <img srcset="/_ipx/s_28x28/… 1x, … 2x">。
                // 只改 src 的话浏览器仍会按 srcset 取图 —— 结果要么显示 KittenN 的图标，
                // 要么因为候选地址异常而整个空白（就是一个空的深色方块），所以先摘掉 srcset / sizes。
                img.removeAttribute('srcset');
                img.removeAttribute('sizes');
                img.removeAttribute('loading');
                img.src = safeGetURL(sc.icon);
                img.style.objectFit = 'contain';
                // 站点的 <span data-image-state> 只在图片加载完成后才恢复显示；克隆节点里这个状态
                // 是跟着原生节点一起复制过来的，可能停在占位态，这里直接标记为已加载。
                const shell = img.parentElement;
                if (shell && shell.hasAttribute('data-image-state')) shell.setAttribute('data-image-state', 'loaded');
            }
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let textNode;
            while ((textNode = walker.nextNode())) {
                if (textNode.nodeValue.includes('KittenN')) {
                    textNode.nodeValue = textNode.nodeValue.replace('KittenN', sc.title);
                    break;
                }
            }
            // 副标题那行小字换成自己的简介（原生文案是 KittenN 的「三端合一…」）
            node.querySelectorAll('span, div, p').forEach(el => {
                if (el.children.length === 0 && el.textContent.trim().startsWith('三端合一')) {
                    el.textContent = sc.desc;
                }
            });
            if (anchor.parentNode !== parent || !anchor.isConnected) anchor = template;
            parent.insertBefore(node, anchor.nextSibling);
        }
        anchor = node;
    });
}

function removeCreationShortcuts() {
    CREATION_SHORTCUTS.forEach(sc => {
        const node = document.getElementById(sc.id);
        if (node) node.remove();
    });
}

// 兼容旧调用名（别的地方还在用）
function injectKitten4() { injectCreationShortcuts(); }
function injectKitten3() { /* 已并入 injectCreationShortcuts */ }
function removeKitten4() { removeCreationShortcuts(); }
function removeKitten3() { /* 已并入 removeCreationShortcuts */ }

function processLinks() {
    const currentHost = window.location.hostname;
    document.querySelectorAll('a').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href.includes('/forum/category/')) return;
        if (!href.startsWith('#') && !href.includes(currentHost) && !href.startsWith('javascript:') && !href.startsWith('/')) {
            link.setAttribute('target', '_blank');
            if (!link.dataset.externalHooked) {
                link.dataset.externalHooked = 'true';
                link.addEventListener('click', function(e) {
                    if (e.button === 0) { e.preventDefault(); e.stopPropagation(); window.open(href, '_blank'); }
                });
            }
        }
    });
}

// ==========================================
// 模块 3：首页倒反天罡
// ==========================================
// ---- 倒反天罡：原节点保留在 DOM 里只是隐藏，另插一个克隆节点做新布局 ----
// 这样做的好处：开关从「开」拨回「关」时，删掉克隆节点 + 去掉隐藏标记就完事，
// 不用刷新页面，也不会破坏 React 管理的原节点。

const CLONE_FLAG = 'data-pickcat-clone';
const HIDDEN_FLAG = 'data-pickcat-hidden';

function revertByKind(kind, containerClass) {
    document.querySelectorAll(`[${CLONE_FLAG}="${kind}"]`).forEach(node => node.remove());
    document.querySelectorAll(`[${HIDDEN_FLAG}="${kind}"]`).forEach(node => node.removeAttribute(HIDDEN_FLAG));
    if (containerClass) {
        document.querySelectorAll('.' + containerClass).forEach(box => box.classList.remove(containerClass));
    }
}

function revertCreationCards() {
    revertByKind('creation', 'pickcat-grid-layout');
}

function revertCategoryList() {
    revertByKind('category', 'pickcat-category-listified');
}

// 一个元素「短名字」：优先第一段 span 的文字（创作入口的主标题就是它），
// 其次 aria-label，最后才是整段 textContent。
function shortLabelOf(el) {
    const span = el.querySelector('span');
    const fromSpan = span ? span.textContent.trim() : '';
    const fromAria = (el.getAttribute('aria-label') || '').trim();
    const fromAll = (el.textContent || '').trim();
    return fromSpan || fromAria || fromAll;
}

function isCreationLink(a) {
    // 「创作」区里那一列入口都是外链编辑器（codemao / dao3）
    // 或者我们注入的那几个 pickcat-custom-* 克隆。
    if (a.hasAttribute(CLONE_FLAG)) return false;
    if (a.id && a.id.indexOf('pickcat-custom-') === 0) return true;
    // 站点的创作入口只有一两个词的文字（KittenN / BOX 3 / CoCo编辑器…），
    // 而帖子标题动辄几十个字 —— 用长度就能把它们分开。
    // （注意：原生入口没有 aria-label，所以这里要看可见的主标题文字。）
    const label = shortLabelOf(a);
    if (!label || label.length > 24) return false;
    const href = a.getAttribute('href') || '';
    // 站内的帖子 / 搜索结果 / 作品详情一律不算 —— 这条排除掉的是
    // 「搜索结果里只要标题带 KittenN 就被当成编辑器入口」那种误伤。
    if (!href) return false;
    if (href.indexOf('/forum') >= 0 || href.indexOf('/post') >= 0 || href.indexOf('/search') >= 0) return false;
    if (href.indexOf('/profile') >= 0) return false;
    if (/codemao\.cn/i.test(href) || /dao3\.fun/i.test(href)) return true;
    return false;
}

function transformCreationCards() {
    if (!config.creationGrid) { revertCreationCards(); return; }

    // 先找「纯文字」的 创作 标题，再验它的下一个兄弟节点里有没有真正的编辑器入口。
    // 以前只取第一个 textContent === '创作' 的元素，搜索结果页上的某个外层容器
    // 也会满足这个条件，于是把整页结果当成创作列表重排了。
    const candidates = Array.from(document.querySelectorAll('h2, h3, div'))
        .filter((el) => el.textContent.trim() === '创作')
        .filter((el) => el.tagName !== 'DIV' || el.children.length === 0);

    let heading = null;
    let listContainer = null;
    for (let i = 0; i < candidates.length; i++) {
        const box = candidates[i].nextElementSibling;
        if (!box || box.tagName !== 'DIV') continue;
        const links = Array.from(box.querySelectorAll('a')).filter(isCreationLink);
        if (links.length === 0) continue;
        heading = candidates[i];
        listContainer = box;
        break;
    }
    if (!heading || !listContainer) { revertCreationCards(); return; }
    if (listContainer.classList.contains('pickcat-grid-layout')) return;

    const items = Array.from(listContainer.querySelectorAll('a')).filter(isCreationLink);
    if (items.length === 0) { revertCreationCards(); return; }

    listContainer.classList.add('pickcat-grid-layout');

    const sawShortcut = {};
    items.forEach(item => {
        const href = item.getAttribute('href');
        const titleText = item.querySelector('span.flex-1')?.textContent.trim() || item.textContent.trim();
        const imgSrc = item.querySelector('img')?.getAttribute('src');
        const sc = SHORTCUT_BY_TITLE[titleText];
        if (sc) sawShortcut[titleText] = true;

        let descText = '';
        if (sc) {
            descText = sc.desc;
        } else if (titleText.includes('Python') || titleText.includes('Py') || titleText.includes('海龟')) {
            descText = '学习python，如此简单';
        } else if (titleText.includes('KittenN') || titleText.includes('KN')) {
            descText = '三端合一的新一代编辑器';
        } else if (titleText.includes('CoCo')) {
            descText = '让世界没有难做的App';
        }

        const clone = document.createElement('a');
        clone.setAttribute(CLONE_FLAG, 'creation');
        clone.className = "overflow-visible flex aspect-square w-full min-w-0 flex-col rounded-lg p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 bg-(--ui-card-translucent) text-default hover:bg-(--ui-card-interactive)";
        if (href) clone.setAttribute('href', href);
        if (href && href.startsWith('http') && !href.includes(location.hostname)) {
            clone.setAttribute('target', '_blank');
        }
        if (titleText) clone.setAttribute('aria-label', titleText);

        let innerHtml = `
            <div data-slot="body" class="p-4 sm:p-6 min-w-0 contents">
                <span class="text-[15px] leading-[1.4] font-bold desktop:text-base">${titleText}</span>
                <span class="mt-1 text-[11px] leading-4 text-muted">${descText}</span>
        `;

        if (imgSrc) {
            let finalImgSrc = imgSrc;
            if (titleText === 'Kitten4') finalImgSrc = safeGetURL('icons/kitten4.png');
            if (titleText === 'Kitten3') finalImgSrc = safeGetURL('icons/kitten3.png');

            innerHtml += `
                <span class="inline-flex shrink-0 items-center justify-center rounded-md bg-info/10 text-info mt-auto size-9 self-end">
                    <img src="${finalImgSrc}" alt="" class="size-6 object-contain">
                </span>
            `;
        } else {
            innerHtml += `
                <span class="inline-flex shrink-0 items-center justify-center rounded-md bg-info/10 text-info mt-auto size-9 self-end">
                    <svg xmlns="http://www.w3.org/2000/svg" class="iconify iconify--mingcute" width="1em" height="1em" viewBox="0 0 24 24" style="font-size: 24px;"><path fill="none" stroke="currentColor" stroke-width="2" d="M21.526 6.5c.461.798-.064 2.054-1.74 3.656a8 8 0 0 1-13.274 7.665c-2.227.65-3.577.478-4.038-.32m0 0c.828 1.434 4.53.847 11.026-2.903s8.855-6.663 8.026-8.098c-.415-.72-1.744-.82-3.69-.325a.53.53 0 0 1-.484-.121a8 8 0 0 0-13.179 7.61a.53.53 0 0 1-.137.48C2.634 15.58 2.058 16.78 2.474 17.5Z"></path></svg>
                </span>
            `;
        }
        innerHtml += `</div>`;
        clone.innerHTML = innerHtml;

        const parent = item.parentNode;
        if (!parent) return;
        parent.insertBefore(clone, item.nextSibling);
        item.setAttribute(HIDDEN_FLAG, 'creation');
    });

    // 兜底：某个快捷入口没被收成卡（例如克隆节点晚于本次渲染才出现），
    // 就在网格里补一张同款卡，保证 K3/K4/BoxPlay/VOXA 一个都不缺。
    if (config.kitten4) {
        CREATION_SHORTCUTS.forEach((item) => {
            if (sawShortcut[item.title]) return;
            if (listContainer.querySelector('#' + item.id)) return;
            const card = document.createElement('a');
            card.setAttribute(CLONE_FLAG, 'creation');
            card.setAttribute('data-pickcat-shortcut', item.title);
            card.className = "overflow-visible flex aspect-square w-full min-w-0 flex-col rounded-lg p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 bg-(--ui-card-translucent) text-default hover:bg-(--ui-card-interactive)";
            card.setAttribute('href', item.url);
            card.setAttribute('target', '_blank');
            card.setAttribute('aria-label', item.title);
            card.innerHTML = `
            <div data-slot="body" class="p-4 sm:p-6 min-w-0 contents">
                <span class="text-[15px] leading-[1.4] font-bold desktop:text-base">${item.title}</span>
                <span class="mt-1 text-[11px] leading-4 text-muted">${item.desc}</span>
                <span class="inline-flex shrink-0 items-center justify-center rounded-md bg-info/10 text-info mt-auto size-9 self-end">
                    <img src="${safeGetURL(item.icon)}" alt="" class="size-6 object-contain">
                </span>
            </div>`;

            const anchor = listContainer.querySelector('[aria-label="Kitten4"]') ||
                           listContainer.querySelector('[aria-label="KittenN"]');
            if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor.nextSibling);
            else listContainer.appendChild(card);
        });
    }
}

function transformCategoriesToList() {
    if (!config.categoryList) { revertCategoryList(); return; }

    const firstCard = document.querySelector(`a[aria-label="创作与作品"]:not([${CLONE_FLAG}])`);
    if (!firstCard) return;

    const listContainer = firstCard.parentElement;
    if (!listContainer) return;
    if (listContainer.classList.contains('pickcat-category-listified')) return;

    const items = Array.from(listContainer.querySelectorAll('a')).filter(a => !a.hasAttribute(CLONE_FLAG));
    if (items.length === 0) return;

    listContainer.classList.add('pickcat-category-listified');

    items.forEach(item => {
        const titleText = item.querySelector('span.font-bold')?.textContent.trim() || item.getAttribute('aria-label') || '';
        const descText = item.querySelector('span.text-muted')?.textContent.trim() || '';
        const href = item.getAttribute('href');

        const iconSpan = item.querySelector('span.inline-flex');
        const iconSvg = iconSpan ? iconSpan.querySelector('svg') : null;
        const iconBgClass = iconSpan ? iconSpan.className : 'bg-info/10 text-info';

        const clone = document.createElement('a');
        clone.setAttribute(CLONE_FLAG, 'category');
        clone.className = "flex items-center gap-4 w-full rounded-lg p-3 bg-(--ui-card-translucent) text-default hover:bg-(--ui-card-interactive) transition-colors";
        if (href) clone.setAttribute('href', href);
        if (href && href.startsWith('http') && !href.includes(location.hostname)) {
            clone.setAttribute('target', '_blank');
        }
        if (titleText) clone.setAttribute('aria-label', titleText);

        let newHtml = '';
        if (iconSvg) {
            // 克隆一份再改，别动原节点
            const svgCopy = iconSvg.cloneNode(true);
            svgCopy.setAttribute('style', 'font-size: 26px;');
            newHtml += `<div class="flex items-center justify-center size-12 shrink-0 rounded-xl ${iconBgClass}">${svgCopy.outerHTML}</div>`;
        }

        newHtml += `<div class="flex flex-col text-left">
            <span class="text-[15px] font-bold">${titleText}</span>
            <span class="text-[12px] text-muted mt-0.5">${descText}</span>
        </div>`;

        newHtml += `<div class="ml-auto text-muted"><svg xmlns="http://www.w3.org/2000/svg" class="iconify iconify--mingcute" width="1em" height="1em" viewBox="0 0 24 24" style="font-size: 20px;"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.343 6.343L15 12l-5.657 5.657"></path></svg></div>`;

        clone.innerHTML = newHtml;

        const parent = item.parentNode;
        if (!parent) return;
        parent.insertBefore(clone, item.nextSibling);
        item.setAttribute(HIDDEN_FLAG, 'category');
    });
}

// ==========================================
// 模块 4：输入增强（加后缀）
// ==========================================
const SUFFIX_ENABLED_KEY = 'pickcat_enabled';
const SUFFIXES_KEY = 'pickcat_suffixes_v2';
const RANDOM_KEY = 'pickcat_random';
const MODE_KEY = 'pickcat_suffix_mode';
const TOAST_ENABLED_KEY = 'pickcat_toast_enabled';

let isSuffixEnabled = false; 
let isConfigLoaded = false;  
let isSuffixRandom = false;
let isToastEnabled = true; 
let suffixesList = [{ text: '喵', enabled: true }];
let currentMode = 'line'; 
let lastToastTime = 0; 

function showToast(text) {
    const now = Date.now();
    if (now - lastToastTime < 10000) return;
    lastToastTime = now;

    let toast = document.getElementById('pickcat-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'pickcat-toast';
        toast.style.cssText = `position: fixed; bottom: 30px; right: 30px; z-index: 999999; background: rgba(30, 30, 40, 0.85); color: #fff; padding: 12px 24px; border-radius: 12px; font-size: 14px; font-weight: bold; box-shadow: 0 8px 24px rgba(0,0,0,0.3); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.15); pointer-events: none; transition: opacity 0.3s ease, transform 0.3s ease; opacity: 0; transform: translateY(20px); font-family: system-ui, sans-serif;`;
        document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.offsetHeight; 
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    clearTimeout(toast.hideTimer);
    toast.hideTimer = setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(20px)'; }, 2500);
}

function initSuffixModule() {
    function loadConfig() {
        chrome.storage.local.get([SUFFIX_ENABLED_KEY, SUFFIXES_KEY, RANDOM_KEY, MODE_KEY, TOAST_ENABLED_KEY], (result) => {
            isSuffixEnabled = result[SUFFIX_ENABLED_KEY] === true;
            isSuffixRandom = result[RANDOM_KEY] === true;
            isToastEnabled = result[TOAST_ENABLED_KEY] === true;
            currentMode = result[MODE_KEY] || 'line';
            if (Array.isArray(result[SUFFIXES_KEY])) suffixesList = result[SUFFIXES_KEY];
            isConfigLoaded = true; 
        });
    }
    loadConfig();
    
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
            if (changes[SUFFIX_ENABLED_KEY]) isSuffixEnabled = changes[SUFFIX_ENABLED_KEY].newValue === true;
            if (changes[TOAST_ENABLED_KEY]) isToastEnabled = changes[TOAST_ENABLED_KEY].newValue === true;
            if (changes[SUFFIXES_KEY]) suffixesList = changes[SUFFIXES_KEY].newValue || [];
            if (changes[RANDOM_KEY]) isSuffixRandom = changes[RANDOM_KEY].newValue === true;
            if (changes[MODE_KEY]) currentMode = changes[MODE_KEY].newValue || 'line';
        }
    });

    function getActiveSuffixes() { return suffixesList.filter(s => s.enabled).map(s => s.text); }
    function getOneSuffix() {
        const active = getActiveSuffixes();
        if (active.length === 0) return '';
        return isSuffixRandom ? active[Math.floor(Math.random() * active.length)] : active[0];
    }
    function endsWithAnySuffix(text) { return getActiveSuffixes().some(s => text.endsWith(s)); }
    function setNativeValue(el, value) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    }
    function isSearchPage() { return location.pathname.startsWith('/search'); }
    function isSearchInput(el) {
        if (el.tagName !== 'INPUT') return false;
        if (el.type === 'search') return true;
        const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
        if (placeholder.includes('搜索') || placeholder.includes('search')) return true;
        let parent = el.parentElement;
        for (let i = 0; i < 3 && parent; i++) {
            if ((parent.id + ' ' + parent.className).toLowerCase().includes('search')) return true;
            parent = parent.parentElement;
        }
        return false;
    }
    function findEditable(node) {
        let n = node;
        while (n && n !== document.body) {
            if (n.nodeType === 1) {
                if (n.isContentEditable) return n;
                if (n.tagName === 'TEXTAREA') return n;
                if (n.tagName === 'INPUT' && /^(text|url|email)$/i.test(n.type)) {
                    if (isSearchInput(n)) return null;
                    return n;
                }
            }
            n = n.parentNode;
        }
        return null;
    }
    function processText(text) {
        if (!text) return text;
        const suffix = getOneSuffix();
        if (!suffix) return text;
        if (currentMode === 'sentence') {
            return text.replace(/([。！？；])/g, (match, p1, offset, string) => {
                const before = string.slice(0, offset);
                if (endsWithAnySuffix(before)) return match;
                return suffix + match;
            });
        } else {
            const lines = text.split('\n');
            return lines.map(line => {
                const trimmed = line.replace(/[\s\r]+$/, '');
                if (!trimmed || endsWithAnySuffix(trimmed)) return line;
                return trimmed + suffix + line.slice(trimmed.length);
            }).join('\n');
        }
    }
    function insertAtCursor(el) {
        if (currentMode === 'sentence') return;
        const suffix = getOneSuffix();
        if (!suffix) return;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const pos = el.selectionStart ?? el.value.length;
            const before = el.value.slice(0, pos);
            const currentLine = before.split('\n').pop() || '';
            const trimmed = currentLine.replace(/[\s\r]+$/, '');
            if (!trimmed || endsWithAnySuffix(trimmed)) return;
            setNativeValue(el, before + suffix + el.value.slice(pos));
            el.selectionStart = el.selectionEnd = pos + suffix.length;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.isContentEditable) {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            const container = range.startContainer;
            const before = container.nodeType === 3 ? container.textContent.slice(0, range.startOffset) : '';
            const trimmed = before.replace(/[\s\r]+$/, '');
            if (!trimmed || endsWithAnySuffix(trimmed)) return;
            const node = document.createTextNode(suffix);
            try { range.insertNode(node); } catch (e) { return; }
            range.setStartAfter(node);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: suffix }));
        }
    }
    function ensureAllText(el) {
        if (!el) return false;
        let changed = false;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const newText = processText(el.value);
            if (newText !== el.value) {
                setNativeValue(el, newText);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                changed = true;
            }
        } else if (el.isContentEditable) {
            const newText = processText(el.innerText);
            if (newText !== el.innerText) {
                el.innerText = newText;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '' }));
                changed = true;
            }
        }
        return changed;
    }
    function doScanAndToast() {
        const activeEditors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(el => el.offsetHeight > 0 && el.offsetWidth > 0);
        let changed = false;
        activeEditors.forEach(el => { if (ensureAllText(el)) changed = true; });
        if (location.pathname.startsWith('/forum/editor')) {
            document.querySelectorAll('input[type="text"]').forEach(el => {
                if (!isSearchInput(el) && el.offsetHeight > 0 && el.offsetWidth > 0) {
                    if (ensureAllText(el)) changed = true;
                }
            });
        }
        if (isToastEnabled) showToast('✅ 已全局扫描，自动加喵成功！');
    }
    document.addEventListener('keydown', (e) => {
        if (!isConfigLoaded || !isSuffixEnabled || e.key !== 'Enter' || e.shiftKey || isSearchPage()) return;
        const el = findEditable(e.target);
        if (el) insertAtCursor(el);
    }, true);
    document.addEventListener('blur', (e) => {
        if (!isConfigLoaded || !isSuffixEnabled || isSearchPage()) return;
        const el = findEditable(e.target);
        if (el) ensureAllText(el);
    }, true);
    document.addEventListener('click', (e) => {
        if (!isConfigLoaded || !isSuffixEnabled || isSearchPage()) return;
        let isPublishBtn = false;
        const btn = e.target.closest('button, [type="submit"], [role="button"]');
        if (btn) {
            const btnText = (btn.textContent || '').trim();
            if (/(发布|发送|回复|发表|提交)/.test(btnText) && btnText.length <= 10) isPublishBtn = true;
        }
        const isEditorPage = location.pathname.includes('/editor') || document.querySelector('textarea:focus, [contenteditable="true"]:focus');
        const isInteractive = e.target.closest('button, a, input, textarea, [contenteditable="true"], [role="button"]');
        if (isPublishBtn || (isEditorPage && !isInteractive)) doScanAndToast();
    }, true);
}

// ==========================================
// 模块 5：沉浸式内嵌设置面板 (Shadow DOM)
// ==========================================
let shadowRootInstance = null; 
let panelRefreshHook = null;   // 设置面板的刷新函数（工坊安装/卸载插件后要重绘锁定状态）

// ==========================================
// 模块 5.5：插件设置租约（claims）
// ------------------------------------------------------------
// 设计原则：**永不改写用户自己的 storage 值**。
// 插件要接管某几项设置时，只往 pickcat_ws_claims 里登记一条租约，
// 读取配置时在内存里按「后装的优先」覆盖。卸载 = 撕掉租约，用户原值天然还在。
// 这样即使浏览器崩溃、扩展被重装，用户的设置也不会丢。
// ==========================================
const CLAIMS_KEY = 'pickcat_ws_claims';
const CLAIM_MAX = 5;          // 单个插件最多接管几项
const CLAIM_MAX_PER_KEY = 3;  // 同一个设置项最多被几个插件争抢
// 允许被接管的键 + 值类型（类型不对直接拒绝，防止往 storage 里塞奇怪的东西）
const CLAIM_KEY_TYPES = {
    pickcatBgUrl: 'text',
    pickcatBgBase64: 'text',
    pickcatMaskEnabled: 'bool',
    pickcatCursor: 'cursor',
    pickcatCustomCursor: 'text',
    pickcatHideCat: 'bool',
    pickcatKitten4: 'bool',
    pickcatCategoryList: 'bool',
    pickcatCreationGrid: 'bool'
};
const CURSOR_ENUM = ['default', 'style1', 'style2', 'style3', 'style6', 'custom'];

// 官方放在社区清单里的示例条目：这几个 id 允许保留「官方」标识（写死在这里，社区无法冒充）
const TRUSTED_COMMUNITY_IDS = ['theme-neon'];

// 当前主题皮肤声称适配的配色（用于「用户切到不匹配的模式时提示一次」）
let activeThemeMode = 'any';
let activeThemeName = '';
let themeModeWarned = false;

function checkThemeModeHint() {
    if (activeThemeMode === 'any' || themeModeWarned) return;
    const cur = isDarkMode() ? 'dark' : 'light';
    if (cur === activeThemeMode) return;
    themeModeWarned = true;
    try {
        Workshop.toast((activeThemeMode === 'dark' ? '🌙' : '☀️') + '「' + activeThemeName + '」在' +
            (activeThemeMode === 'dark' ? '深色' : '浅色') + '模式下效果更好', 4200);
    } catch (e) { /* 工坊还没挂载，忽略 */ }
    setTimeout(() => { themeModeWarned = false; }, 30000);   // 30 秒内不重复打扰
}

// 校验一条 claim 的值是否符合类型；不合规返回 undefined
function claimValueOk(key, value) {
    const t = CLAIM_KEY_TYPES[key];
    if (!t) return undefined;
    if (t === 'bool') return (value === true || value === false) ? value : undefined;
    if (t === 'cursor') return (typeof value === 'string' && CURSOR_ENUM.indexOf(value) >= 0) ? value : undefined;
    if (t === 'text') {
        if (typeof value !== 'string' || value.length > 200000) return undefined;
        return value;
    }
    return undefined;
}

// 从 storage 里的 claims 对象取某项的生效值（后装的优先）
function claimedValue(claims, key, fallback) {
    const arr = claims && claims[key];
    if (!Array.isArray(arr) || !arr.length) return fallback;
    const v = arr[arr.length - 1];
    return (v && typeof v === 'object' && 'value' in v) ? v.value : fallback;
}

// 撕掉一条租约（删掉某个插件对某个键的接管），然后立刻重新应用配置
function releaseClaim(key, id, done) {
    chrome.storage.local.get([CLAIMS_KEY], (res) => {
        const claims = (res[CLAIMS_KEY] && typeof res[CLAIMS_KEY] === 'object') ? res[CLAIMS_KEY] : {};
        if (Array.isArray(claims[key])) {
            claims[key] = claims[key].filter((x) => !(x && x.id === id));
            if (!claims[key].length) delete claims[key];
        }
        chrome.storage.local.set({ [CLAIMS_KEY]: claims }, () => {
            loadAllConfigs();
            if (panelRefreshHook) { try { panelRefreshHook(); } catch (e) { /* ignore */ } }
            if (done) done();
        });
    });
}

function createSettingsPanel() {
    if (document.getElementById('pickcat-settings-host')) return;

    const host = document.createElement('div');
    host.id = 'pickcat-settings-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadowRootInstance = shadow;

    shadow.innerHTML = `
        <style>
            :host {
                all: initial;
                /* 和站点同一套 token：中性灰阶 + brand-500 红，见 pickcat.dao3.fun 的 --ui-* */
                --primary: #fa322d;
                --primary-weak: rgba(250, 50, 45, 0.12);
                --bg-glass: rgba(255, 255, 255, 0.96);
                --bg-card: #f4f4f4;
                --bg-sunken: #fafafa;
                --text-main: #1a1a1a;
                --text-muted: #8a8a8a;
                --border: #e6e6e6;
                --switch-bg: #d4d4d4;
                --radius: 8px;
                --radius-ctl: 6px;
                --panel-width: min(520px, 96vw);
                --scroll-thumb: rgba(0, 0, 0, 0.16);
                --scroll-thumb-hover: rgba(0, 0, 0, 0.32);
                font-family: system-ui, -apple-system, sans-serif;
            }
            :host(.pickcat-dark) {
                --bg-glass: rgba(26, 26, 26, 0.96);
                --bg-card: #2b2b2b;
                --bg-sunken: #1f1f1f;
                --text-main: #ebebeb;
                --text-muted: #8a8a8a;
                --border: #2b2b2b;
                --switch-bg: #4a4a4a;
                --scroll-thumb: rgba(255, 255, 255, 0.14);
                --scroll-thumb-hover: rgba(255, 255, 255, 0.30);
            }

            * { box-sizing: border-box; }

            /* ★ 可拖动悬浮球：整块 50×50 就是抓手，位置由 JS 写 left/top */
            #hover-zone {
                position: fixed; top: 50%; right: 8px; left: auto;
                width: 50px; height: 50px;
                transform: translateY(-50%);
                z-index: 2147483001;
                display: flex; align-items: center; justify-content: center;
                touch-action: none; user-select: none; -webkit-user-select: none;
            }

            #floating-ball {
                width: 50px; height: 50px; border-radius: 50%;
                background: var(--bg-glass); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.15); border: 1px solid var(--border);
                display: flex; align-items: center; justify-content: center;
                cursor: grab;
                transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s;
                opacity: 0.55;
            }
            #floating-ball svg { width: 28px; height: 28px; fill: var(--text-main); transition: transform 0.5s; pointer-events: none; }

            /* 悬停：浮起来一点，明确"能抓" */
            #hover-zone:hover #floating-ball { opacity: 1; transform: scale(1.06); }
            #hover-zone:hover #floating-ball svg { transform: rotate(15deg) scale(1.1); }
            /* 拖动中：关掉过渡才能跟手 */
            #hover-zone.dragging { cursor: grabbing; }
            #hover-zone.dragging #floating-ball {
                transition: none; opacity: 1; transform: scale(1.02);
                box-shadow: 0 10px 26px rgba(0,0,0,0.28); cursor: grabbing;
            }

            #settings-panel {
                position: fixed; top: 0; right: calc(var(--panel-width) * -1); 
                width: var(--panel-width); height: 100vh;
                background: var(--bg-glass); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
                box-shadow: -10px 0 30px rgba(0,0,0,0.1); border-left: 1px solid var(--border);
                z-index: 2147483002; display: flex; flex-direction: column;
                transition: right 0.4s cubic-bezier(0.4, 0, 0.2, 1), left 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                overflow: hidden;
            }
            #settings-panel.open { right: 0; }

            /* 球被拖到屏幕左半边时，面板改成从左滑出 */
            #settings-panel.panel-left {
                right: auto; left: calc(var(--panel-width) * -1);
                border-left: none; border-right: 1px solid var(--border);
                box-shadow: 10px 0 30px rgba(0,0,0,0.1);
            }
            #settings-panel.panel-left.open { left: 0; right: auto; }

            .panel-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 20px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0;
            }
            .panel-header h2 { margin: 0; font-size: 20px; font-weight: bold; color: var(--text-main); }
            .close-btn {
                background: transparent; border: none; cursor: pointer; padding: 6px;
                border-radius: 50%; display: flex; transition: background 0.2s;
            }
            .close-btn:hover { background: var(--bg-card); }
            .close-btn svg { width: 24px; height: 24px; fill: var(--text-main); }

            .panel-body { display: flex; flex: 1; overflow: hidden; }
            
            /* 侧栏：常驻只占 72px，展开时「浮」在内容上方 ——
               以前展开会真的把宽度撑到 180px，正文被挤窄、文字当场重排，很晃。 */
            .nav-sidebar {
                width: 72px; flex: 0 0 72px; position: relative;
                border-right: 1px solid var(--border);
            }
            .nav-inner {
                position: absolute; top: 0; left: 0; bottom: 0; width: 72px; z-index: 8;
                display: flex; flex-direction: column; align-items: flex-start;
                padding: 16px 12px; gap: 12px; overflow: hidden; white-space: nowrap;
                background: transparent; border-radius: 0 14px 14px 0;
                transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1), background 0.25s, box-shadow 0.25s;
            }
            .nav-inner:hover {
                width: 172px;
                background: var(--bg-card);
                box-shadow: 12px 0 28px rgba(0, 0, 0, 0.22);
            }

            .nav-item {
                display: flex; align-items: center; height: 48px; width: 48px;
                border-radius: 12px; cursor: pointer; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                color: var(--text-main); overflow: hidden;
            }
            .nav-inner:hover .nav-item { width: 100%; }
            .nav-item svg { width: 24px; height: 24px; fill: currentColor; flex-shrink: 0; margin-left: 12px; }
            .nav-item .nav-text {
                margin-left: 12px; font-size: 14px; font-weight: 500;
                opacity: 0; transition: opacity 0.2s 0.1s;
            }
            .nav-inner:hover .nav-text { opacity: 1; }
            .nav-item:hover { background: var(--bg-card); }
            .nav-item.active {
                background: var(--bg-card);
                color: var(--text-main);
                box-shadow: inset 2px 0 0 var(--primary);
                border-radius: 0 var(--radius-ctl) var(--radius-ctl) 0;
            }
            .nav-item.active svg { color: var(--primary); }
            .nav-item.active .nav-text { color: var(--primary); }

            .content-area { flex: 1; min-width: 0; padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 24px; }
            @media (max-width: 720px) {
                .content-area { padding: 16px 14px; gap: 16px; }
                .row-card { padding: 12px 14px; }
                .about-logo img { max-width: 200px; }
            }
            .nav-item .nav-fig {
            width: 24px; height: 24px; margin-left: 12px; flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
            font-size: 18px; line-height: 1;
        }
        .nav-item .nav-fig img { width: 22px; height: 22px; border-radius: 5px; object-fit: cover; display: block; }

        .plug-head { display: flex; align-items: center; gap: 10px; }
        .plug-head .plug-name { font-size: 15px; font-weight: 600; color: var(--text-main); }
        .plug-head .plug-meta { font-size: 12px; color: var(--text-muted); }
        .plug-note { margin: 0; font-size: 12px; color: var(--text-muted); line-height: 1.6; }
        .plug-form { display: flex; flex-direction: column; gap: 10px; }
        .plug-form label { font-size: 12px; color: var(--text-muted); }
        .plug-form input, .plug-form select {
            padding: 8px 10px; font-size: 13px; border-radius: var(--radius-ctl);
            border: 1px solid var(--border); background: var(--bg-sunken); color: var(--text-main);
        }
        .plug-form .plug-switch { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-main); cursor: pointer; }
        .plug-form .plug-switch input { width: 15px; height: 15px; margin: 0; accent-color: var(--primary); }
        .plug-form .plug-hint { font-size: 11px; color: var(--text-muted); line-height: 1.55; margin-top: -4px; }
        .plug-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
        .tab-content { display: none; flex-direction: column; gap: 12px; }
            .tab-content.active { display: flex; }

            /* ★ 面板滚动条：细、圆角、不抢视线，hover 时才变亮（替代系统原生滚动条）
               注意：Chrome 里一旦写了 scrollbar-width / scrollbar-color（标准属性），
               ::-webkit-scrollbar 的定制就会被忽略，所以这里只能用 webkit 伪元素。 */
            .content-area, .ws-modal-card {
                scrollbar-gutter: stable;
                overscroll-behavior: contain;
            }
            .content-area::-webkit-scrollbar,
            .ws-modal-card::-webkit-scrollbar { width: 10px; height: 10px; }
            .content-area::-webkit-scrollbar-track,
            .ws-modal-card::-webkit-scrollbar-track { background: transparent; }
            .content-area::-webkit-scrollbar-thumb,
            .ws-modal-card::-webkit-scrollbar-thumb {
                background-color: var(--scroll-thumb);
                border-radius: 999px;
                border: 3px solid transparent;
                background-clip: content-box;
                transition: background-color 0.18s ease;
            }
            .content-area:hover::-webkit-scrollbar-thumb,
            .ws-modal-card:hover::-webkit-scrollbar-thumb {
                background-color: var(--scroll-thumb-hover);
                background-clip: content-box;
            }
            .content-area::-webkit-scrollbar-thumb:active,
            .ws-modal-card::-webkit-scrollbar-thumb:active {
                background-color: var(--primary);
                background-clip: content-box;
            }
            .content-area::-webkit-scrollbar-corner,
            .ws-modal-card::-webkit-scrollbar-corner { background: transparent; }

            /* ★ 被插件接管的设置项标签 */
            .ws-lock-tag {
                display: inline-flex; align-items: center; gap: 4px;
                margin-top: 6px; padding: 3px 8px; border-radius: 999px;
                font-size: 11px; line-height: 1.4; cursor: pointer; user-select: none;
                color: #92400e; background: rgba(251, 191, 36, 0.18);
                border: 1px solid rgba(251, 191, 36, 0.45); white-space: nowrap;
            }
            .ws-lock-tag:hover { background: rgba(251, 191, 36, 0.3); }
            :host(.pickcat-dark) .ws-lock-tag {
                color: #fcd34d; background: rgba(251, 191, 36, 0.14);
                border-color: rgba(251, 191, 36, 0.35);
            }
            .section-title { font-size: 14px; font-weight: bold; color: var(--text-main); margin-bottom: 4px; }

            .row-card {
                background: var(--bg-card); border: 1px solid var(--border);
                border-radius: 12px; padding: 16px; display: flex; justify-content: space-between; align-items: center;
            }
            .row-info { display: flex; flex-direction: column; gap: 4px; }
            .row-title { font-size: 14px; font-weight: 600; color: var(--text-main); }
            .row-desc { font-size: 12px; color: var(--text-muted); }
            /* 第三方来源署名：比说明字更轻，但要让「谁做的」看得见 */
            .row-credit { font-size: 11px; color: var(--text-muted); opacity: .8; margin-top: 3px; line-height: 1.5; }
            .row-credit a { color: var(--primary); text-decoration: none; }
            .row-credit a:hover { text-decoration: underline; }
            .row-credit b { font-weight: 600; }
            /* 关于页：LOGO + 贡献者 */
            .about-logo { display: flex; justify-content: center; align-items: center; padding: 4px 0 16px; }
            .about-logo img { width: 100%; max-width: 260px; height: auto; display: none; }
            .about-logo .logo-light { display: block; }
            :host(.pickcat-dark) .about-logo .logo-light { display: none; }
            :host(.pickcat-dark) .about-logo .logo-dark { display: block; }
            .about-contrib { flex-direction: column; align-items: flex-start; gap: 8px; }
            .about-contrib-title { margin: 0; color: var(--text-main); font-size: 14px; }
            .about-contrib-sub { margin: 0; font-size: 12px; color: var(--text-muted); }
            .about-contrib-list { list-style: none; margin: 6px 0 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 10px; }
            .about-contrib-list li { font-size: 12.5px; color: var(--text-main); line-height: 1.5; }
            .about-contrib-list li span { display: block; margin-top: 3px; font-size: 12px; color: var(--text-muted); line-height: 1.6; }
            .about-contrib-foot { margin: 4px 0 0; font-size: 11.5px; color: var(--text-muted); }

        .link-card { flex-direction: column; align-items: flex-start; gap: 8px; }
        .link-card .link-title { margin: 0; color: var(--text-main); font-size: 14px; }
        .link-card .link-status { margin: 0; font-size: 12.5px; color: var(--text-muted); line-height: 1.55; }
        .link-card .link-status.on { color: var(--primary); }
        .link-card .link-btn {
            padding: 8px 14px; border-radius: var(--radius-ctl); cursor: pointer; font: inherit;
            font-size: 12.5px; background: var(--bg-sunken); color: var(--text-main);
            border: 1px solid var(--border);
        }
        .link-card .link-btn:hover { border-color: var(--primary); color: var(--primary); }
            .about-link { color: var(--primary); text-decoration: none; }
            .about-link:hover { text-decoration: underline; }
            /* 关于页：检查更新 */
            .dev-row {
                width: 100%; display: flex; align-items: center; gap: 12px;
                padding: 10px 12px; background: var(--bg-sunken);
                border: 1px solid var(--border); border-radius: var(--radius-ctl);
            }
            .dev-row-info { flex: 1; min-width: 0; }
            .dev-row-title { font-size: 13px; color: var(--text-main); }
            .dev-row-desc { font-size: 11.5px; color: var(--text-dimmed); margin-top: 2px; }
            .update-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: -2px 0 2px; }
            .update-status { font-size: 12px; color: var(--text-muted); }
            .update-status.new { color: var(--primary); font-weight: 600; }
            .update-status.err { color: #b45309; }
            .update-btn {
                padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer;
                color: var(--text-main); background: transparent;
                border: 1px solid var(--border); border-radius: 999px;
                transition: background .2s, border-color .2s;
            }
            .update-btn:hover { background: var(--bg-card); border-color: var(--primary); }
            .update-btn:disabled { opacity: .55; cursor: default; }
            .update-btn.primary { color: #fff; background: var(--primary); border-color: var(--primary); }

            .toggle-switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; }
            .toggle-switch input { opacity: 0; width: 0; height: 0; }
            .toggle-slider {
                position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
                background-color: var(--switch-bg); transition: .3s; border-radius: 24px;
            }
            .toggle-slider:before {
                position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px;
                background-color: white; transition: .3s; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            }
            input:checked + .toggle-slider { background-color: var(--primary); }
            input:checked + .toggle-slider:before { transform: translateX(20px); }

            .input-group { display: flex; gap: 8px; width: 100%; margin-top: 8px; }
            .input-group input {
                flex: 1; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px;
                background: var(--bg-card); color: var(--text-main); font-size: 13px; outline: none;
            }
            .input-group button {
                padding: 8px 16px; background: var(--primary); color: white; border: none;
                border-radius: 8px; cursor: pointer; font-weight: bold;
            }

            .btn-secondary, .btn-danger {
                flex: 1; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 13px;
                transition: all 0.2s; text-align: center;
            }
            .btn-secondary { background: rgba(16, 185, 129, 0.1); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
            .btn-secondary:hover { background: rgba(16, 185, 129, 0.2); }
            .btn-danger { background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); }
            .btn-danger:hover { background: rgba(239, 68, 68, 0.2); }

            .cursor-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
            .cursor-item {
                padding: 10px; background: var(--bg-card); border: 1px solid var(--border);
                border-radius: 8px; text-align: center; font-size: 13px; color: var(--text-main); cursor: pointer;
            }
            .cursor-item.active { border-color: var(--primary); background: rgba(79,70,229,0.1); color: var(--primary); font-weight: bold; }

            .suffix-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
            .suffix-item { display: flex; justify-content: space-between; padding: 8px; background: var(--bg-card); border-radius: 8px; color: var(--text-main); }
            
            .disabled-area { opacity: 0.4; pointer-events: none; filter: grayscale(1); transition: all 0.3s ease; }
            input[type="file"] { display: none; }

            /* ---------- 创意工坊 ---------- */
            .ws-top { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
            .ws-search { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-main); font-size: 13px; outline: none; }
            .ws-search:focus { border-color: var(--primary); }
            .ws-status { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-muted); margin-bottom: 10px; gap: 8px; }
            .ws-safemode { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
            .ws-safemode input { accent-color: #ef4444; }
            .ws-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
            .ws-tier { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-muted); margin: -2px 0 10px; }
            .ws-tier select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-main); font-size: 12px; }
            .ws-tier select.free-on { border-color: #ef4444; color: #ef4444; font-weight: 700; }
            .ws-tier-hint { font-size: 11px; opacity: .85; }
            .ws-badge.tier-free { background: rgba(239,68,68,.16); color: #ef4444; }
            .ws-chip { padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-muted); font-size: 12px; cursor: pointer; }
            .ws-chip.active { border-color: var(--primary); color: var(--primary); background: rgba(79,70,229,0.12); font-weight: 600; }
            .ws-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
            .ws-card { border: 1px solid var(--border); background: var(--bg-card); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
            .ws-card-revoked { opacity: .6; border-style: dashed; }
            .ws-card-revoked .ws-name { text-decoration: line-through; }
            .ws-card-head { display: flex; align-items: center; gap: 6px; }
            .ws-emoji { font-size: 16px; line-height: 1; }
        .ws-ico { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; }
        .ws-ico img { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; display: block; }
            .ws-name { font-size: 13px; font-weight: 600; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
            .ws-badge { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(34,197,94,0.15); color: #16a34a; white-space: nowrap; }
            .ws-badge.warn { background: rgba(245,158,11,0.15); color: #d97706; }
            .ws-preview { height: 32px; border-radius: 7px; border: 1px solid var(--border); }
            .ws-desc { font-size: 11.5px; line-height: 1.5; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
            .ws-author { font-size: 10.5px; color: var(--text-muted); opacity: .85; margin: -3px 0 7px 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ws-tags { display: flex; gap: 4px; flex-wrap: wrap; }
            .ws-tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(99,102,241,0.12); color: var(--primary); }
            .ws-tag.danger { background: rgba(239,68,68,0.12); color: #ef4444; }
            .ws-tag.claim { background: rgba(245,158,11,0.16); color: #b45309; }
            .ws-tag.warn { background: rgba(239,68,68,0.12); color: #ef4444; }
            :host(.pickcat-dark) .ws-tag.claim { background: rgba(245,158,11,0.16); color: #fbbf24; }
            :host(.pickcat-dark) .ws-tag.warn { background: rgba(239,68,68,0.18); color: #fca5a5; }
            .ws-actions { display: flex; gap: 6px; margin-top: 2px; }
            .ws-btn { flex: 1; padding: 6px 8px; font-size: 12px; border-radius: 7px; border: 1px solid var(--border); background: transparent; color: var(--text-main); cursor: pointer; transition: 0.2s; }
            .ws-btn:hover { border-color: var(--primary); color: var(--primary); }
            .ws-btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
            .ws-btn.primary:hover { opacity: 0.88; color: #fff; }
            .ws-btn.danger { background: #ef4444; border-color: #ef4444; color: #fff; }
            .ws-installed-head { margin-bottom: 12px; }
            .ws-installed-tip {
                margin-top: 8px; font-size: 12px; line-height: 1.6; color: var(--text-muted);
            }

            .ws-empty { grid-column: 1 / -1; text-align: center; color: var(--text-muted); font-size: 12.5px; padding: 26px 8px; line-height: 1.8; }
            .ws-settings { display: none; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px dashed var(--border); margin-top: 2px; }
            .ws-settings.open { display: flex; }
            .ws-settings label { font-size: 11px; color: var(--text-muted); }
            .ws-settings input { padding: 6px 8px; font-size: 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-glass); color: var(--text-main); outline: none; }
            .ws-settings select { padding: 6px 8px; font-size: 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-glass); color: var(--text-main); outline: none; cursor: pointer; }
            .ws-settings .ws-switch-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-main); cursor: pointer; padding: 2px 0; }
            .ws-settings .ws-switch-row input[type="checkbox"] { width: 15px; height: 15px; margin: 0; padding: 0; cursor: pointer; accent-color: var(--primary); }
            .ws-settings .ws-hint { font-size: 10.5px; color: var(--text-muted); line-height: 1.5; }
            .ws-modal { position: fixed; inset: 0; z-index: 2147483003; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); }
            .ws-modal.open { display: flex; }
            .ws-modal-card { width: min(400px, 86vw); max-height: 78vh; overflow: auto; background: var(--bg-glass); border: 1px solid var(--border); border-radius: 14px; padding: 18px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
            .ws-modal-title { font-size: 15px; font-weight: 700; color: var(--text-main); margin: 0 0 6px; }
            .ws-modal-sub { font-size: 12px; color: var(--text-muted); margin: 0 0 12px; line-height: 1.6; }
            .ws-perm { display: flex; gap: 8px; font-size: 12px; padding: 7px 8px; border-radius: 8px; background: rgba(0,0,0,0.04); margin-bottom: 6px; color: var(--text-main); align-items: flex-start; }
            .ws-perm.high { background: rgba(239,68,68,0.1); }
            .ws-perm.claim { background: rgba(245,158,11,0.14); }
            .ws-perm-txt { flex: 1; line-height: 1.5; }
            .ws-modal-foot { display: flex; gap: 8px; margin-top: 14px; }
            .ws-consent-check { display: flex; gap: 9px; align-items: flex-start; margin-top: 14px; padding: 11px 12px; border-radius: 10px; background: var(--switch-bg); cursor: pointer; font-size: 12.5px; line-height: 1.55; color: var(--text-main); }
            .ws-consent-check input { margin: 2px 0 0; width: 15px; height: 15px; flex-shrink: 0; cursor: pointer; accent-color: var(--primary); }
            .ws-note { margin: 4px 0 0; }
            .ws-note p { margin: 0 0 9px; font-size: 12.5px; line-height: 1.65; color: var(--text-main); }
            .ws-note p:last-child { margin-bottom: 0; }
            .ws-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
            .ws-btn[disabled]:hover { background: var(--primary); }
        </style>

        <div id="hover-zone">
            <div id="floating-ball">
                <svg viewBox="0 0 24 24"><path d="M12 21c-4.5 0-8.5-3-8.5-7.5 0-2.5 1.5-4.5 3-5.5-.5-1-1-2.5-1-4 0-.5.5-1 1-1 1.5 0 3 1.5 3.5 2.5 1-.3 2-.5 3-.5s2 .2 3 .5c.5-1 2-2.5 3.5-2.5.5 0 1 .5 1 1 0 1.5-.5 3-1 4 1.5 1 3 3 3 5.5 0 4.5-4 7.5-8.5 7.5zM8.5 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/><path d="M19 2l.5 1.5h1.5l-1.2 1 .4 1.5-1.2-1-1.2 1 .4-1.5-1.2-1h1.5z"/></svg>
            </div>
        </div>

        <div id="settings-panel">
            <div class="panel-header">
                <h2>PICKCAT Plus 设置</h2>
                <button class="close-btn" id="close-panel">
                    <svg viewBox="0 0 24 24"><path d="M6.225 4.811a1 1 0 0 0-1.414 1.414L10.586 12l-5.775 5.775a1 1 0 1 0 1.414 1.414L12 13.414l5.775 5.775a1 1 0 0 0 1.414-1.414L13.414 12l5.775-5.775a1 1 0 0 0-1.414-1.414L12 10.586 6.225 4.811z"/></svg>
                </button>
            </div>
            
            <div class="panel-body">
                <div class="nav-sidebar">
                    <div class="nav-inner">
                    <div class="nav-item active" data-tab="tab-appearance">
                        <svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0 0 18c1.66 0 3-1.34 3-3 0-.55-.45-1-1-1s-1 .45-1 1c0 .55-.45 1-1 1-3.86 0-7-3.14-7-7s3.14-7 7-7 7 3.14 7 7c0 1.1-.9 2-2 2h-1.5c-1.38 0-2.5 1.12-2.5 2.5S14.62 19 16 19h2c1.66 0 3-1.34 3-3a9 9 0 0 0-9-9z"/></svg>
                        <span class="nav-text">外观设置</span>
                    </div>
                    <div class="nav-item" data-tab="tab-typing">
                        <svg viewBox="0 0 24 24"><path d="M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 12H4V7h16v10zm-9-2h2V9h-2v6zm-4 0h2v-4H7v4zm8 0h2v-2h-2v2z"/></svg>
                        <span class="nav-text">输入增强</span>
                    </div>
                    <div class="nav-item" data-tab="tab-workshop">
                        <svg viewBox="0 0 24 24"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-2 .9-2 2v3.8h1.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>
                        <span class="nav-text">创意工坊</span>
                    </div>
                    <div class="nav-item" data-tab="tab-about">
                        <svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
                        <span class="nav-text">关于</span>
                    </div>
                    </div>
                </div>

                <div class="content-area">
                    <div class="tab-content active" id="tab-appearance">
                        <div class="section-title">🖼️ 自定义背景图</div>
                        <div class="row-card" style="flex-direction: column; align-items: stretch;">
                            <div class="input-group">
                                <input type="text" id="bgInput" placeholder="粘贴图床直链...">
                                <button id="saveBgBtn">保存</button>
                            </div>
                            <div style="display:flex; gap:8px; margin-top:8px;">
                                <input type="file" id="bgFileUpload" accept="image/*">
                                <button id="uploadBgBtn" class="btn-secondary">📁 上传本地图片</button>
                                <button id="clearBgBtn" class="btn-danger">🗑️ 恢复默认</button>
                            </div>
                        </div>

                        <div class="row-card">
                            <div class="row-info">
                                <div class="row-title">开启背景遮罩</div>
                                <div class="row-desc">保护文字清晰度，背景变暗</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="maskToggle">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>

                        <div class="section-title" style="margin-top: 12px;">✨ 个性化组件</div>
                        <div class="row-card">
                            <div class="row-info">
                                <div class="row-title">隐藏右下角大猫</div>
                                <div class="row-desc">干掉碍眼的背景装饰</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="hideCatToggle">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="row-card">
                            <div class="row-info">
                                <div class="row-title">创作快捷入口（K3 / K4 / BoxPlay / VOXA）</div>
                                <div class="row-desc">在创作栏追加这几个入口，关掉即消失</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="kitten4Toggle">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="row-card">
                            <div class="row-info">
                                <div class="row-title">倒反天罡：分区改列表</div>
                                <div class="row-desc">让方块分区变成横条</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="categoryListToggle">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="row-card">
                            <div class="row-info">
                                <div class="row-title">倒反天罡：创作改网格</div>
                                <div class="row-desc">让编辑器列表变成方块</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="creationGridToggle">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>

                        <div class="section-title" style="margin-top: 12px;">🖱️ 鼠标指针</div>
                        <div class="cursor-grid" id="cursorGrid">
                            <div class="cursor-item" data-val="default">默认</div>
                            <div class="cursor-item" data-val="style1">款式1</div>
                            <div class="cursor-item" data-val="style2">款式2</div>
                            <div class="cursor-item" data-val="style3">款式3</div>
                            <div class="cursor-item" data-val="style6">万圣</div>
                            <div class="cursor-item" data-val="custom">✨ 自定义</div>
                        </div>
                        <input type="file" id="customCursorFile" accept="image/png">
                    </div>

                    <div class="tab-content" id="tab-typing">
                        <div class="row-card">
                            <div class="row-info">
                                <div class="row-title">可视化编辑器（富文本）</div>
                                <div class="row-desc">帖子编辑页把 Markdown 输入框换成类 Word 的富文本编辑器</div>
                                <div class="row-credit">⚡ 由 <a href="https://github.com/GrantPome/PickScribe" target="_blank" rel="noopener">PickScribe</a> 提供支持 · 原作者 <b>Grant</b>（@GrantPome）</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="editorToggle">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="row-card">
                            <div class="row-info">
                                <div class="row-title">启用自动加后缀</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="suffixEnableToggle">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        
                        <div id="suffix-settings-area" style="display: flex; flex-direction: column; gap: 12px;">
                            <div class="row-card" style="flex-direction: column; align-items: stretch;">
                                <div class="row-title">当前后缀列表</div>
                                <div class="suffix-list" id="suffixList"></div>
                                <div class="input-group">
                                    <input type="text" id="newSuffixInput" placeholder="输入新后缀 (如: 喵~)">
                                    <button id="addSuffixBtn">添加</button>
                                </div>
                            </div>

                            <div class="row-card">
                                <div class="row-info">
                                    <div class="row-title">加后缀模式</div>
                                </div>
                                <select id="suffixMode" style="padding:6px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text-main);">
                                    <option value="line">按行加 (换行时)</option>
                                    <option value="sentence">按句加 (标点前)</option>
                                </select>
                            </div>

                            <div class="row-card">
                                <div class="row-info">
                                    <div class="row-title">随机选一个</div>
                                </div>
                                <label class="toggle-switch">
                                    <input type="checkbox" id="randomToggle">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>
                    </div>

                    <div class="tab-content" id="tab-workshop">
                        <div class="ws-installed-head">
                            <button class="ws-btn primary" id="wsOpenFull" style="width:100%; padding:11px 14px;">🧩 打开创意工坊（整页）</button>
                            <div class="ws-installed-tip">这里只管你已经装过的东西：改设置、停用、卸载。想装新的，去工坊逛。</div>
                            <button class="ws-btn primary" id="wsUpdateAll" type="button" style="display:none; width:100%; margin-top:10px;">更新全部</button>
                        </div>
                        <div class="ws-top" style="display:none">
                            <input type="text" class="ws-search" id="wsSearch" placeholder="搜索主题 / 插件 / 作者…">
                            <button class="ws-btn" id="wsRefresh" title="从 jsDelivr 重新拉取社区清单"
                                style="flex:0 0 auto; white-space:nowrap; padding:8px 10px; font-size:12px;">🌐 同步</button>
                        </div>
                        <div class="ws-status">
                            <span id="wsStatusText">已安装 0 个 · 运行中 0 个</span>
                            <label class="ws-safemode" title="应急逃生：一键停用所有插件、摘掉主题皮肤，页面回到原生样子。安装状态不变，再点一次就恢复">
                                <input type="checkbox" id="wsSafeMode">
                                <span>🛑 应急逃生</span>
                            </label>
                        </div>
                        <div class="ws-tier" style="display:none">
                            <span>允许安装：</span>
                            <select id="wsTier">
                                <option value="safe">🟢 安全</option>
                                <option value="balanced">🟡 均衡</option>
                                <option value="free">🔴 自由</option>
                            </select>
                            <span class="ws-tier-hint" id="wsTierHint">主题与纯数据插件，碰不到页面</span>
                        </div>
                        <div class="ws-chips" id="wsChips" style="display:none">
                            <div class="ws-chip active" data-filter="all">全部</div>
                            <div class="ws-chip" data-filter="theme">个性主题</div>
                            <div class="ws-chip" data-filter="plugin">功能增强</div>
                            <div class="ws-chip" data-filter="ai">AI·第三方</div>
                        </div>
                        <div class="ws-grid" id="wsGrid">
                            <div class="ws-empty">正在加载工坊清单…</div>
                        </div>
                    </div>

                    <div class="tab-content" id="tab-about">
                        <div class="about-logo">
                            <img class="logo-light" src="${safeGetURL('icons/black_logo_about.png')}" alt="PICKCAT Plus">
                            <img class="logo-dark" src="${safeGetURL('icons/white_logo_about.png')}" alt="PICKCAT Plus">
                        </div>
                        <div class="row-card" style="flex-direction: column; align-items: flex-start; gap: 12px;">
                            <h3 style="margin:0; color:var(--text-main);">PICKCAT Plus v2.6.0</h3>
                            <div class="update-row">
                                <span id="updateStatus" class="update-status">检查中…</span>
                                <button id="updateBtn" class="update-btn" type="button">检查更新</button>
                            </div>
                            <div class="dev-row">
                                <div class="dev-row-info">
                                    <div class="dev-row-title">开发者模式</div>
                                    <div class="dev-row-desc">在控制台输出详细信息，排查问题时再开</div>
                                </div>
                                <label class="toggle-switch">
                                    <input type="checkbox" id="devModeToggle">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <p style="margin:0; font-size:13px; color:var(--text-muted); line-height:1.6;">
                                一个由社区开发者手搓的非官方 PICKCAT 增强插件。<br>
                                旨在提供更顺手、更沉浸的社区体验。
                            </p>
                            <div style="display:flex; flex-direction:column; gap:6px;">
                                <a href="https://github.com/lszh2012/Pickcat-Plus" target="_blank" rel="noopener" style="color:var(--primary); font-size:13px; text-decoration:none;">👉 访问 GitHub 仓库</a>
                                <a href="https://pickcat.dao3.fun/profile/01a0d3af-d524-7801-a9df-dea9be93072a" target="_blank" rel="noopener" style="color:var(--primary); font-size:13px; text-decoration:none;">🐾 我的 PICKCAT 主页</a>
                            </div>
                            <div style="margin-top:16px; width:100%; display:flex; gap:8px;">
                                <button id="resetAllBtn" style="flex:1; padding:10px; background:#ef4444; color:white; border:none; border-radius:8px; cursor:pointer; font:inherit;">🔄 重置所有设置</button>
                                <button id="resetCancelBtn" style="display:none; padding:10px 14px; background:transparent; color:var(--text-muted); border:1px solid var(--border); border-radius:8px; cursor:pointer; font:inherit;">取消</button>
                            </div>
                        </div>

                        <div class="row-card link-card">
                            <h3 class="link-title">🔗 联动 · PickScribe</h3>
                            <p class="link-status" id="linkStatus">正在找 PickScribe…</p>
                            <button class="link-btn" id="linkBtn" type="button">了解 PickScribe</button>
                        </div>

                        <div class="row-card about-contrib">
                            <h3 class="about-contrib-title">🐾 贡献者</h3>
                            <p class="about-contrib-sub">没有他们，这个扩展会少一大半东西。</p>
                            <ul class="about-contrib-list">
                                <li>
                                    <b>Grant</b>（石榴 · <a class="about-link" href="https://github.com/GrantPome" target="_blank" rel="noopener">@GrantPome</a>）
                                    <span>PickScribe 的作者。本扩展的「可视化编辑器」源自他的项目，裁剪后内置。</span>
                                </li>
                                <li>
                                    <b>Helen.S</b>（<a class="about-link" href="https://github.com/Helencpu" target="_blank" rel="noopener">@Helencpu</a>）
                                    <span>「万圣夜惊魂」主题作者；蛛网装饰件的形态也来自她的实现。</span>
                                </li>
                                <li>
                                    <b>Bli-Hus × Xuzho</b>
                                    <span>类 WinUI 的社区概念设计，工坊和面板的视觉方向参考了这份设计。</span>
                                </li>
                                <li>
                                    <b>lszh2012</b>（<a class="about-link" href="https://github.com/lszh2012" target="_blank" rel="noopener">@lszh2012</a>）
                                    <span>扩展本体、创意工坊与工具链；「加喵」源自同为本人开发的 pickcat-miao。</span>
                                </li>
                            </ul>
                            <p class="about-contrib-foot">想把自己写进来？欢迎来 GitHub 投稿主题或插件喵～</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const floatingBall = shadow.getElementById('floating-ball');
    const panel = shadow.getElementById('settings-panel');
    const closeBtn = shadow.getElementById('close-panel');
    const hoverZone = shadow.getElementById('hover-zone');
    
    /* ---------- 悬浮球：可拖动 + 位置记忆 ---------- */
    const BALL_KEY = 'pickcatBallPos';
    const BALL_SIZE = 50;
    const BALL_GAP = 8;
    let ballPos = null;
    let dragState = null;

    function clampBall(x, y) {
        const maxX = Math.max(BALL_GAP, window.innerWidth - BALL_SIZE - BALL_GAP);
        const maxY = Math.max(BALL_GAP, window.innerHeight - BALL_SIZE - BALL_GAP);
        return {
            x: Math.min(Math.max(BALL_GAP, Number(x) || 0), maxX),
            y: Math.min(Math.max(BALL_GAP, Number(y) || 0), maxY)
        };
    }

    function updatePanelSide() {
        const cx = (ballPos ? ballPos.x : window.innerWidth) + BALL_SIZE / 2;
        panel.classList.toggle('panel-left', cx < window.innerWidth / 2);
    }

    function applyBallPos(p) {
        hoverZone.style.left = p.x + 'px';
        hoverZone.style.top = p.y + 'px';
        hoverZone.style.right = 'auto';
        hoverZone.style.transform = 'none';
        updatePanelSide();
    }

    function defaultBallPos() {
        return clampBall(window.innerWidth - BALL_SIZE - BALL_GAP, window.innerHeight / 2 - BALL_SIZE / 2);
    }

    function openPanel() {
        updatePanelSide();
        panel.classList.add('open');
        hoverZone.style.display = 'none';
    }

    hoverZone.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const rect = hoverZone.getBoundingClientRect();
        dragState = {
            id: e.pointerId,
            offX: e.clientX - rect.left,
            offY: e.clientY - rect.top,
            startX: e.clientX,
            startY: e.clientY,
            moved: false
        };
        try { hoverZone.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        e.preventDefault();
    });

    // 移动/抬起挂在 window 上：即使指针飞快跑出球外（甚至没拿到 capture）也不会掉
    window.addEventListener('pointermove', (e) => {
        if (!dragState || dragState.id !== e.pointerId) return;
        if (!dragState.moved) {
            if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) < 4) return;
            dragState.moved = true;
            hoverZone.classList.add('dragging');
        }
        ballPos = clampBall(e.clientX - dragState.offX, e.clientY - dragState.offY);
        applyBallPos(ballPos);
    });

    function endDrag(e) {
        if (!dragState || dragState.id !== e.pointerId) return;
        const moved = dragState.moved;
        dragState = null;
        hoverZone.classList.remove('dragging');
        try { hoverZone.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

        // 没拖动 = 点击，开面板
        if (!moved) {
            openPanel();
            return;
        }
        // 松手时贴近左右边缘就吸住，避免球半挂在屏幕外
        if (ballPos) {
            if (ballPos.x <= 40) ballPos.x = BALL_GAP;
            else if (ballPos.x >= window.innerWidth - BALL_SIZE - 40) ballPos.x = window.innerWidth - BALL_SIZE - BALL_GAP;
            if (ballPos.y <= 40) ballPos.y = BALL_GAP;
            else if (ballPos.y >= window.innerHeight - BALL_SIZE - 40) ballPos.y = window.innerHeight - BALL_SIZE - BALL_GAP;
            ballPos = clampBall(ballPos.x, ballPos.y);
            applyBallPos(ballPos);
            try { chrome.storage.local.set({ [BALL_KEY]: ballPos }); } catch (err) { /* 忽略 */ }
        }
    }

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
        if (!ballPos) return;
        ballPos = clampBall(ballPos.x, ballPos.y);
        applyBallPos(ballPos);
    });

    // 恢复上次拖到的位置；第一次用就贴右边中间（和以前一样的位置）
    try {
        chrome.storage.local.get([BALL_KEY], (res) => {
            if (dragState) return; // 用户已经开始拖了，别用旧坐标覆盖
            const saved = res && res[BALL_KEY];
            ballPos = (saved && typeof saved.x === 'number' && typeof saved.y === 'number')
                ? clampBall(saved.x, saved.y)
                : defaultBallPos();
            applyBallPos(ballPos);
        });
    } catch (err) {
        ballPos = defaultBallPos();
        applyBallPos(ballPos);
    }

    closeBtn.addEventListener('click', () => {
        panel.classList.remove('open');
        setTimeout(() => { hoverZone.style.display = 'flex'; }, 300); 
    });

    // 导航用事件委托：插件专属 Tab 是运行时插进来的，不能一次性绑定
    const navBox = shadow.querySelector('.nav-inner') || shadow.querySelector('.nav-sidebar');
    if (navBox) {
        navBox.addEventListener('click', (ev) => {
            const item = ev.target.closest ? ev.target.closest('.nav-item') : null;
            if (!item || !item.dataset.tab) return;
            const pane = shadow.getElementById(item.dataset.tab);
            if (!pane) return;
            shadow.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
            shadow.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
            item.classList.add('active');
            pane.classList.add('active');
            if (item.dataset.tab === 'tab-workshop') {
                try { Workshop.onTabOpen(); } catch (e) { /* 工坊尚未挂载时忽略 */ }
            } else if (item.dataset.tab.indexOf('tab-plug-') === 0) {
                try { Workshop.onPluginTab(item.dataset.tab.slice('tab-plug-'.length)); } catch (e) { /* ignore */ }
            }
        });
    }

    const bgInput = shadow.getElementById('bgInput');
    const saveBgBtn = shadow.getElementById('saveBgBtn');
    const bgFileUpload = shadow.getElementById('bgFileUpload');
    const uploadBgBtn = shadow.getElementById('uploadBgBtn');
    const clearBgBtn = shadow.getElementById('clearBgBtn');
    const maskToggle = shadow.getElementById('maskToggle');
    
    const hideCatToggle = shadow.getElementById('hideCatToggle');
    const kitten4Toggle = shadow.getElementById('kitten4Toggle');
    const categoryListToggle = shadow.getElementById('categoryListToggle');
    const creationGridToggle = shadow.getElementById('creationGridToggle');
    const cursorItems = shadow.querySelectorAll('.cursor-item');
    const customCursorFile = shadow.getElementById('customCursorFile');

    const suffixEnableToggle = shadow.getElementById('suffixEnableToggle');
    const editorToggle = shadow.getElementById('editorToggle');
    const suffixSettingsArea = shadow.getElementById('suffix-settings-area');
    const suffixListEl = shadow.getElementById('suffixList');
    const newSuffixInput = shadow.getElementById('newSuffixInput');
    const addSuffixBtn = shadow.getElementById('addSuffixBtn');
    const suffixMode = shadow.getElementById('suffixMode');
    const randomToggle = shadow.getElementById('randomToggle');
    const resetAllBtn = shadow.getElementById('resetAllBtn');

    // ★ 插件接管设置：置灰 + 「🔒 由 X 接管」标签，点标签当场释放
    function lockTargets() {
        return [
            { key: 'pickcatBgUrl', els: [bgInput, saveBgBtn, uploadBgBtn] },
            { key: 'pickcatBgBase64', els: [bgInput, saveBgBtn, uploadBgBtn], quiet: true },
            { key: 'pickcatMaskEnabled', els: [maskToggle] },
            { key: 'pickcatHideCat', els: [hideCatToggle] },
            { key: 'pickcatKitten4', els: [kitten4Toggle] },
            { key: 'pickcatCategoryList', els: [categoryListToggle] },
            { key: 'pickcatCreationGrid', els: [creationGridToggle] },
            { key: 'pickcatCursor', els: Array.prototype.slice.call(cursorItems) },
            { key: 'pickcatCustomCursor', els: [customCursorFile], quiet: true }
        ];
    }

    // 只还原「被接管置灰」的控件，别把 refreshPanelUI 自己加上的禁用状态一起放开
    const claimDisabled = new Set();

    function applyClaimLocks(claims) {
        const defs = lockTargets();
        defs.forEach((d) => {
            d.els.forEach((el) => {
                if (el && claimDisabled.has(el)) {
                    el.disabled = false;
                    el.removeAttribute('title');
                    claimDisabled.delete(el);
                }
            });
            const row = d.els[0] && d.els[0].closest ? d.els[0].closest('.row-card') : null;
            if (row) { row.style.opacity = ''; row.classList.remove('locked-row'); }
        });
        shadow.querySelectorAll('.ws-lock-tag').forEach((n) => n.remove());

        Object.keys(claims || {}).forEach((key) => {
            const arr = claims[key];
            if (!Array.isArray(arr) || !arr.length) return;
            const rec = arr[arr.length - 1] || {};
            const who = rec.name || rec.id || '插件';
            defs.filter((d) => d.key === key).forEach((d) => {
                d.els.forEach((el) => {
                    if (!el) return;
                    el.disabled = true;
                    el.title = '该项正被「' + who + '」接管，卸载该插件后自动恢复';
                    claimDisabled.add(el);
                });
                const row = d.els[0] && d.els[0].closest ? d.els[0].closest('.row-card') : null;
                if (row) { row.style.opacity = '0.6'; row.classList.add('locked-row'); }
                if (d.quiet) return;
                const anchor = row || (d.els[0] && d.els[0].parentElement);
                if (!anchor || anchor.querySelector('.ws-lock-tag')) return;
                const tag = document.createElement('span');
                tag.className = 'ws-lock-tag';
                tag.textContent = '🔒 由「' + who + '」接管 · 点此释放';
                tag.title = '点击立即释放该设置；插件可能显示异常，可在创意工坊重新安装';
                tag.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    releaseClaim(key, rec.id);
                });
                anchor.appendChild(tag);
            });
        });
    }

    function refreshPanelUI() {
        chrome.storage.local.get(null, (res) => {
            if (res.pickcatBgBase64) {
                bgInput.value = '已加载本地图片';
                bgInput.disabled = true;
            } else if (res.pickcatBgUrl) {
                bgInput.value = res.pickcatBgUrl;
                bgInput.disabled = false;
            } else {
                bgInput.value = '';
                bgInput.disabled = false;
            }
            maskToggle.checked = res.pickcatMaskEnabled === true;
            hideCatToggle.checked = res.pickcatHideCat === true;
            kitten4Toggle.checked = res.pickcatKitten4 === true;
            categoryListToggle.checked = res.pickcatCategoryList === true;
            creationGridToggle.checked = res.pickcatCreationGrid === true;

            let currentCursor = res.pickcatCursor || 'default';
            cursorItems.forEach(item => {
                if (item.dataset.val === currentCursor) item.classList.add('active');
                else item.classList.remove('active');
            });

            const isSuffixOn = res.pickcat_enabled === true;
            suffixEnableToggle.checked = isSuffixOn;
            // 富文本编辑器默认开（键不存在视为 true）；它自己在 editor.js 里监听 storage 变化
            editorToggle.checked = res.pickcat_editor_enabled !== false;
            if (isSuffixOn) {
                suffixSettingsArea.classList.remove('disabled-area');
            } else {
                suffixSettingsArea.classList.add('disabled-area');
            }

            suffixMode.value = res.pickcat_suffix_mode || 'line';
            randomToggle.checked = res.pickcat_random === true;
            
            const suffixes = res.pickcat_suffixes_v2 || [{ text: '喵', enabled: true }];
            suffixListEl.innerHTML = '';
            suffixes.forEach((item, index) => {
                const div = document.createElement('div');
                div.className = 'suffix-item';
                
                const label = document.createElement('label');
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = item.enabled;
                cb.addEventListener('change', (e) => {
                    const isRandom = randomToggle.checked;
                    const isChecked = e.target.checked;
                    if (isChecked && !isRandom) suffixes.forEach((s, i) => { if (i !== index) s.enabled = false; });
                    else if (!isChecked) {
                        if (!suffixes.some((s, i) => i !== index && s.enabled)) { e.target.checked = true; return alert('请至少保留一个后缀'); }
                    }
                    suffixes[index].enabled = isChecked;
                    chrome.storage.local.set({ [SUFFIXES_KEY]: suffixes });
                    refreshPanelUI();
                });
                
                const span = document.createElement('span');
                span.textContent = item.text;
                label.appendChild(cb);
                label.appendChild(span);
                
                const delBtn = document.createElement('button');
                delBtn.textContent = '×';
                delBtn.style.cssText = 'background:none; border:none; color:#ef4444; font-size:16px; cursor:pointer;';
                delBtn.onclick = () => {
                    const wasEnabled = suffixes[index].enabled;
                    suffixes.splice(index, 1);
                    if (wasEnabled && suffixes.length > 0 && !suffixes.some(s => s.enabled)) suffixes[0].enabled = true;
                    chrome.storage.local.set({ [SUFFIXES_KEY]: suffixes });
                    refreshPanelUI();
                };
                
                div.appendChild(label);
                div.appendChild(delBtn);
                suffixListEl.appendChild(div);
            });

            applyClaimLocks(res[CLAIMS_KEY] || {});
        });
    }
    panelRefreshHook = refreshPanelUI;

    function saveState(key, val, needsReload = false) {
        chrome.storage.local.set({ [key]: val }, () => {
            if (needsReload) loadAllConfigs();
        });
    }

    maskToggle.addEventListener('change', (e) => saveState('pickcatMaskEnabled', e.target.checked, true));
    hideCatToggle.addEventListener('change', (e) => saveState('pickcatHideCat', e.target.checked, true));
    kitten4Toggle.addEventListener('change', (e) => saveState('pickcatKitten4', e.target.checked, true));
    categoryListToggle.addEventListener('change', (e) => saveState('pickcatCategoryList', e.target.checked, true));
    creationGridToggle.addEventListener('change', (e) => saveState('pickcatCreationGrid', e.target.checked, true));
    // 可视化编辑器：editor.js 自己监听 storage，这里只负责写值
    editorToggle.addEventListener('change', (e) => saveState('pickcat_editor_enabled', e.target.checked));
    
    suffixEnableToggle.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        if (isChecked) {
            suffixSettingsArea.classList.remove('disabled-area');
        } else {
            suffixSettingsArea.classList.add('disabled-area');
        }
        saveState('pickcat_enabled', isChecked);
    });
    
    randomToggle.addEventListener('change', (e) => saveState('pickcat_random', e.target.checked));
    suffixMode.addEventListener('change', (e) => saveState('pickcat_suffix_mode', e.target.value));

    saveBgBtn.addEventListener('click', () => {
        if (bgInput.disabled) return alert('当前为本地图片，如需更换请先恢复默认');
        chrome.storage.local.set({ pickcatBgUrl: bgInput.value.trim(), pickcatBgBase64: '' }, () => loadAllConfigs());
    });
    uploadBgBtn.addEventListener('click', () => bgFileUpload.click());
    bgFileUpload.addEventListener('change', (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 1920;
                let width = img.width, height = img.height;
                if (width > MAX_WIDTH) { height = Math.round((height * MAX_WIDTH) / width); width = MAX_WIDTH; }
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                chrome.storage.local.set({ pickcatBgBase64: canvas.toDataURL('image/jpeg', 0.85), pickcatBgUrl: '' }, () => loadAllConfigs());
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    });
    clearBgBtn.addEventListener('click', () => {
        chrome.storage.local.set({ pickcatBgUrl: '', pickcatBgBase64: '' }, () => loadAllConfigs());
    });

    cursorItems.forEach(item => {
        item.addEventListener('click', () => {
            const val = item.dataset.val;
            if (val === 'custom') {
                customCursorFile.click();
            } else {
                saveState('pickcatCursor', val, true);
                cursorItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            }
        });
    });
    
    customCursorFile.addEventListener('change', (e) => {
        const file = e.target.files[0]; 
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 32; canvas.height = 32;
                canvas.getContext('2d').drawImage(img, 0, 0, 32, 32);
                chrome.storage.local.set({ pickcatCustomCursor: canvas.toDataURL('image/png'), pickcatCursor: 'custom' }, () => {
                    loadAllConfigs(); 
                    refreshPanelUI();
                });
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    });

    addSuffixBtn.addEventListener('click', () => {
        const text = newSuffixInput.value.trim();
        if (!text) return;
        chrome.storage.local.get([SUFFIXES_KEY, RANDOM_KEY], (res) => {
            let suffixes = res[SUFFIXES_KEY] || [{ text: '喵', enabled: true }];
            if (suffixes.some(s => s.text === text)) return alert('已存在该后缀');
            if (!res[RANDOM_KEY]) suffixes.forEach(s => s.enabled = false);
            suffixes.push({ text, enabled: true });
            chrome.storage.local.set({ [SUFFIXES_KEY]: suffixes }, () => {
                newSuffixInput.value = '';
                refreshPanelUI();
            });
        });
    });

    // 重置：用面板内二次确认代替原生 confirm（原生对话框被浏览器「阻止此页面创建更多对话框」拦掉后就点不动了）
    let resetTimer = 0;
    const resetCancelBtn = shadow.getElementById('resetCancelBtn');
    /* ---------- 检查更新 ----------
       解压加载的扩展没有自动更新通道（Chrome 只管商店版本），所以只能自己查：
       拿远端仓库根目录的 manifest.json 比版本号。零服务器、零新权限。
       失败一律静默 —— 离线不该打扰人。 */
    const UPDATE_CACHE_KEY = 'pickcat_update_check';
    const UPDATE_TTL = 6 * 60 * 60 * 1000;
    const UPDATE_SOURCES = [
        'https://raw.githubusercontent.com/lszh2012/Pickcat-Plus/main/manifest.json',
        'https://cdn.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/manifest.json',
        'https://fastly.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/manifest.json',
        'https://gcore.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/manifest.json'
    ];
    const RELEASE_URL = 'https://github.com/lszh2012/Pickcat-Plus/releases/latest';
    const updateStatus = shadow.getElementById('updateStatus');
    const updateBtn = shadow.getElementById('updateBtn');
    let latestVersion = null;

    function localVersion() {
        try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
    }

    // 逐段比数字，不能用字符串比 —— 否则 2.10 会被判成比 2.9 小
    function verCmp(a, b) {
        const pa = String(a || '0').split('.');
        const pb = String(b || '0').split('.');
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const x = parseInt(pa[i], 10) || 0;
            const y = parseInt(pb[i], 10) || 0;
            if (x !== y) return x > y ? 1 : -1;
        }
        return 0;
    }

    function paintUpdate(state, ver) {
        if (!updateStatus || !updateBtn) return;
        updateStatus.className = 'update-status';
        updateBtn.className = 'update-btn';
        updateBtn.disabled = false;
        if (state === 'checking') {
            updateStatus.textContent = '正在检查…';
            updateBtn.textContent = '检查更新';
            updateBtn.disabled = true;
        } else if (state === 'new') {
            updateStatus.textContent = '🎉 有新版本 v' + ver + ' 可用';
            updateStatus.className += ' new';
            updateBtn.textContent = '去下载';
            updateBtn.className += ' primary';
        } else if (state === 'latest') {
            updateStatus.textContent = '已是最新版本（v' + localVersion() + '）';
            updateBtn.textContent = '再检查一次';
        } else if (state === 'error') {
            updateStatus.textContent = '检查失败，网络不太顺，稍后再试喵';
            updateStatus.className += ' err';
            updateBtn.textContent = '重试';
        }
    }

    async function fetchRemoteVersion() {
        for (let i = 0; i < UPDATE_SOURCES.length; i++) {
            try {
                const ctl = typeof AbortController === 'function' ? new AbortController() : null;
                const timer = ctl ? setTimeout(() => ctl.abort(), 6000) : 0;
                const res = await fetch(UPDATE_SOURCES[i] + (UPDATE_SOURCES[i].indexOf('?') >= 0 ? '&' : '?') + '_pcb=' + Date.now(), {
                    cache: 'no-store',
                    signal: ctl ? ctl.signal : undefined
                });
                if (timer) clearTimeout(timer);
                if (!res || !res.ok) continue;
                const json = await res.json();
                if (json && json.version) return String(json.version);
            } catch (e) { /* 这个源不行，换下一个 */ }
        }
        return null;
    }

    async function checkUpdate(force) {
        const local = localVersion();
        if (!local) return;
        // 6 小时内的结果直接用，避免每次开面板都发一次请求
        if (!force) {
            const cached = await new Promise((done) => {
                try { chrome.storage.local.get([UPDATE_CACHE_KEY], (r) => done((r && r[UPDATE_CACHE_KEY]) || null)); }
                catch (e) { done(null); }
            });
            if (cached && cached.at && Date.now() - cached.at < UPDATE_TTL && cached.version) {
                latestVersion = cached.version;
                paintUpdate(verCmp(cached.version, local) > 0 ? 'new' : 'latest', cached.version);
                return;
            }
        }
        paintUpdate('checking');
        const ver = await fetchRemoteVersion();
        if (!ver) { paintUpdate('error'); return; }
        latestVersion = ver;
        try { chrome.storage.local.set({ [UPDATE_CACHE_KEY]: { version: ver, at: Date.now() } }); } catch (e) { /* ignore */ }
        paintUpdate(verCmp(ver, local) > 0 ? 'new' : 'latest', ver);
    }

    if (updateBtn) {
        updateBtn.addEventListener('click', () => {
            const local = localVersion();
            if (latestVersion && verCmp(latestVersion, local) > 0) {
                window.open(RELEASE_URL, '_blank', 'noopener');
                return;
            }
            checkUpdate(true);
        });
    }

    // 打开面板时先看缓存，没有就查一次（不阻塞面板渲染）
    setTimeout(() => { try { checkUpdate(false); } catch (e) { /* ignore */ } }, 800);


    function disarmReset() {
        clearTimeout(resetTimer);
        resetTimer = 0;
        resetAllBtn.textContent = '🔄 重置所有设置';
        resetAllBtn.style.background = '#ef4444';
        if (resetCancelBtn) resetCancelBtn.style.display = 'none';
    }

    resetAllBtn.addEventListener('click', () => {
        if (!resetTimer) {
            // 第一次点：进入待确认状态，5 秒内没确认就自动撤回
            resetAllBtn.textContent = '⚠️ 再点一次，确认清空所有设置';
            resetAllBtn.style.background = '#b91c1c';
            if (resetCancelBtn) resetCancelBtn.style.display = 'inline-block';
            resetTimer = setTimeout(disarmReset, 5000);
            return;
        }

        disarmReset();
        chrome.storage.local.get(null, (items) => {
            const keysToRemove = Object.keys(items).filter(k => k.startsWith('pickcat'));
            chrome.storage.local.remove(keysToRemove, () => {
                refreshPanelUI();
                loadAllConfigs();
                panel.classList.remove('open');
                setTimeout(() => { hoverZone.style.display = 'flex'; }, 300);
            });
        });
    });

    if (resetCancelBtn) {
        resetCancelBtn.addEventListener('click', disarmReset);
    }

    /* ---------------- 联动（PickScribe） ----------------
     *
     * 两个扩展各自注入 content script，彼此看不到对方。
     * 唯一合法的通道是 window.postMessage —— 不传用户数据，只报「我是谁、什么版本、能干什么」。
     *
     * 协议 v1（双向，谁先来都行）：
     *   喊人：{ source:'pickcat-plus', type:'pickcat:link-ping' }
     *   应答：{ source:'pickscribe',  type:'pickscribe:hello', version:'3.8.1', features:['ai','editor'] }
     *   反向：pickscribe 喊 pickscribe:link-ping，我们回 pickcat:hello
     *   请求：{ source:'pickcat-plus', type:'pickcat:open-ai' } —— 请对方把 AI 面板打开
     */
    const LINK_PEER = 'pickscribe';
    const linkState = { peer: null, at: 0 };
    let linkPaint = null;
    let linkInited = false;

    function linksend(obj) {
        try { window.postMessage(obj, '*'); } catch (e) { }
    }

    function initLinkBridge() {
        if (linkInited) return;
        linkInited = true;

        window.addEventListener('message', (ev) => {
            const d = ev.data;
            if (!d || typeof d !== 'object') return;

            if (d.source === LINK_PEER && d.type === 'pickscribe:hello') {
                linkState.peer = {
                    version: String(d.version || '?').slice(0, 20),
                    features: Array.isArray(d.features) ? d.features.slice(0, 8).map(String) : []
                };
                linkState.at = Date.now();
                if (linkPaint) { try { linkPaint(); } catch (e) { } }
                return;
            }

            if (d.type === 'pickscribe:link-ping') {
                linksend({ source: 'pickcat-plus', type: 'pickcat:hello', version: pickcatVersion(), features: ['editor', 'workshop', 'dom-bridge'] });
            }
        });

        // 对方可能比我们晚加载，多喊几次（一共不到 5 秒，喊不到就算了）
        [0, 700, 1800, 3500, 4800].forEach(function (ms) {
            setTimeout(function () { linksend({ source: 'pickcat-plus', type: 'pickcat:link-ping', version: pickcatVersion() }); }, ms);
        });
    }

    const devModeToggle = shadow.getElementById('devModeToggle');
    const linkStatusEl = shadow.getElementById('linkStatus');
    const linkBtn = shadow.getElementById('linkBtn');
    if (linkBtn) {
        linkPaint = function () {
            if (!linkStatusEl) return;
            if (linkState.peer) {
                linkStatusEl.textContent = '已连接 PickScribe v' + linkState.peer.version +
                    '（对方也装了，两个扩展能互相喊话喵）';
                linkStatusEl.classList.add('on');
                linkBtn.textContent = '打开 PickScribe 助手';
                linkBtn.dataset.mode = 'peer';
            } else {
                linkStatusEl.textContent = '还没检测到 PickScribe。它的可视化编辑器和 AI 助手和本扩展互补，装上就会自动发现，不需要配置。';
                linkStatusEl.classList.remove('on');
                linkBtn.textContent = '了解 PickScribe';
                linkBtn.dataset.mode = 'repo';
            }
        };
        linkBtn.addEventListener('click', function () {
            if (linkBtn.dataset.mode === 'peer') {
                linksend({ source: 'pickcat-plus', type: 'pickcat:open-ai' });
                try { Workshop.toast('已经请 PickScribe 打开助手；如果没反应，点它自己的按钮也一样喵', 5000); } catch (e) { }
            } else {
                window.open('https://github.com/GrantPome/PickScribe', '_blank', 'noopener');
            }
        });
        initLinkBridge();
        linkPaint();
    }

    if (devModeToggle) {
        chrome.storage.local.get(['pickcat_dev_mode'], (res) => {
            devModeToggle.checked = res.pickcat_dev_mode === true;
        });
        devModeToggle.addEventListener('change', (e) => {
            chrome.storage.local.set({ pickcat_dev_mode: e.target.checked === true });
        });
        chrome.storage.onChanged.addListener((ch, area) => {
            if (area === 'local' && ch.pickcat_dev_mode) devModeToggle.checked = ch.pickcat_dev_mode.newValue === true;
        });
    }

    refreshPanelUI();

    // 创意工坊：挂到侧栏第 4 个标签（延后一帧，等模块常量初始化完）
    setTimeout(() => {
        try {
            Workshop.mount(shadow);
        } catch (e) {
            console.warn('[pickcat] 工坊初始化失败：', e);
        }
    }, 0);
}

// ==========================================
// 主程序：启动与初始化
// ==========================================
function loadAllConfigs(callback) {
    chrome.storage.local.get([
        'pickcatBgUrl', 'pickcatBgBase64', 'pickcatMaskEnabled', 'pickcatCursor', 'pickcatCustomCursor',
        'pickcatHideCat', 'pickcatKitten4', 'pickcatCategoryList', 'pickcatCreationGrid', CLAIMS_KEY,
        'pickcat_dev_mode'
    ], (res) => {
        const devNow = res.pickcat_dev_mode === true;
        const devChanged = devNow !== PICKCAT_DEV;
        PICKCAT_DEV = devNow;
        if (devChanged && devPushHook) {
            try { devPushHook(); } catch (e) { }
        }
        if (devChanged) {
            console.info('[PICKCAT Plus] v' + pickcatVersion() + (PICKCAT_DEV ? ' · 开发者模式已开启，详细信息会打印在这里' : ' · 开发者模式已关闭'));
        }
        pickcatBanner();
        // 插件租约覆盖：只在内存里生效，不碰用户存的原始值
        const claims = (res[CLAIMS_KEY] && typeof res[CLAIMS_KEY] === 'object') ? res[CLAIMS_KEY] : {};
        const pick = (key, fallback) => claimedValue(claims, key, fallback);

        config.hideCat = pick('pickcatHideCat', res.pickcatHideCat === true) === true;
        config.kitten4 = pick('pickcatKitten4', res.pickcatKitten4 === true) === true;
        config.categoryList = pick('pickcatCategoryList', res.pickcatCategoryList === true) === true;
        config.creationGrid = pick('pickcatCreationGrid', res.pickcatCreationGrid === true) === true;

        config.bgUrl = pick('pickcatBgUrl', res.pickcatBgUrl || '');
        config.bgBase64 = pick('pickcatBgBase64', res.pickcatBgBase64 || '');
        config.maskEnabled = pick('pickcatMaskEnabled', res.pickcatMaskEnabled === true) === true;

        applyBackground(config.bgUrl, config.bgBase64, config.maskEnabled);
        
        let cursorStyle = pick('pickcatCursor', res.pickcatCursor || 'default'); 
        if (['style4', 'style5'].includes(cursorStyle)) cursorStyle = 'default';
        injectCursorStyle(cursorStyle, pick('pickcatCustomCursor', res.pickcatCustomCursor || '')); 

        applyHideCat(config.hideCat);
        if (!config.kitten4) { removeKitten4(); removeKitten3(); }
        injectKitten4();
        injectKitten3();
        transformCreationCards();
        transformCategoriesToList();
        
        syncShadowTheme();
        
        if (callback) callback();
    });
}

function syncShadowTheme() {
    const host = document.getElementById('pickcat-settings-host');
    if (!host) return;
    if (isDarkMode()) {
        host.classList.add('pickcat-dark');
    } else {
        host.classList.remove('pickcat-dark');
    }
    checkThemeModeHint();
}

// ★ 核心修复：判空保护，确保 body 存在才监听
const themeObserver = new MutationObserver(() => {
    syncShadowTheme();
    loadAllConfigs();
});
if (document.documentElement) {
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
}
if (document.body) {
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
}

function startApp() {
    if (!document.body) { setTimeout(startApp, 50); return; }
    
    // 如果之前没监听到 body，这里补上
    if (document.body && !themeObserver._bodyObserved) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
        themeObserver._bodyObserved = true;
    }

    initSuffixModule(); 
    processLinks();
    loadAllConfigs();
    createSettingsPanel(); 

    const observer = new MutationObserver(() => { 
        processLinks();
        setTimeout(() => {
            injectKitten4();
            injectKitten3();
            transformCreationCards(); 
            transformCategoriesToList();
        }, 100); 
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

startApp();

// 系统亮/暗切换时，实时同步遮罩与设置面板配色（网站未显式声明主题时才生效）
try {
    const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
        syncShadowTheme();
        applyBackground(config.bgUrl, config.bgBase64, config.maskEnabled);
    };
    if (systemThemeQuery.addEventListener) {
        systemThemeQuery.addEventListener('change', onSystemThemeChange);
    } else if (systemThemeQuery.addListener) {
        systemThemeQuery.addListener(onSystemThemeChange);
    }
} catch (e) { /* 环境不支持 matchMedia 时忽略 */ }

chrome.storage.onChanged.addListener((changes) => {
    if (
        changes.pickcatBgUrl || changes.pickcatBgBase64 || changes.pickcatMaskEnabled || 
        changes.pickcatCursor || changes.pickcatCustomCursor ||
        changes.pickcatHideCat || changes.pickcatKitten4 || 
        changes.pickcatCategoryList || changes.pickcatCreationGrid
    ) { 
        loadAllConfigs(); 
    }
});

// ==========================================
// 模块 6：创意工坊（主题 = 纯数据，插件 = 沙盒 code）
// ==========================================
const WS_STATE_KEY = 'pickcat_ws_state';
const WS_DATA_PREFIX = 'pickcat_ws_data_';
// 免责协议的版本号：内容有实质变化时 +1，所有用户会重新签一次
const CONSENT_KEY = 'pickcat_ws_consent';
const CONSENT_VERSION = 1;

const WS_PERM_DEFS = {
    'dom-read': { level: 'low', icon: '👀', label: '读取页面文字', desc: '只读当前页面的可见文字（用来取帖子正文）' },
    'ui-interaction': { level: 'low', icon: '🧩', label: '添加界面元素', desc: '在你页面上加按钮和结果卡片，不会改动站点原有元素' },
    'notify': { level: 'low', icon: '🔔', label: '弹出提示', desc: '右下角小提示，点一下就没' },
    'clipboard-write': { level: 'mid', icon: '📋', label: '写入剪贴板', desc: '只能写，不能读你剪贴板里的其他内容' },
    'storage': { level: 'mid', icon: '💾', label: '保存自己的配置', desc: '只写在插件自己的命名空间，读不到 PICKCAT 的其他设置' },
    'network': { level: 'high', icon: '🌐', label: '联网', desc: '仅限清单里声明的域名，白名单之外的请求会被硬拦' },
    // 下面两个还没实现（等锚点 + 子树代理那批），先列出来是为了让清单能提前声明、
    // 市场卡片能提前如实显示「这个包想动你的页面」。
    'dom-write': { level: 'high', icon: '✏️', label: '改动页面（锚点内）', desc: '只能改它自己声明的那个区域，比如发帖编辑区' },
    'dom-global': { level: 'high', icon: '💥', label: '改动整个页面', desc: '可以重写页面结构，需要「自由」等级' }
};

const Workshop = (function () {
    let shadow = null;
    let els = {};
    let catalog = [];
    let state = { installed: {}, safeMode: false, pausedSkin: null };
    let pluginData = {};
    let filterCat = 'all';
    let keyword = '';
    let pendingConfirm = null;

    let frame = null;
    let frameReady = false;
    let readyResolvers = [];
    let cardSeq = 0;
    let pageStyleInjected = false;

    /* ---------------- 小工具 ---------------- */

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function get(keys) {
        return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    }

    function set(obj) {
        return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
    }

    function remove(keys) {
        return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
    }

    function saveState() {
        return set({ [WS_STATE_KEY]: state });
    }

    function savePluginData(id) {
        return set({ [WS_DATA_PREFIX + id]: pluginData[id] || {} });
    }

    function toast(text, ms) {
        let t = document.getElementById('pickcat-ws-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'pickcat-ws-toast';
            t.style.cssText = 'position:fixed;bottom:34px;left:50%;transform:translate(-50%,14px);z-index:999998;' +
                'background:rgba(24,24,32,.92);color:#fff;padding:10px 18px;border-radius:11px;font:600 13px/1.4 system-ui,sans-serif;' +
                'box-shadow:0 10px 30px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);max-width:70vw;' +
                'transition:opacity .25s ease, transform .25s ease;opacity:0;pointer-events:none;';
            (document.body || document.documentElement).appendChild(t);
        }
        t.textContent = text;
        t.style.opacity = '1';
        t.style.transform = 'translate(-50%, 0)';
        clearTimeout(t.__h);
        t.__h = setTimeout(() => {
            t.style.opacity = '0';
            t.style.transform = 'translate(-50%, 14px)';
        }, ms || 2600);
    }

    /* ---------------- 清单（内置 + 社区远程，零服务器：GitHub raw + jsDelivr 兜底） ---------------- */

    // 源顺序很重要：raw.githubusercontent 的缓存只有 5 分钟，推完等一会儿就能拿到新的；
    // jsDelivr 边缘缓存 12 小时（s-maxage=43200）且换 query 串也不刷新，只能靠 purge 工具，
    // 所以它退到最后当兜底 —— raw 被墙的用户照样能用。
    const CDN_BASES = [
        'https://raw.githubusercontent.com/lszh2012/Pickcat-Plus/main/',
        'https://raw.githubusercontent.com/lszh2012/Pickcat-Plus/master/',
        'https://cdn.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/',
        'https://fastly.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/',
        'https://gcore.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/',
        'https://testingcf.jsdelivr.net/gh/lszh2012/Pickcat-Plus@main/'
    ];
    // 手动「同步」时再加两个冷门镜像，尽量把最新内容捞回来
    function cdnBases() {
        return CDN_BASES.slice();
    }
    const CATALOG_CACHE_KEY = 'pickcat_ws_catalog_cache';
    const REVOKED_CACHE_KEY = 'pickcat_ws_revoked';
    const CATALOG_TTL = 24 * 60 * 60 * 1000;
    const CATALOG_SOFT_TTL = 10 * 60 * 1000;
    const CATALOG_LOCAL_TTL = 30 * 60 * 1000;
    const REPO_URL = 'https://github.com/lszh2012/Pickcat-Plus';
    const APPLY_KEYS = ['pickcatBgUrl', 'pickcatBgBase64', 'pickcatMaskEnabled', 'pickcatCursor', 'pickcatCustomCursor'];
    const ID_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;
    const PATH_RE = /^[A-Za-z0-9._\/-]+$/;
    const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
    let remoteMerged = 0;
    let remoteSyncedAt = 0;
    let remoteUpdated = '';
    // 撤回表：id -> { reason, at }。命中即「不再运行 / 不再允许安装」。
    // 这是「维护者只有周末能上电脑」这个约束下唯一的保险：撤一条只要改一行 JSON。
    let revoked = {};
    let revokedAt = 0;

    function str(v, max) {
        return String(v == null ? '' : v).slice(0, max);
    }

    // 解析插件要「接管」的设置项（claims）
    function parseClaims(list) {
        if (!Array.isArray(list)) return undefined;
        const out = [];
        const seen = {};
        for (let i = 0; i < list.length && out.length < CLAIM_MAX; i++) {
            const c = list[i];
            if (!c || typeof c !== 'object') continue;
            const key = str(c.key, 40);
            if (!CLAIM_KEY_TYPES[key] || seen[key]) continue;
            const v = claimValueOk(key, c.value);
            if (v === undefined) continue;
            seen[key] = 1;
            out.push({ key: key, value: v, label: str(c.label, 60) || key, reason: str(c.reason, 80) });
        }
        return out.length ? out : undefined;
    }

    // 装饰件：只能从能力目录里挑零件、只能调有限的几个参数。
    // 清单里写一个不存在的类型，直接丢掉（不报错，免得整份主题装不上）。
    const DECOR_TYPES = ['corner-web'];

    function parseDecor(list) {
        if (!Array.isArray(list)) return undefined;
        const out = [];
        const seen = {};
        for (let i = 0; i < list.length && out.length < 4; i++) {
            const raw = list[i];
            const opt = (typeof raw === 'string') ? { type: raw } : (raw && typeof raw === 'object' ? raw : null);
            if (!opt) continue;
            const type = str(opt.type, 30);
            if (DECOR_TYPES.indexOf(type) === -1 || seen[type]) continue;
            seen[type] = 1;
            const item = { type: type };
            if (typeof opt.opacity === 'number' && isFinite(opt.opacity)) {
                item.opacity = Math.max(0, Math.min(1, opt.opacity));
            }
            if (typeof opt.color === 'string' && opt.color.length <= 40 &&
                /^[#a-zA-Z0-9(),.%\s]{3,40}$/.test(opt.color)) {
                item.color = opt.color;
            }
            if (opt.emoji === false) item.emoji = false;
            out.push(item);
        }
        return out.length ? out : undefined;
    }

    // 远程来的东西一律当不可信输入：字段白名单 + 长度上限 + 路径校验
    function sanitizeItem(raw, base) {
        if (!raw || typeof raw !== 'object') return null;
        const id = str(raw.id, 50);
        if (!ID_RE.test(id)) return null;
        const type = raw.type === 'theme' ? 'theme' : (raw.type === 'plugin' ? 'plugin' : '');
        if (!type) return null;

        const trusted = TRUSTED_COMMUNITY_IDS.indexOf(id) >= 0;
        const anchors = Array.isArray(raw.anchor)
            ? raw.anchor.filter((a, i, arr) => DOM_ANCHOR_KINDS.indexOf(a) >= 0 && arr.indexOf(a) === i).slice(0, 4)
            : [];
        const item = {
            id: id,
            type: type,
            name: str(raw.name, 40) || id,
            emoji: str(raw.emoji, 8) || '📦',
            category: str(raw.category, 20) || 'other',
            author: str(raw.author, 40) || '匿名',
            version: str(raw.version, 20) || '1.0.0',
            desc: str(raw.desc, 240),
            // hidden：不在工坊列表里展示，只留给开发自测（已装的仍然会跑，
            // 卸载后不会再出现在「已下架」区，因为它本来就没上架）
            hidden: raw.hidden === true,
            mode: (raw.mode === 'dark' || raw.mode === 'light') ? raw.mode : 'any',
            // 社区条目永远不能自称「官方 / 已审核」；白名单里的官方示例除外
            verified: trusted ? 'official' : 'unverified',
            source: 'community',
            trusted: trusted,
            __base: base
        };
        // 图标：emoji / 官方图床直链 / 小 data URI，其余丢弃
        const rawIcon = typeof raw.icon === 'string' ? raw.icon.trim() : '';
        if (rawIcon && rawIcon.length <= 26000 && (rawIcon.length <= 4 || DATA_IMG_RE.test(rawIcon) || imgUrlOk(rawIcon))) {
            item.icon = rawIcon;
        }
        if (raw.preview && typeof raw.preview === 'object' && imgUrlOk(raw.preview.image)) {
            item.preview = Object.assign({}, item.preview, { image: String(raw.preview.image).trim() });
        }
        const claims = parseClaims(raw.claims);
        if (claims) item.claims = claims;

        if (type === 'theme') {
            const src = (raw.apply && typeof raw.apply === 'object') ? raw.apply : {};
            const apply = {};
            APPLY_KEYS.forEach((k) => {
                if (src[k] === undefined || src[k] === null) return;
                if (k === 'pickcatMaskEnabled') { apply[k] = src[k] === true; return; }
                const v = str(src[k], k === 'pickcatBgBase64' ? 200000 : 20000);
                if (v) apply[k] = v;
            });
            item.apply = apply;
            if (typeof raw.cssFile === 'string' && raw.cssFile.length <= 200 &&
                PATH_RE.test(raw.cssFile) && /\.css$/i.test(raw.cssFile) && raw.cssFile.indexOf('..') === -1) {
                item.cssFile = raw.cssFile;
            }
            if (typeof raw.css === 'string' && raw.css.length <= 65536) item.css = raw.css;
            // 主题至少要有一样「能看出效果」的东西：样式表、装饰件，或 apply 里的设置项
            // （官方示例 theme-neon 就是只有 apply、没有 CSS 的最简形态）
            const decor = parseDecor(raw.decor);
            if (decor) item.decor = decor;
            // 主题自己用 CSS 画整页背景时声明它，扩展会把站点那层不透明外壳让开
            if (raw.pageBackground === true) item.pageBackground = true;
            if (raw.tier === 'safe' || raw.tier === 'balanced' || raw.tier === 'free') item.tier = raw.tier;
            if (!item.cssFile && !item.css && !decor && !Object.keys(item.apply).length) return null;
            item.htmlClass = (typeof raw.htmlClass === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(raw.htmlClass))
                ? raw.htmlClass : ('pickcat-theme-' + String(id).replace(/^theme[-_]/i, ''));
            return item;
        }

        // 插件
        const perms = Array.isArray(raw.permissions) ? raw.permissions.filter((p) => WS_PERM_DEFS[p]) : [];
        const hosts = Array.isArray(raw.hosts)
            ? raw.hosts.filter((h) => typeof h === 'string' && HOST_RE.test(h)).slice(0, 12) : [];
        if (perms.indexOf('network') !== -1 && !hosts.length) return null;   // 要联网必须给白名单
        // 想改页面，就得说清楚改哪儿：要么给锚点（Tier B），要么申请 dom-global（Tier C）
        const wantsWrite = perms.indexOf('dom-write') !== -1 || perms.indexOf('dom-global') !== -1;
        if (wantsWrite && !anchors.length && perms.indexOf('dom-global') === -1) return null;
        item.permissions = perms;
        item.hosts = hosts;
        item.anchor = anchors;

        const codePath = (typeof raw.entry === 'string' && PATH_RE.test(raw.entry) && /\.js$/i.test(raw.entry)) ? raw.entry
            : (typeof raw.url === 'string' && PATH_RE.test(raw.url) && /\.js$/i.test(raw.url) ? raw.url : '');
        if (!codePath || codePath.indexOf('..') !== -1) return null;
        item.entry = codePath;
        if (typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(raw.sha256)) item.sha256 = raw.sha256.toLowerCase();

        if (Array.isArray(raw.settings)) {
            const TYPES = ['text', 'password', 'select', 'number', 'switch'];
            const fields = raw.settings.filter((f) => f && ID_RE.test(str(f.key, 50))).slice(0, 12).map((f) => {
                const type = TYPES.indexOf(f.type) >= 0 ? f.type : 'text';
                const out = {
                    key: str(f.key, 50),
                    label: str(f.label, 40) || str(f.key, 50),
                    type: type,
                    placeholder: str(f.placeholder, 60),
                    hint: str(f.hint, 80)
                };
                if (type === 'switch') {
                    out.default = !!f.default;
                } else if (type === 'number') {
                    out.default = typeof f.default === 'number' ? f.default : 0;
                    if (typeof f.min === 'number') out.min = f.min;
                    if (typeof f.max === 'number') out.max = f.max;
                } else if (type === 'select') {
                    const opts = (Array.isArray(f.options) ? f.options : []).slice(0, 20).map((o) => {
                        if (o && typeof o === 'object') {
                            const value = str(o.value, 60);
                            if (!value) return null;
                            return { value: value, label: str(o.label, 40) || value };
                        }
                        const v = str(o, 60);
                        return v ? v : null;
                    }).filter(Boolean);
                    if (!opts.length) return null;          // 没有可选项的 select 直接丢掉
                    out.options = opts;
                    out.default = str(f.default, 60) || (typeof opts[0] === 'object' ? opts[0].value : opts[0]);
                } else {
                    out.default = str(f.default, 300);
                }
                return out;
            }).filter(Boolean);
            if (fields.length) item.settings = fields;
        }
        return item;
    }

    // 绝对路径拼到条目自己的源上（内置用 chrome-extension://，社区用 jsDelivr）
    function assetUrl(item, rel) {
        if (!rel) return '';
        if (item.__base) return item.__base + String(rel).replace(/^\.?\//, '');
        return chrome.runtime.getURL(rel);
    }

    // 样式表的红线检查：CSS 也能干坏事（外链追踪、老 IE 的 expression 之类）
    function cssProblem(css) {
        if (!css) return '样式为空';
        if (css.length > 65536) return '样式超过 64KB';
        // 先去注释再查，否则注释里提一句 @import 就被误杀了
        const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const banned = [/@import/i, /behavior\s*:/i, /expression\s*\(/i, /-moz-binding/i, /javascript\s*:/i, /<\/?script/i];
        for (let i = 0; i < banned.length; i++) {
            if (banned[i].test(body)) return '样式里含有被禁止的写法';
        }
        const urls = body.match(/url\(\s*['"]?[^)'"]*/gi) || [];
        for (let i = 0; i < urls.length; i++) {
            const v = urls[i].replace(/url\(\s*['"]?/i, '').trim();
            if (!/^data:/i.test(v)) return '样式引用了外部资源';
        }
        return '';
    }

    async function fetchJson(url, ms) {
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = setTimeout(() => { if (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } } }, ms || 5000);
        // raw.githubusercontent.com 的 max-age 是 300 秒，而且 GB 级代理/运营商可能缓存更久。
        // 光靠 cache:'no-store' 不能 100% 保证拿到新内容，所以再拼一个时间戳把 URL 本身变掉。
        const bust = /^https?:/i.test(url) ? (url + (url.indexOf('?') >= 0 ? '&' : '?') + '_pcb=' + Date.now()) : url;
        try {
            const res = await fetch(bust, ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async function fetchCommunity() {
        let lastErr = null;
        const bases = cdnBases();
        for (let i = 0; i < bases.length; i++) {
            const base = bases[i];
            try {
                const json = await fetchJson(base + 'workshop/community.json', 8000);
                const raw = Array.isArray(json && json.items) ? json.items : [];
                return { items: raw.slice(0, 200), base: base, updated: str(json && json.updated, 40), local: 0 };
            } catch (e) {
                lastErr = e;
                // 用 console.info 而不是 warn：源站偶尔抽风/超时属于正常降级，
                // 用 warn 会被 Chrome 记进 chrome://extensions 的「错误」页，吓到用户。
                const why = (e && e.name === 'AbortError') ? '请求超时' : ((e && e.message) || String(e));
                dbg('[pickcat-workshop] 该源暂不可用，换下一个：' + base + '（' + why + '）');
            }
        }
        // 六个源都挂了（或者仓库还没推上去）：退回扩展自带的 community.json，
        // 这样刚装上的用户也能立刻看到社区主题，等 CDN 通了再自动换成最新的
        try {
            const res = await fetch(chrome.runtime.getURL('workshop/community.json'));
            const json = await res.json();
            const raw = Array.isArray(json && json.items) ? json.items : [];
            dbg('[pickcat-workshop] 已回退到本地 community.json（' + raw.length + ' 条）');
            return { items: raw.slice(0, 200), base: '', updated: str(json && json.updated, 40), local: 1 };
        } catch (e) {
            throw lastErr || e;
        }
    }

    /* ---------------- 撤回表（revoked） ---------------- */

    // 维护者把条目 id 写进 workshop/revoked.json，客户端最多 10 分钟就能停用它。
    // 这是「事前审核」的替代品：宁可事后秒撤，也不让作者等一个周末。
    function sanitizeRevoked(json) {
        const out = {};
        const src = (json && json.items && typeof json.items === 'object') ? json.items : {};
        Object.keys(src).slice(0, 500).forEach((id) => {
            if (!ID_RE.test(id)) return;
            const v = src[id] || {};
            out[id] = { reason: str(v.reason, 120) || '维护者已下架该条目', at: str(v.at, 40) };
        });
        return out;
    }

    async function fetchRevoked() {
        const bases = cdnBases();
        for (let i = 0; i < bases.length; i++) {
            try {
                const json = await fetchJson(bases[i] + 'workshop/revoked.json', 6000);
                return { items: sanitizeRevoked(json), base: bases[i] };
            } catch (e) { /* 没这个文件、或者这个源挂了，试下一个 */ }
        }
        try {
            const res = await fetch(chrome.runtime.getURL('workshop/revoked.json'), { cache: 'no-store' });
            if (!res.ok) return null;
            return { items: sanitizeRevoked(await res.json()), base: 'local' };
        } catch (e) {
            return null;
        }
    }

    async function loadRevoked(force) {
        if (!force) {
            try {
                const cached = (await get([REVOKED_CACHE_KEY]))[REVOKED_CACHE_KEY];
                if (cached && cached.items) {
                    revoked = cached.items;
                    revokedAt = cached.at || 0;
                }
                if (cached && Date.now() - (cached.at || 0) < CATALOG_SOFT_TTL) return;
            } catch (e) { /* 缓存坏了就当没有 */ }
        }
        const got = await fetchRevoked();
        if (!got) return;   // 拉不到就沿用已有的，绝不因为网络问题把「下架」当成「恢复」
        revoked = got.items;
        revokedAt = Date.now();
        try {
            await set({ [REVOKED_CACHE_KEY]: { items: revoked, at: revokedAt } });
        } catch (e) { /* ignore */ }
        await enforceRevoked();
    }

    function isRevoked(id) {
        return !!(revoked && revoked[id]);
    }

    // 已装的东西被撤回了：插件停用 + 清 UI，主题还原
    async function enforceRevoked() {
        if (!state.installed) return;
        const hits = Object.keys(revoked || {}).filter((id) => state.installed[id]);
        if (!hits.length) return;
        let changed = false;
        for (let i = 0; i < hits.length; i++) {
            const id = hits[i];
            const rec = state.installed[id] || {};
            const info = revoked[id] || {};
            if (rec.revoked) continue;
            rec.revoked = true;
            rec.revokeReason = info.reason || '维护者已下架该条目';
            delete rec.enabled;
            changed = true;
            if (rec.type === 'plugin') {
                removePluginUi(id);
            }
            toast('⛔「' + (rec.name || id) + '」已被下架：' + rec.revokeReason, 9000);
        }
        if (changed) {
            await saveState();
            render();
        }
    }

    function applyCommunity(payload, builtinIds) {
        const kept = catalog.filter((i) => i.source !== 'community');
        const items = (payload.items || []).filter((i) => i && i.id && !builtinIds[i.id]);
        catalog = kept.concat(items);
        remoteMerged = items.length;
        remoteSyncedAt = payload.at || 0;
        remoteUpdated = payload.updated || '';
    }

    async function refreshCommunity(builtinIds) {
        try {
            const got = await fetchCommunity();
            const builtin = builtinIds || {};
            if (!builtinIds) {
                catalog.forEach((i) => { if (i.source !== 'community') builtin[i.id] = 1; });
            }
            const items = [];
            const seen = {};
            got.items.forEach((raw) => {
                const it = sanitizeItem(raw, got.base);
                if (!it) {
                    // 方便投稿者自查：坏条目会被静默丢掉，但控制台留个线索（info 不进错误页）
                    dbg('[pickcat-workshop] 丢弃不合格的社区条目：', raw && raw.id, raw && (raw.cssFile || raw.entry));
                    return;
                }
                if (seen[it.id] || builtin[it.id]) return;
                seen[it.id] = 1;
                items.push(it);
            });
            const payload = { at: Date.now(), base: got.base, updated: got.updated, local: got.local ? 1 : 0, items: items };
            applyCommunity(payload, builtin);
            await set({ [CATALOG_CACHE_KEY]: payload });
            await loadRevoked(true);
            render();
            dbg('[pickcat-workshop] 社区清单：源=' + got.base + ' updated=' + (got.updated || '-') + ' 条目=' + items.length +
                ' 已下架=' + Object.keys(revoked).length);
            return 'ok';
        } catch (e) {
            dbg('[pickcat-workshop] 社区清单拉取失败：', e && e.message || e);
            return 'fail';
        }
    }

    async function loadCatalog() {
        // 1) 内置清单：永远可用，社区挂了也不影响
        try {
            const res = await fetch(chrome.runtime.getURL('workshop/builtin.json'));
            const json = await res.json();
            catalog = (Array.isArray(json.items) ? json.items : []).map((i) => Object.assign({ source: 'builtin', __base: '' }, i));
        } catch (e) {
            catalog = [];
            toast('工坊清单加载失败：' + (e && e.message || e));
        }
        const builtinIds = {};
        catalog.forEach((i) => { builtinIds[i.id] = 1; });

        // 2) 社区清单：先用缓存，过期再拉（拉失败就静默只有内置）
        try {
            const cached = (await get([CATALOG_CACHE_KEY]))[CATALOG_CACHE_KEY];
            // 本地回退的缓存只信 30 分钟，之后就重试 CDN（万一只是网络抖动）
            const ttl = cached && cached.local ? CATALOG_LOCAL_TTL : CATALOG_TTL;
            if (cached && Array.isArray(cached.items) && Date.now() - (cached.at || 0) < ttl) {
                const stamped = cached.items.map((i) => Object.assign({ at: cached.at }, i));
                applyCommunity({ items: stamped, at: cached.at }, builtinIds);
                loadRevoked(false);   // 撤回表先读缓存，过期了它自己会去拉
                if (Date.now() - (cached.at || 0) > CATALOG_SOFT_TTL) refreshCommunity(builtinIds);
                return;
            }
        } catch (e) { /* 缓存坏了就当没有 */ }

        await refreshCommunity(builtinIds);
    }

    function itemById(id) {
        return catalog.find((i) => i.id === id) || null;
    }

    function isInstalled(id) {
        return !!(state.installed && state.installed[id]);
    }

    function runningCount() {
        if (state.safeMode) return 0;
        return Object.keys(state.installed).filter((id) => {
            const rec = state.installed[id];
            return rec.type === 'plugin' && rec.enabled !== false;
        }).length;
    }

    /* ---------------- 渲染 ---------------- */

    function matchFilter(item) {
        if (filterCat === 'all') return true;
        if (filterCat === 'theme') return item.type === 'theme';
        if (filterCat === 'plugin') return item.type === 'plugin' && item.category !== 'ai';
        if (filterCat === 'ai') return item.category === 'ai';
        return true;
    }

    function matchKeyword(item) {
        if (!keyword) return true;
        const hay = [item.name, item.desc, item.author, item.category, (item.permissions || []).join(' ')].join(' ').toLowerCase();
        return hay.indexOf(keyword.toLowerCase()) !== -1;
    }

    // 逐段比版本号：1.2.10 > 1.2.9（字符串比会错）
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

    // 装着的版本 < 清单里的版本 → 返回 { from, to }，否则 null
    function updateOf(item) {
        const rec = item && state.installed[item.id];
        if (!rec || !item.version || !rec.version) return null;
        if (cmpVersion(rec.version, item.version) >= 0) return null;
        return { from: rec.version, to: item.version };
    }

    function updateCount() {
        return catalog.filter((i) => !i.hidden && updateOf(i)).length;
    }

    /* ---------------- 条目图标 ----------------
     *
     * 图标三种写法：
     *   1. emoji（"🎃"）—— 零成本，兼容一切
     *   2. 官方图床直链 https://pickcat.dao3.fun/api/v1/files/<id>
     *      （只存引用不存图：仓库里不会有图片文件，也就不必为人家的图负责）
     *   3. data:image/...;base64 —— 小图内联，上限 26KB
     * 其它一律丢弃，回落到 emoji 或 📦。
     */
    const IMG_HOST_RE = /^https:\/\/pickcat\.dao3\.fun\/api\/v1\/files\/[A-Za-z0-9_-]{8,64}$/;
    const DATA_IMG_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

    function imgUrlOk(u) {
        return typeof u === 'string' && u.length <= 320 && IMG_HOST_RE.test(String(u).trim());
    }

    function iconSrcOf(item) {
        const ic = item && item.icon;
        if (typeof ic !== 'string' || !ic) return '';
        if (DATA_IMG_RE.test(ic) && ic.length <= 26000) return ic;
        if (imgUrlOk(ic)) return String(ic).trim();
        return '';
    }

    function iconHtml(item) {
        const src = iconSrcOf(item);
        if (src) {
            return '<span class="ws-emoji ws-ico"><img src="' + esc(src) +
                '" alt="" loading="lazy" referrerpolicy="no-referrer"></span>';
        }
        const ic = item && item.icon;
        const emo = (typeof ic === 'string' && ic && ic.length <= 4) ? ic : '';
        return '<span class="ws-emoji">' + esc(emo || (item && item.emoji) || '📦') + '</span>';
    }

    function badgeOf(item) {
        // 注意：这里刻意不出现「官方」二字。PICKCAT Plus 是第三方扩展，
        // 在 PICKCAT 站内把「官方」等同于点猫官方，容易被读成冒充。
        if (item.verified === 'official') return '<span class="ws-badge">✅ 内置</span>';
        if (item.verified === 'reviewed') return '<span class="ws-badge">✅ 已审核</span>';
        if (item.source === 'community') return '<span class="ws-badge warn">🌐 社区 · 未经审核</span>';
        return '<span class="ws-badge warn">⚠️ 未审核</span>';
    }

    /* ---------------- 沙盒等级（tier）----------------
     * 用户不需要理解「模式」，他只需要知道「这个包能干什么」。
     * 等级不是开发者自选的，是由他声明的能力推出来的 —— 声明不足就装不上，
     * 声明过头就自动掉进更低信任的档位。
     *   safe     ：主题 / 纯数据，碰不到页面，也不联网
     *   balanced ：能读页面、能改自己那一格（锚点内）、能联网到白名单
     *   free     ：能改写整页结构
     */
    const TIER_KEY = 'pickcat_ws_tier';
    const FREE_CONSENT_KEY = 'pickcat_ws_free_consent';
    const FREE_CONSENT_VERSION = 1;   // 协议内容有实质变化时才 +1，否则用户不必重签
    const TIERS = ['safe', 'balanced', 'free'];
    const TIER_INFO = {
        safe: { icon: '🟢', label: '安全', hint: '主题与纯数据插件，碰不到页面' },
        balanced: { icon: '🟡', label: '均衡', hint: '能读页面、能改编辑区，联网只走白名单' },
        free: { icon: '🔴', label: '自由', hint: '能改写整页结构，出事可能白屏' }
    };
    let currentTier = 'balanced';

    function tierOf(item) {
        if (!item) return 'safe';
        // 先按能力推一遍，再和清单声明取「更宽松」的那个：
        // 声明可以把自己降得更严格（更保守），但不能宣称自己更安全。
        let derived;
        if (item.type === 'theme') {
            derived = 'safe';                                  // 主题永远是纯数据
        } else {
            const perms = item.permissions || [];
            if (perms.indexOf('dom-global') >= 0) derived = 'free';
            else if (perms.indexOf('dom-read') >= 0 || perms.indexOf('dom-write') >= 0 ||
                perms.indexOf('ui-interaction') >= 0 || perms.indexOf('network') >= 0) derived = 'balanced';
            else derived = 'safe';
        }
        const declared = TIERS.indexOf(item.tier) >= 0 ? item.tier : derived;
        return TIERS.indexOf(declared) > TIERS.indexOf(derived) ? declared : derived;
    }

    function tierBadge(item) {
        const t = tierOf(item);
        const info = TIER_INFO[t];
        const cls = t === 'free' ? ' ws-badge tier-free' : '';
        return '<span class="ws-badge' + (t === 'free' ? ' tier-free' : '') + '">' + info.icon + ' ' + info.label + '</span>';
    }

    function tierHintText(t) {
        const info = TIER_INFO[t] || TIER_INFO.balanced;
        return info.icon + ' ' + info.label + '：' + info.hint;
    }

    function permsTags(item) {
        if (!item.permissions || !item.permissions.length) return '';
        return item.permissions.map((p) => {
            const d = WS_PERM_DEFS[p];
            const high = d && d.level === 'high' ? ' danger' : '';
            return `<span class="ws-tag${high}">${esc((d && d.icon) || '·')} ${esc(p)}</span>`;
        }).join('');
    }

    function modeTag(item) {
        const m = item.mode || 'any';
        if (m === 'any') return '';
        const cur = isDarkMode() ? 'dark' : 'light';
        const mismatch = cur !== m;
        const label = m === 'dark' ? '🌙 深色专用' : '☀️ 浅色专用';
        const tip = mismatch ? '当前页面是' + (cur === 'dark' ? '深色' : '浅色') + '模式，与该条目推荐的模式不一致'
            : '与当前页面配色匹配';
        return `<span class="ws-tag${mismatch ? ' warn' : ''}" title="${esc(tip)}">${label}${mismatch ? ' · 不匹配' : ''}</span>`;
    }

    function claimTags(item) {
        const n = (item.claims || []).length;
        if (!n) return '';
        return `<span class="ws-tag claim" title="安装后会接管你的 ${n} 项设置；卸载或点面板里的「释放」即恢复原值">🔒 接管 ${n} 项设置</span>`;
    }

    function cardHtml(item) {
        const inst = isInstalled(item.id);
        const rec = state.installed[item.id] || {};
        const rv = revoked[item.id] || null;
        const up = updateOf(item);
        // 没有 preview.bg 时，用主题自带的渐变直接画缩略图（零额外请求）
        const gradBg = /gradient\(/i.test(String((item.apply || {}).pickcatBgUrl || '')) ? item.apply.pickcatBgUrl : '';
        const previewBg = (item.preview && item.preview.bg) || gradBg;
        const preview = previewBg ? `<div class="ws-preview" style="background:${esc(previewBg)}"></div>` : '';
        const reportBtn = (item.source === 'community' && !rv)
            ? `<button class="ws-btn" data-act="report" data-id="${esc(item.id)}" title="内容有问题？先看原帖评论区（作者回得更快），再点这里去仓库举报">⚑</button>`
            : '';

        const upBtn = up
            ? `<button class="ws-btn primary" data-act="update" data-id="${esc(item.id)}" title="作者发布了 v${esc(up.to)}（你装的是 v${esc(up.from)}）。更新会保留你的设置，权限若有变化会让你再确认一次。">更新到 v${esc(up.to)}</button>`
            : '';
        let actions = '';
        if (rv) {
            actions = `<button class="ws-btn" disabled title="维护者已下架该条目：${esc(rv.reason)}">⛔ 已下架</button>` +
                (inst ? `<button class="ws-btn danger" data-act="uninstall" data-id="${esc(item.id)}">卸载</button>` : '');
        } else if (item.__broken) {
            actions = `<button class="ws-btn" disabled title="这个条目的文件已经被作者删除或改名，装不了；可以等作者修复或让作者重新投稿">⚠️ 资源缺失</button>`;
        } else if (!inst) {
            const need = tierOf(item);
            if (TIERS.indexOf(need) > TIERS.indexOf(currentTier)) {
                actions = `<button class="ws-btn" disabled title="这个条目需要「${TIER_INFO[need].label}」等级，先把上面的「允许安装」切过去">🔒 需要${TIER_INFO[need].icon} ${TIER_INFO[need].label}</button>` + reportBtn;
            } else {
                actions = `<button class="ws-btn primary" data-act="install" data-id="${esc(item.id)}">安装</button>` + reportBtn;
            }
        } else if (item.type === 'theme') {
            actions = upBtn + `<button class="ws-btn danger" data-act="uninstall" data-id="${esc(item.id)}">卸载</button>`;
        } else {
            const on = rec.enabled !== false;
            if (rec.crashed) {
                actions = upBtn + `<button class="ws-btn primary" data-act="revive" data-id="${esc(item.id)}" title="它上次因为死循环或无响应被强制停用了；确认没问题的话点这里重启">⚡ 已停用 · 重试</button>` +
                    `<button class="ws-btn danger" data-act="uninstall" data-id="${esc(item.id)}">卸载</button>`;
            } else if (rec.needsConfirm) {
                actions = upBtn + `<button class="ws-btn primary" data-act="reconfirm" data-id="${esc(item.id)}" title="作者更新了代码，需要你重新确认它申请的权限">🔐 代码已更新 · 重新确认</button>` +
                    `<button class="ws-btn danger" data-act="uninstall" data-id="${esc(item.id)}">卸载</button>`;
            } else {
                const freeBtn = tierOf(item) === 'free'
                    ? (rec.freeRun
                        ? `<button class="ws-btn" data-act="freeStop" data-id="${esc(item.id)}">停止运行</button>`
                        : `<button class="ws-btn primary" data-act="freeRun" data-id="${esc(item.id)}" title="自由档不会自动启动，需要你亲手点一下">手动运行</button>`)
                    : '';
                actions = upBtn + freeBtn +
                    `<button class="ws-btn" data-act="toggle" data-id="${esc(item.id)}">${on ? '停用' : '启用'}</button>` +
                    (item.settings ? `<button class="ws-btn" data-act="openPlugPage" data-id="${esc(item.id)}">设置</button>` : '') +
                    reportBtn +
                    `<button class="ws-btn danger" data-act="uninstall" data-id="${esc(item.id)}">卸载</button>`;
            }
        }

        const settings = ''; // 设置都在插件专属页里，卡片只留管理动作
        return `<div class="ws-card${rv ? ' ws-card-revoked' : ''}" data-card="${esc(item.id)}">
            <div class="ws-card-head">
                ${iconHtml(item)}
                <span class="ws-name">${esc(item.name)}</span>
                ${rv ? '<span class="ws-badge warn">⛔ 已下架</span>' : badgeOf(item)}
                ${up ? `<span class="ws-badge warn">可更新 ${esc(up.to)}</span>` : ''}
            </div>
            <div class="ws-author">by ${esc(item.author || '匿名')}</div>
            ${preview}
            <div class="ws-desc">${esc(item.desc || '')}${rv ? '<br><strong>下架原因：' + esc(rv.reason) + '</strong>' : ''}</div>
            <div class="ws-tags">${tierBadge(item)}${permsTags(item)}${modeTag(item)}${claimTags(item)}</div>
            <div class="ws-actions">${actions}</div>
            ${settings}
        </div>`;
    }

    /* ---------------- 插件专属设置页 ----------------
     * 装了带 settings 的插件，左侧导航会多一个属于它自己的 Tab。
     * 工坊 Tab 只留管理（启用/停用/卸载），细节都挪到插件自己的页面里。
     */

    function settingsFieldsHtml(item) {
        const saved = ((pluginData[item.id] || {}).settings) || {};
        return item.settings.map((f) => {
            const raw = saved[f.key];
            const v = raw !== undefined ? raw : (f.default !== undefined ? f.default : '');
            const label = '<label>' + esc(f.label || f.key) + '</label>';
            const hint = f.hint ? '<div class="plug-hint">' + esc(f.hint) + '</div>' : '';
            if (f.type === 'switch') {
                return '<label class="plug-switch"><input type="checkbox" data-field="' + esc(f.key) +
                    '" data-kind="bool" ' + (v ? 'checked' : '') + '><span>' + esc(f.label || f.key) + '</span></label>' + hint;
            }
            if (f.type === 'select') {
                const opts = (f.options || []).map((o) => {
                    const ov = typeof o === 'object' ? o.value : o;
                    const ol = typeof o === 'object' ? (o.label || o.value) : o;
                    return '<option value="' + esc(ov) + '" ' + (String(v) === String(ov) ? 'selected' : '') + '>' + esc(ol) + '</option>';
                }).join('');
                return label + '<select data-field="' + esc(f.key) + '">' + opts + '</select>' + hint;
            }
            if (f.type === 'number') {
                return label + '<input type="number" data-field="' + esc(f.key) + '" value="' + esc(v) + '" ' +
                    'min="' + (f.min !== undefined ? esc(f.min) : '') + '" max="' + (f.max !== undefined ? esc(f.max) : '') + '" ' +
                    'placeholder="' + esc(f.placeholder || '') + '">' + hint;
            }
            return label + '<input type="' + (f.type === 'password' ? 'password' : 'text') + '" data-field="' + esc(f.key) + '" ' +
                'value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '">' + hint;
        }).join('');
    }

    // 哪些插件该有专属页：已安装 + 是插件 + 清单里声明了 settings
    function pluginPageItems() {
        return Object.keys(state.installed).map(itemById).filter((it) => {
            return it && it.type === 'plugin' && it.settings && it.settings.length;
        });
    }

    function pluginPageHtml(item) {
        const rec = state.installed[item.id] || {};
        const on = rec.enabled !== false;
        const stateText = rec.crashed ? '已因无响应停用' : (on ? '运行中' : '已停用');
        return '<div class="row-card" data-card="' + esc(item.id) + '" style="flex-direction: column; align-items: stretch;">' +
            '<div class="plug-head">' + iconHtml(item) +
            '<div><div class="plug-name">' + esc(item.name) + '</div>' +
            '<div class="plug-meta">v' + esc(item.version || '?') + ' · ' + esc(item.author || '匿名') + ' · ' + esc(stateText) + '</div></div></div>' +
            '<p class="plug-note" style="margin-top:10px;">' + esc(item.desc || '') + '</p>' +
            '<div class="plug-form" style="margin-top:12px;">' + settingsFieldsHtml(item) +
            '<div class="plug-hint">改完自动保存，插件会立刻收到新值。Key 之类的东西只存在本机 chrome.storage。</div></div>' +
            '<div class="plug-actions">' +
            '<button class="ws-btn" data-act="toggle" data-id="' + esc(item.id) + '">' + (on ? '停用' : '启用') + '</button>' +
            '<button class="ws-btn danger" data-act="uninstall" data-id="' + esc(item.id) + '">卸载</button>' +
            '</div></div>';
    }

    // 把「已装插件」和左侧导航 / Tab 面对齐：多的删掉，少的补上
    function syncPluginTabs() {
        if (!wsRoot) return;
        const navBox = wsRoot.querySelector('.nav-inner') || wsRoot.querySelector('.nav-sidebar');
        const navAbout = navBox ? navBox.querySelector('.nav-item[data-tab="tab-about"]') : null;
        const area = wsRoot.querySelector('.content-area');
        if (!navBox || !area) return;

        const want = {};
        pluginPageItems().forEach((it) => { want[it.id] = it; });

        // 删掉不该存在的
        navBox.querySelectorAll('.nav-item[data-tab^="tab-plug-"]').forEach((n) => {
            const id = n.dataset.tab.slice('tab-plug-'.length);
            if (want[id]) return;
            n.remove();
        });
        area.querySelectorAll('.tab-content[id^="tab-plug-"]').forEach((p) => {
            const id = p.id.slice('tab-plug-'.length);
            if (want[id]) return;
            const wasActive = p.classList.contains('active');
            p.remove();
            if (wasActive) {
                const wk = wsRoot.querySelector('.nav-item[data-tab="tab-workshop"]');
                if (wk) {
                    wsRoot.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
                    wsRoot.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
                    wk.classList.add('active');
                    const pane = wsRoot.getElementById('tab-workshop');
                    if (pane) pane.classList.add('active');
                }
            }
        });

        // 补上该有的（插在「关于」之前）
        Object.keys(want).forEach((id) => {
            const item = want[id];
            if (!navBox.querySelector('.nav-item[data-tab="tab-plug-' + id + '"]')) {
                const nav = document.createElement('div');
                nav.className = 'nav-item';
                nav.dataset.tab = 'tab-plug-' + id;
                const src = iconSrcOf(item);
                nav.innerHTML = src
                    ? '<span class="nav-fig"><img src="' + esc(src) + '" referrerpolicy="no-referrer" alt=""></span>'
                    : '<span class="nav-fig">' + esc(item.emoji || '🧩') + '</span>';
                const txt = document.createElement('span');
                txt.className = 'nav-text';
                txt.textContent = item.name;
                nav.appendChild(txt);
                if (navAbout) navBox.insertBefore(nav, navAbout);
                else navBox.appendChild(nav);
            }
            if (!area.querySelector('.tab-content[id="tab-plug-' + id + '"]')) {
                const pane = document.createElement('div');
                pane.className = 'tab-content';
                pane.id = 'tab-plug-' + id;
                pane.innerHTML = pluginPageHtml(item);
                area.appendChild(pane);
            } else {
                // 值可能在别处改过（工坊卡片里也能改），进页面时刷一次
                const pane = area.querySelector('.tab-content[id="tab-plug-' + id + '"]');
                pane.innerHTML = pluginPageHtml(item);
            }
        });
    }

    // 从工坊卡片点「设置」→ 直接切到该插件的专属页
    function openPluginPage(id) {
        try { syncPluginTabs(); } catch (e) { /* ignore */ }
        if (!wsRoot) return;
        const nav = wsRoot.querySelector('.nav-item[data-tab="tab-plug-' + id + '"]');
        if (!nav) { toast('这个插件的设置页还没准备好，重新打开面板试试喵', 4000); return; }
        nav.click();
    }

    function onPluginTab(id) {
        syncPluginTabs();
        const item = itemById(id);
        if (!item) return;
        const pane = wsRoot && wsRoot.querySelector('.tab-content[id="tab-plug-' + id + '"]');
        if (pane) pane.innerHTML = pluginPageHtml(item);
    }

    // 已安装但清单里已经没有的条目（作者下架 / 目录被删），留一张卡片让它能被卸载    // 已安装但清单里已经没有的条目（作者下架 / 目录被删），留一张卡片让它能被卸载
    function ghostHtml(id) {
        const rec = state.installed[id] || {};
        const kind = rec.type === 'plugin' ? '插件' : '主题';
        return `<div class="ws-card" data-card="${esc(id)}">
            <div class="ws-card-head">
                <span class="ws-emoji">🗂</span>
                <span class="ws-name">${esc(rec.name || id)}</span>
                <span class="ws-badge warn">已下架</span>
            </div>
            <div class="ws-author">${esc(id)}</div>
            <div class="ws-desc">这个${kind}已经不在清单里了，但本机还留着它写过的设置。卸载会把它们还原。</div>
            <div class="ws-actions"><button class="ws-btn danger" data-act="uninstall" data-id="${esc(id)}">卸载</button></div>
        </div>`;
    }

    function render() {
        if (!els.grid) return;
        const kw = keyword;
        // hidden 的条目不在列表里露出（留作开发自测；已装的照常运行，卸载后也不会变成「已下架」）
        // 这个 tab 现在是「已安装」管理页：只列装过的东西，逛新东西去 workshop.html
        const list = catalog.filter((i) => !i.hidden && isInstalled(i.id) && matchFilter(i) && matchKeyword(i));
        const ghosts = [];
        if (!kw) {
            const known = {};
            catalog.forEach((i) => { known[i.id] = true; });
            Object.keys(state.installed).forEach((id) => { if (!known[id]) ghosts.push(id); });
        }
        els.grid.innerHTML = (list.length || ghosts.length)
            ? list.map(cardHtml).join('') + ghosts.map(ghostHtml).join('')
            : '<div class="ws-empty">还没有装任何东西喵<br>点上面的「打开创意工坊」去逛逛</div>';
        // 侧栏「插件专属页」跟着安装状态走
        try { syncPluginTabs(); } catch (e) { /* ignore */ }

        const upsAll = updateCount();
        if (els.updateAll) {
            els.updateAll.style.display = upsAll ? 'block' : 'none';
            els.updateAll.textContent = `更新全部（${upsAll} 个）`;
        }

        const total = Object.keys(state.installed).length;
        let line = `已安装 ${total} 个 · 运行中 ${runningCount()} 个`;
        if (remoteMerged) {
            const mins = remoteSyncedAt ? Math.max(0, Math.round((Date.now() - remoteSyncedAt) / 60000)) : -1;
            line += ` · 🌐 社区 ${remoteMerged} 个` + (mins >= 0 ? `（${mins} 分钟前同步）` : '');
            if (remoteUpdated) line += ` · 清单 ${String(remoteUpdated).slice(0, 16).replace('T', ' ')}`;
        }
        const ups = upsAll;
        if (ups) line += ` · 可更新 ${ups} 个`;
        els.status.textContent = line;
        els.safeMode.checked = !!state.safeMode;
        const claimIds = catalog.filter((i) => i.claims && i.claims.length).map((i) => i.id).join(',') || '(无)';
        dbg('[pickcat-workshop] 渲染：条目 ' + catalog.length + ' 个 · 带接管声明 ' + claimIds);

        Array.prototype.forEach.call(els.chips.children, (c) => {
            c.classList.toggle('active', c.dataset.filter === filterCat);
        });
    }

    /* ---------------- 权限确认 ---------------- */

    /* ---------- 免责协议（首次进工坊 / 首次装插件必须签） ---------- */
    let consentPromise = null;
    let consentModal = null;
    let freeModal = null;
    let hintShown = false;

    function readConsent() {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get([CONSENT_KEY], (res) => {
                    if (chrome.runtime.lastError) return resolve(false);
                    const c = (res && res[CONSENT_KEY]) || null;
                    resolve(!!(c && c.v >= CONSENT_VERSION));
                });
            } catch (e) { resolve(false); }
        });
    }

    function ensureConsent() {
        // 同一次会话里多次调用只问一次
        if (consentPromise) return consentPromise;
        consentPromise = readConsent().then((ok) => {
            if (ok) return true;
            return new Promise((resolve) => showConsent(resolve));
        }).then((ok) => {
            consentPromise = null;
            return ok;
        });
        return consentPromise;
    }

    // 自由档是「需要被反复提醒」的档位：授权 24 小时有效，
    // 过期就重新弹一次确认 —— 免得用户某天忘了自己开过、插件一直在动整页。
    const FREE_CONSENT_TTL = 24 * 60 * 60 * 1000;

    function readFreeConsent() {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get([FREE_CONSENT_KEY], (res) => {
                    if (chrome.runtime.lastError) return resolve(false);
                    const c = (res && res[FREE_CONSENT_KEY]) || null;
                    if (!c || c.v < FREE_CONSENT_VERSION) return resolve(false);
                    resolve(Date.now() - (c.at || 0) < FREE_CONSENT_TTL);
                });
            } catch (e) { resolve(false); }
        });
    }

    function showConsent(done) {
        if (consentModal) {
            consentModal.__done = done;
            consentModal.classList.add('open');
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'ws-modal ws-consent';
        wrap.innerHTML = `<div class="ws-modal-card" style="max-width:520px">
            <h3 class="ws-modal-title">⚠️ 这个插件会跑代码</h3>
            <p class="ws-modal-sub">只有插件需要这一步 —— <b>主题是纯数据，装主题不会弹这个</b>。签一次就够，以后不再问你。</p>
            <div class="ws-perm-list">
                <div class="ws-perm"><span>📜</span><span class="ws-perm-txt"><b>它跑在隔离的沙盒里</b><br>看不到你的账号、Cookie、输入框，也读不到网页内容。</span></div>
                <div class="ws-perm"><span>🛡</span><span class="ws-perm-txt"><b>几个硬底线</b><br>沙盒物理断网（联网只能走我们代发 + 必须申报域名）；死循环 12 秒掐掉；代码一改就重新确认；随时能卸载或一键全停。</span></div>
                <div class="ws-perm high"><span>⚠️</span><span class="ws-perm-txt"><b>挡不住的</b><br>我们没法逐行人工审核。插件可以在<b>它申报的域名</b>范围内把内容发出去（比如你填的 API Key）。所以：只装你愿意相信的作者，别填输不起的东西。</span></div>
            </div>
            <label class="ws-consent-check">
                <input type="checkbox" id="wsConsentBox">
                <span>我已阅读并理解以上内容，自愿承担使用第三方插件的风险。</span>
            </label>
            <div class="ws-modal-foot">
                <button class="ws-btn" data-consent="no">先不用了</button>
                <button class="ws-btn primary" data-consent="yes" id="wsConsentOk" disabled>同意并继续</button>
            </div>
        </div>`;
        shadow.appendChild(wrap);
        const box = wrap.querySelector('#wsConsentBox');
        const okBtn = wrap.querySelector('#wsConsentOk');
        box.addEventListener('change', () => { okBtn.disabled = !box.checked; });
        wrap.addEventListener('click', (ev) => {
            const act = ev.target && ev.target.dataset && ev.target.dataset.consent;
            if (act !== 'yes' && act !== 'no') return;
            if (act === 'yes' && !box.checked) return;
            wrap.classList.remove('open');
            box.checked = false;
            okBtn.disabled = true;
            if (act === 'yes') {
                try {
                    chrome.storage.local.set({ [CONSENT_KEY]: { v: CONSENT_VERSION, at: Date.now() } });
                } catch (e) { /* 记不住就下次再问，不阻断使用 */ }
            }
            const fn = wrap.__done;
            wrap.__done = null;
            if (fn) fn(act === 'yes');
        });
        wrap.__done = done;
        consentModal = wrap;
        wrap.classList.add('open');
    }

    /* ---------------- 自由模式免责协议 ----------------
     * 这是整个扩展里唯一一处「用户可以让安全等级变低」的入口，
     * 所以刻意做得很啰嗦：三段警告 + 两个勾选 + 手打「自由」两个字。
     * 不是为了让用户点不到，是为了让「随手点一下」这个路径不存在。
     */
    function showFreeDisclaimer(done) {
        if (freeModal) {
            freeModal.__done = done;
            freeModal.classList.add('open');
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'ws-modal ws-consent ws-free-consent';
        wrap.innerHTML = `<div class="ws-modal-card" style="max-width:540px">
            <h3 class="ws-modal-title" style="color:#ef4444">🔴 开启「自由模式」之前，请先读完</h3>
            <p class="ws-modal-sub">自由模式会让第三方代码<b>改写整个页面的结构</b>。它不是「更高级的均衡模式」，是「把护栏拆掉」。</p>
            <div class="ws-perm-list">
                <div class="ws-perm high"><span>1️⃣</span><span class="ws-perm-txt"><b>它能改的是整个页面，不只是它自己那一格。</b><br>顶栏、卡片网格、弹窗层级，全都可以动。做得好是「换了一身皮肤」，做得不好是<b>白屏、按钮点不动、输入框消失</b>。</span></div>
                <div class="ws-perm high"><span>2️⃣</span><span class="ws-perm-txt"><b>我们只保证「能救回来」，不保证「不出事」。</b><br>插件仍在沙盒里跑，死循环 12 秒会被掐掉、随时能一键停用 —— 但一页已经崩掉的时候，你第一反应还是刷新。</span></div>
                <div class="ws-perm high"><span>3️⃣</span><span class="ws-perm-txt"><b>除非你知道自己在做什么，或者你确实需要某个「只有自由模式才能用」的包，否则不要开。</b><br>换主题、加个提示按钮、让 AI 总结一下帖子 —— 均衡模式就够了，一点不少。</span></div>
            </div>
            <label class="ws-consent-check">
                <input type="checkbox" id="wsFreeA">
                <span>我明白上面的风险，出了问题我自己负责。</span>
            </label>
            <label class="ws-consent-check" style="display:block">
                <span>请手动输入「<b>自由</b>」两个字确认（不是复制，是打字）：</span>
                <input type="text" id="wsFreeC" placeholder="自由" autocomplete="off"
                    style="margin-top:6px; width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg-card); color:var(--text-main);">
            </label>
            <p class="ws-modal-sub" style="margin:10px 0 0; font-size:12px; opacity:.85">签这一次就够了，以后切换自由模式不会再问你。协议内容有实质改动时才会重新确认。</p>
            <div class="ws-modal-foot">
                <button class="ws-btn" data-free="no">算了，用均衡模式</button>
                <button class="ws-btn" data-free="yes" id="wsFreeOk" disabled
                    style="background:#ef4444; border-color:#ef4444; color:#fff;">我确定，开启自由模式</button>
            </div>
        </div>`;
        shadow.appendChild(wrap);
        const a = wrap.querySelector('#wsFreeA');
        const c = wrap.querySelector('#wsFreeC');
        const okBtn = wrap.querySelector('#wsFreeOk');
        const refresh = () => { okBtn.disabled = !(a.checked && c.value.trim() === '自由'); };
        a.addEventListener('change', refresh);
        c.addEventListener('input', refresh);
        wrap.addEventListener('click', (ev) => {
            const act = ev.target && ev.target.dataset && ev.target.dataset.free;
            if (act !== 'yes' && act !== 'no') return;
            if (act === 'yes' && okBtn.disabled) return;
            wrap.classList.remove('open');
            a.checked = false; c.value = ''; okBtn.disabled = true;
            const fn = wrap.__done;
            wrap.__done = null;
            if (fn) fn(act === 'yes');
        });
        wrap.__done = done;
        freeModal = wrap;
        wrap.classList.add('open');
    }

    function syncTierUI() {
        if (!els.tier) return;
        els.tier.value = currentTier;
        els.tier.classList.toggle('free-on', currentTier === 'free');
        if (els.tierHint) els.tierHint.textContent = tierHintText(currentTier);
    }

    async function applyTier(t, justSigned) {
        currentTier = TIERS.indexOf(t) >= 0 ? t : 'balanced';
        try { await set({ [TIER_KEY]: currentTier }); } catch (e) { /* 存不下也不影响本次会话 */ }
        syncTierUI();
        render();
        if (currentTier === 'free') {
            // 已经签过协议的人不必每次都被念一遍，只留一句轻提示
            toast(justSigned
                ? '🔴 自由模式已开启。用完记得切回「均衡」；这个授权 24 小时后会自动作废，届时再开要重签一次。'
                : '🔴 自由模式已开启（协议你已经签过了）。', justSigned ? 9000 : 5000);
        } else if (currentTier === 'safe') {
            toast('🟢 已切到「安全」等级：只能装主题和纯数据插件。', 6000);
        }
    }

    function setTier(t) {
        if (TIERS.indexOf(t) < 0) t = 'balanced';
        if (t === currentTier) { syncTierUI(); return; }
        if (t === 'free') {
            readFreeConsent().then((signed) => {
                // 签过一次就永久记住（按协议版本号判断，协议改了才重新问）
                if (signed) { applyTier('free', false); return; }
                showFreeDisclaimer((ok) => {
                    if (!ok) { syncTierUI(); return; }
                    try {
                        chrome.storage.local.set({ [FREE_CONSENT_KEY]: { v: FREE_CONSENT_VERSION, at: Date.now() } });
                    } catch (e) { /* 记不住就下次再问，不阻断 */ }
                    applyTier('free', true);
                });
            });
            return;
        }
        applyTier(t);
    }

    function ensureTierAllows(item) {
        const need = tierOf(item);
        if (TIERS.indexOf(need) <= TIERS.indexOf(currentTier)) return true;
        const info = TIER_INFO[need];
        toast('「' + (item.name || item.id) + '」需要「' + info.icon + ' ' + info.label + '」等级才能安装。当前是「' +
            TIER_INFO[currentTier].icon + ' ' + TIER_INFO[currentTier].label + '」。', 7000);
        return false;
    }

    function ensureModal() {
        if (els.modal) return els.modal;
        const wrap = document.createElement('div');
        wrap.className = 'ws-modal';
        wrap.innerHTML = `<div class="ws-modal-card">
            <h3 class="ws-modal-title"></h3>
            <p class="ws-modal-sub"></p>
            <div class="ws-perm-list"></div>
            <div class="ws-modal-foot">
                <button class="ws-btn" data-modal="cancel">取消</button>
                <button class="ws-btn primary" data-modal="ok">信任并安装</button>
            </div>
        </div>`;
        shadow.appendChild(wrap);
        wrap.addEventListener('click', (ev) => {
            const act = ev.target && ev.target.dataset && ev.target.dataset.modal;
            if (!act) return;
            wrap.classList.remove('open');
            if (pendingConfirm) {
                const fn = pendingConfirm;
                pendingConfirm = null;
                fn(act === 'ok');
            }
        });
        els.modal = wrap;
        els.modalTitle = wrap.querySelector('.ws-modal-title');
        els.modalSub = wrap.querySelector('.ws-modal-sub');
        els.modalList = wrap.querySelector('.ws-perm-list');
        return wrap;
    }

    function confirmInstall(item, opts) {
        const upd = (opts && opts.isUpdate) ? opts : null;
        // 主题是纯数据（CSS + 几条设置），不跑代码，就不该让用户签一份「代码风险」协议。
        // 只有真正会执行 JS 的插件才需要那一次确认，而且签一次就够了。
        if (item.type === 'theme') return Promise.resolve(true);
        return ensureConsent().then((agree) => {
            if (!agree) return false;
            return new Promise((resolve) => {
            const modal = ensureModal();
            els.modalTitle.textContent = upd
                ? `更新「${item.name}」到 v${item.version}`
                : `安装「${item.name}」`;
            els.modalSub.textContent = upd
                ? (upd.permsChanged
                    ? '新版本申请的权限和之前不一样了，请先看清楚再更新。你的设置会保留，不会从零开始。'
                    : '代码换新了，权限没有变化。你的设置会保留；更新后会重新加载插件。')
                : (item.type === 'theme'
                    ? '这是一个主题包，纯数据、不含代码，会覆盖你当前的背景/指针设置（卸载时会还原）。'
                    : '这是一个功能插件，代码将运行在受限沙盒里。它申请了以下能力：');

            // 更新时权限变多了，单独顶一条红块（比藏在列表里显眼）
            const permBump = (upd && upd.permsChanged)
                ? `<div class="ws-perm high"><span>⚠️</span><span class="ws-perm-txt"><b>权限有变化</b><br>` +
                  `这个版本的权限声明与你装的那一版不同，请对照下面的清单再决定。</span></div>`
                : '';

            const communityWarn = (item.source === 'community' && !item.trusted)
                ? `<div class="ws-perm high"><span>🌐</span><span class="ws-perm-txt"><b>社区内容，非官方</b><br>来自社区作者「${esc(item.author)}」，我们只做了自动检查，没有人工逐行审核。出问题请在工坊里卸载。</span></div>`
                : '';

            // 非社区条目也把作者写出来（社区块里已经带了作者，不重复）
            const authorBlock = ((item.source !== 'community' || item.trusted) && item.author)
                ? `<div class="ws-perm"><span>✍️</span><span class="ws-perm-txt">作者：${esc(item.author)}</span></div>`
                : '';

            // 明暗模式不匹配提醒
            let modeWarn = '';
            if (item.mode === 'dark' || item.mode === 'light') {
                const cur = isDarkMode() ? 'dark' : 'light';
                if (cur !== item.mode) {
                    modeWarn = `<div class="ws-perm high"><span>${item.mode === 'dark' ? '🌙' : '☀️'}</span>` +
                        `<span class="ws-perm-txt"><b>配色可能不搭</b><br>你当前是${cur === 'dark' ? '深色' : '浅色'}模式，` +
                        `这个条目是给${item.mode === 'dark' ? '深色' : '浅色'}模式做的。装上去可能看不清文字，照样能装。</span></div>`;
                }
            }

            // 安装后会接管的设置项
            const claimBlock = (item.claims || []).length
                ? `<div class="ws-perm claim"><span>🔒</span><span class="ws-perm-txt"><b>安装后会被接管的设置（${item.claims.length} 项）</b><br>` +
                  item.claims.map((c) => '· ' + esc(c.label) + (c.reason ? '（' + esc(c.reason) + '）' : '')).join('<br>') +
                  '<br>原值不会被覆盖，卸载后自动恢复。</span></div>'
                : '';

            if (item.type === 'theme') {
                els.modalList.innerHTML = permBump + authorBlock + communityWarn + modeWarn + claimBlock + '<div class="ws-perm"><span class="ws-perm-txt">🎨 修改背景图 / 遮罩 / 鼠标指针</span></div>';
            } else {
                const perms = (item.permissions || []).map((p) => {
                    const d = WS_PERM_DEFS[p] || { level: 'low', icon: '·', label: p, desc: '' };
                    const cls = d.level === 'high' ? ' high' : '';
                    return `<div class="ws-perm${cls}"><span>${esc(d.icon)}</span>` +
                        `<span class="ws-perm-txt"><b>${esc(d.label)}</b><br>${esc(d.desc)}</span></div>`;
                }).join('');
                const hosts = (item.hosts || []).length
                    ? `<div class="ws-perm high"><span>🌐</span><span class="ws-perm-txt"><b>可访问的域名</b><br>${esc(item.hosts.join('、'))}</span></div>`
                    : '';
                els.modalList.innerHTML = permBump + authorBlock + communityWarn + modeWarn + claimBlock + perms + hosts;
            }

                    pendingConfirm = resolve;
                    modal.classList.add('open');
                });
        });
    }

    /* ---------------- 主题装饰件（decor：声明式，不开放 DOM） ----------------
     * 主题是纯数据，不能往页面里塞节点 —— 但「四角蛛网」「点赞飞散粒子」这类
     * 装饰又确实需要节点。折中办法：节点由扩展自己造，主题只能从能力目录里
     * 挑零件 + 调参数（颜色 / 透明度 / 有没有表情）。这样既拿回了观感，
     * 又不会让一份 CSS 包获得往页面注入任意 HTML 的能力。
     */

    const DECOR_LAYER_ID = 'pickcat-decor';
    const DECOR_STYLE_ID = 'pickcat-decor-style';

    // 左下角蛛网 + 蜘蛛的原始画法，取自 Helen.S 的万圣节主题（n 边形蛛网 + 垂吊蜘蛛）
    const DECOR_WEB_SVG = `
        <g stroke="__COLOR__" stroke-width="1.5" fill="none" stroke-linecap="round">
            <line x1="0" y1="250" x2="250" y2="250"/>
            <line x1="0" y1="250" x2="190" y2="64"/>
            <line x1="0" y1="250" x2="106" y2="22"/>
            <line x1="0" y1="250" x2="42" y2="150"/>
            <line x1="0" y1="250" x2="150" y2="205"/>
            <line x1="0" y1="250" x2="92" y2="118"/>
            <line x1="0" y1="250" x2="30" y2="60"/>
            <circle cx="0" cy="250" r="52"/>
            <circle cx="0" cy="250" r="104"/>
            <circle cx="0" cy="250" r="156"/>
            <circle cx="0" cy="250" r="208"/>
            <circle cx="0" cy="250" r="250"/>
        </g>`;

    const DECOR_WEB_EMOJI = `
        <g text-anchor="middle" dominant-baseline="central">
            <line x1="138" y1="150" x2="138" y2="158" stroke="__COLOR__" stroke-width="1" opacity=".85"/>
            <text x="138" y="163" font-size="16">🎃</text>
            <line x1="80" y1="100" x2="80" y2="108" stroke="__COLOR__" stroke-width="1" opacity=".85"/>
            <text x="80" y="113" font-size="14">👻</text>
            <line x1="178" y1="196" x2="178" y2="204" stroke="__COLOR__" stroke-width="1" opacity=".85"/>
            <text x="178" y="209" font-size="13">🍬</text>
        </g>`;

    const DECOR_SPIDER = `
        <g class="pc-spider">
            <line x1="0" y1="0" x2="0" y2="14" stroke="__COLOR__" stroke-width="1" opacity=".8"/>
            <g transform="translate(0 14)">
                <circle r="3.2" fill="#1c0d30" stroke="#4a2a73" stroke-width="0.8"/>
                <circle cy="3.4" r="4.6" fill="#241038" stroke="#4a2a73" stroke-width="0.8"/>
                <g stroke="#241038" stroke-width="1.1" stroke-linecap="round">
                    <line x1="-2.5" y1="1.5" x2="-7" y2="-2"/>
                    <line x1="-3.5" y1="2.5" x2="-8.5" y2="1"/>
                    <line x1="-3.5" y1="4" x2="-8.5" y2="5"/>
                    <line x1="-2.5" y1="5.5" x2="-6.5" y2="8.5"/>
                    <line x1="2.5" y1="1.5" x2="7" y2="-2"/>
                    <line x1="3.5" y1="2.5" x2="8.5" y2="1"/>
                    <line x1="3.5" y1="4" x2="8.5" y2="5"/>
                    <line x1="2.5" y1="5.5" x2="6.5" y2="8.5"/>
                </g>
            </g>
        </g>`;

    // 能力目录：键名就是清单里可以写的东西，别的一律拒绝
    const DECOR_PARTS = {
        'corner-web': {
            label: '四角蛛网 + 垂吊蜘蛛',
            need: [],
            build: function (opt) {
                const color = typeof opt.color === 'string' && /^[#a-zA-Z0-9(),.%\s]{3,40}$/.test(opt.color)
                    ? opt.color : 'rgba(210, 182, 250, 0.72)';
                const emoji = opt.emoji !== false;
                const outer = document.createElement('div');
                outer.className = 'pc-decor-layer';
                outer.setAttribute('aria-hidden', 'true');
                ['l', 'r'].forEach((side) => {
                    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    svg.setAttribute('viewBox', '0 0 250 250');
                    svg.setAttribute('width', '150');
                    svg.setAttribute('height', '150');
                    svg.setAttribute('class', 'pc-decor-web ' + side);
                    const body = DECOR_WEB_SVG.replace(/__COLOR__/g, color)
                        + (emoji ? DECOR_WEB_EMOJI.replace(/__COLOR__/g, color) : '')
                        + (side === 'l'
                            ? '<g transform="translate(88 52) scale(0.9)">' + DECOR_SPIDER.replace(/__COLOR__/g, color) + '</g>'
                            : '<g transform="translate(162 52) scale(-0.9 0.9)">' + DECOR_SPIDER.replace(/__COLOR__/g, color) + '</g>');
                    svg.innerHTML = body;
                    outer.appendChild(svg);
                });
                if (typeof opt.opacity === 'number') {
                    outer.style.opacity = String(Math.max(0, Math.min(1, opt.opacity)));
                }
                return outer;
            }
        }
    };

    function ensureDecorStyle() {
        if (document.getElementById(DECOR_STYLE_ID)) return;
        const st = document.createElement('style');
        st.id = DECOR_STYLE_ID;
        st.textContent = [
            '#' + DECOR_LAYER_ID + '{position:fixed;inset:0;pointer-events:none;z-index:2147482000;overflow:hidden}',
            '#' + DECOR_LAYER_ID + ' .pc-decor-layer{position:absolute;inset:0}',
            '#' + DECOR_LAYER_ID + ' .pc-decor-web{position:absolute;bottom:-6px;width:150px;height:150px}',
            '#' + DECOR_LAYER_ID + ' .pc-decor-web.l{left:-6px;transform-origin:0% 100%}',
            '#' + DECOR_LAYER_ID + ' .pc-decor-web.r{right:-6px;transform:scaleX(-1);transform-origin:100% 100%}',
            '#' + DECOR_LAYER_ID + ' .pc-spider{transform-origin:0 0;animation:pickcatSpiderSwing 7s ease-in-out infinite}',
            '@keyframes pickcatSpiderSwing{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}',
            '@media (max-width:640px){#' + DECOR_LAYER_ID + ' .pc-decor-web{width:104px;height:104px}}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // 把条目里的 decor 声明变成节点；不合法的一律忽略，绝不因此装不上主题
    function applyDecor(item) {
        removeDecor();
        if (!item || !item.decor || !item.decor.length) return;
        ensureDecorStyle();
        const layer = document.createElement('div');
        layer.id = DECOR_LAYER_ID;
        layer.setAttribute('aria-hidden', 'true');
        item.decor.forEach((raw) => {
            const opt = (typeof raw === 'string') ? { type: raw } : (raw || {});
            const part = DECOR_PARTS[opt.type];
            if (!part) return;
            try {
                layer.appendChild(part.build(opt));
            } catch (e) {
                dbg('[pickcat] 装饰件 ' + opt.type + ' 渲染失败：', e && e.message);
            }
        });
        if (!layer.childNodes.length) return;
        (document.body || document.documentElement).appendChild(layer);
    }

    function removeDecor() {
        const layer = document.getElementById(DECOR_LAYER_ID);
        if (layer) layer.remove();
        const st = document.getElementById(DECOR_STYLE_ID);
        if (st) st.remove();
    }

    /* ---------------- 主题皮肤（纯 CSS 皮肤包） ---------------- */

    const SKIN_STYLE_ID = 'pickcat-ws-theme-style';
    let skinCssCache = null;

    function skinClassOf(item) {
        return item && item.htmlClass ? item.htmlClass : 'pickcat-theme-' + String(item ? item.id : '').replace(/^theme[-_]/i, '');
    }

    function removeSkin() {
        const styleTag = document.getElementById(SKIN_STYLE_ID);
        if (styleTag) styleTag.remove();
        const active = state.skin;
        if (active && active.cls) document.documentElement.classList.remove(active.cls);
        removeDecor();
        bgThemeStrip = false;
        syncBgStrip();
        state.skin = null;
        activeThemeMode = 'any';
        activeThemeName = '';
    }

    async function fetchSkinCss(item) {
        if (item.css) return String(item.css);
        if (!item.cssFile) return '';
        if (skinCssCache && skinCssCache.id === item.id) return skinCssCache.css;
        const url = assetUrl(item, item.cssFile);
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const raw = await res.text();
        const bad = cssProblem(raw);
        if (bad) throw new Error(bad);
        // 防止样式表里塞 </style> 提前闭合标签
        skinCssCache = { id: item.id, css: raw.replace(/<\/style/gi, '<\\/style') };
        return skinCssCache.css;
    }

    async function applySkin(item) {
        if (!item) return true;
        let css = '';
        if (item.css || item.cssFile) {
            try {
                css = await fetchSkinCss(item);
            } catch (e) {
                console.warn('[pickcat] 主题样式加载失败：', e);
                toast('「' + item.name + '」的样式表加载失败');
                return false;
            }
        }
        // 换主题前先把上一套（样式表 / 类名 / 装饰件）全摘掉，
        // 否则从「带 CSS 的主题」切到「只有配色或装饰的主题」会留一堆残影
        removeSkin();
        if (css) {
            const styleTag = document.createElement('style');
            styleTag.id = SKIN_STYLE_ID;
            styleTag.textContent = css;
            (document.head || document.documentElement).appendChild(styleTag);
        }
        const cls = skinClassOf(item);
        document.documentElement.classList.add(cls);
        applyDecor(item);
        // 主题自带整页背景时，帮它把站点那层不透明外壳扒掉（否则背景被盖住）
        bgThemeStrip = !!item.pageBackground;
        syncBgStrip();
        state.skin = { id: item.id, cls: cls };
        // 记住这套皮肤的配色倾向，供 syncShadowTheme 做「模式不搭」提醒
        activeThemeMode = item.mode || 'any';
        activeThemeName = item.name || '';
        themeModeWarned = false;
        return true;
    }

    /* ---------------- 安装 / 卸载 ---------------- */

    // 把插件的 claims 登记进租约栈（后装的优先），不覆盖用户原值
    async function pushClaims(item) {
        if (!item.claims || !item.claims.length) return;
        const res = await get([CLAIMS_KEY]);
        const claims = (res[CLAIMS_KEY] && typeof res[CLAIMS_KEY] === 'object') ? res[CLAIMS_KEY] : {};
        item.claims.forEach((c) => {
            const arr = Array.isArray(claims[c.key]) ? claims[c.key].filter((x) => x && x.id !== item.id) : [];
            if (arr.length >= CLAIM_MAX_PER_KEY) return;   // 抢的插件太多，这一项就不接了
            arr.push({ id: item.id, name: item.name, value: c.value, label: c.label, at: Date.now() });
            claims[c.key] = arr;
        });
        await set({ [CLAIMS_KEY]: claims });
    }

    // 撕掉某个插件的全部租约
    async function dropClaims(id) {
        const res = await get([CLAIMS_KEY]);
        const claims = (res[CLAIMS_KEY] && typeof res[CLAIMS_KEY] === 'object') ? res[CLAIMS_KEY] : {};
        let changed = false;
        Object.keys(claims).forEach((k) => {
            const arr = Array.isArray(claims[k]) ? claims[k] : [];
            const next = arr.filter((x) => !(x && x.id === id));
            if (next.length !== arr.length) {
                changed = true;
                if (next.length) claims[k] = next; else delete claims[k];
            }
        });
        if (changed) await set({ [CLAIMS_KEY]: claims });
    }

    async function install(item, opts) {
        // 等级闸门：低等级模式下不许装高等级包（比弹窗里再确认一次更硬）
        if (!ensureTierAllows(item)) return;
        // 从整页工坊调过来时，确认弹窗已经在那一边弹过了（这边弹用户看不见）
        if (!opts || !opts.skipConfirm) {
            const ok = await confirmInstall(item);
            if (!ok) return;
        }

        if (item.type === 'theme') {
            const keys = Object.keys(item.apply || {});
            // 更新时沿用上一次记录的「原生值」，否则会把主题自己的值当成原值存下来
            let prev = (opts && opts.keepPrev) || null;
            if (!prev) {
                const prevRes = await get(keys);
                prev = {};
                keys.forEach((k) => { prev[k] = prevRes[k]; });
            }
            await set(item.apply || {});
            const skinOk = await applySkin(item);
            if (!skinOk) {
                // 样式表 404 / 被删：标成「资源缺失」，卡片上直接提示，别让人反复点
                item.__broken = true;
                render();
                // 样式表没加载 / 没过审：别把设置改到半截状态
                const back = {};
                Object.keys(prev).forEach((k) => { back[k] = prev[k] === undefined ? '' : prev[k]; });
                if (Object.keys(back).length) await set(back);
                loadAllConfigs();
                return;
            }
            state.installed[item.id] = { type: 'theme', version: item.version, name: item.name, prev: prev, claimVer: item.version, at: Date.now() };
        } else {
            state.installed[item.id] = {
                type: 'plugin',
                version: item.version,
                name: item.name,
                enabled: true,
                permissions: item.permissions || [],
                hosts: item.hosts || [],
                claimVer: item.version,
                at: Date.now()
            };
            if (!pluginData[item.id]) {
                const defaults = {};
                (item.settings || []).forEach((f) => { if (f.default !== undefined) defaults[f.key] = f.default; });
                pluginData[item.id] = { settings: defaults };
                await savePluginData(item.id);
            }
        }

        await pushClaims(item);
        await saveState();
        render();
        loadAllConfigs();
        if (panelRefreshHook) { try { panelRefreshHook(); } catch (e) { /* ignore */ } }
        if (item.type === 'theme') {
            toast(`已应用主题「${item.name}」`);
        } else {
            toast(`已安装「${item.name}」`);
            await runPlugins();
        }
    }

    // 作者更新了代码：重新走一遍「权限确认」，确认后放行新指纹
    // 更新 = 用新条目再装一遍，但保留「原来的设置」与主题的原生值快照。
    // 插件如果改了权限 / hosts，会在这里重新走一次确认 —— 不能悄悄扩权。
    async function updateItem(item) {
        const rec = state.installed[item.id];
        if (!rec) { toast('它还没装呢喵'); return; }
        if (item.type === 'plugin') {
            const permsChanged = JSON.stringify(rec.permissions || []) !== JSON.stringify(item.permissions || [])
                || JSON.stringify(rec.hosts || []) !== JSON.stringify(item.hosts || []);
            const ok = await confirmInstall(item, { isUpdate: true, permsChanged: permsChanged });
            if (!ok) return;
            sendToSandbox({ type: 'stop', payload: { id: item.id } });
            removePluginUi(item.id);
            delete rec.crashed;
            delete rec.crashReason;
            delete rec.needsConfirm;
            delete rec.newHash;
            delete rec.codeHash;
            rec.enabled = true;
        }
        await install(item, { skipConfirm: true, keepPrev: rec.prev });
        if (item.type === 'plugin') {
            await saveState();
            runPlugins();
        }
        toast(`「${item.name}」已更新到 v${item.version}`);
    }

    // 一次把能更的都更掉（权限有变化的会依次弹确认，取消就跳过它）
    async function updateAll() {
        const list = catalog.filter((i) => !i.hidden && updateOf(i));
        if (!list.length) { toast('都是最新的喵'); return; }
        let ok = 0;
        for (const it of list) {
            const before = state.installed[it.id] && state.installed[it.id].version;
            await updateItem(it);
            if (state.installed[it.id] && state.installed[it.id].version !== before) ok++;
        }
        if (ok) toast(`已更新 ${ok} 个条目`);
    }

    async function reconfirm(item) {
        const ok = await confirmInstall(item);
        if (!ok) return;
        const rec = state.installed[item.id];
        if (!rec) return;
        rec.needsConfirm = false;
        if (rec.newHash) { rec.codeHash = rec.newHash; delete rec.newHash; }
        await saveState();
        render();
        toast('已确认「' + item.name + '」的新版本，插件马上就绪');
        runPlugins();
    }

    async function uninstall(id) {
        const item = itemById(id);
        const rec = state.installed[id];

        // 先无条件通知沙盒停机 —— 哪怕本地记录已经没了。
        // 状态有可能被重置/串档过（比如手工清过 storage），那记录不在、
        // 但沙盒里那份代码还在跑；这时候如果提前 return，就永远停不掉它。
        sendToSandbox({ type: 'stop', payload: { id: id } });

        if (!rec) {
            // 记录不在也要把残留的界面与数据清干净
            domUnobserveAll(id);
            removePluginUi(id);
            delete state.installed[id];
            await saveState();
            render();
            dbg('[pickcat-workshop] 卸载了一个没有记录的条目（已强制停机）：' + id);
            toast('已卸载「' + (item ? item.name : id) + '」（并强制停掉了残留进程）' + reportHint(item));
            return;
        }

        if (rec.type === 'theme') {
            const prev = rec.prev || {};
            const patch = {};
            Object.keys(prev).forEach((k) => { patch[k] = prev[k] === undefined ? '' : prev[k]; });
            if (Object.keys(patch).length) await set(patch);
            if (state.skin && state.skin.id === id) removeSkin();
            loadAllConfigs();
        } else {
            // stop 已经在函数开头发过了，这里只清界面与数据
            domUnobserveAll(id);
            removePluginUi(id);
            await remove([WS_DATA_PREFIX + id]);
            delete pluginData[id];
        }

        await dropClaims(id);
        // 逃生模式里卸载主题时，皮肤已经被摘掉、只留在 pausedSkin 里。
        // 不清掉这个标记，关掉逃生开关就会把「已经卸载的主题」重新贴回去 —— 看起来就是复活。
        if (state.pausedSkin === id) state.pausedSkin = null;
        delete state.installed[id];
        await saveState();
        render();
        loadAllConfigs();
        if (panelRefreshHook) { try { panelRefreshHook(); } catch (e) { /* ignore */ } }
        // 逃生模式里卸载的，大概率是「感觉不对劲」才卸的 —— 顺手把举报入口说一声。
        toast(`已卸载「${item ? item.name : id}」` + reportHint(item), 6000);
    }

    async function togglePlugin(id) {
        const rec = state.installed[id];
        if (!rec) return;
        rec.enabled = rec.enabled === false;
        await saveState();
        render();
        if (rec.enabled === false) {
            sendToSandbox({ type: 'stop', payload: { id: id } });
            removePluginUi(id);
            toast('已停用，刷新页面后彻底消失');
        } else {
            await runPlugins();
            toast('已启用');
        }
    }

    async function setSafeMode(on) {
        const next = !!on;
        const was = !!state.safeMode;
        state.safeMode = next;
        await saveState();
        if (next && !was) {
            // 「应急逃生」= 一键回到原生页面：插件全停 + 主题皮肤摘掉（CSS/类名/装饰件）
            // 先记下当前主题，松手时好原样贴回去；安装状态一律不动，不是卸载。
            if (state.skin && state.skin.id) state.pausedSkin = state.skin.id;
            Object.keys(state.installed).forEach((id) => {
                if (state.installed[id].type === 'plugin') {
                    sendToSandbox({ type: 'stop', payload: { id: id } });
                    removePluginUi(id);
                }
            });
            if (state.skin) removeSkin();
            // 关键一步：直接把整个 Worker 换成新的。
            // 只发 stop 是不够的 —— 插件里可能还有没跑完的 async 回调，会在开关关掉后
            // 把界面又建回来（看起来就是「卸载了又复活」）。terminate 是唯一能杀干净的。
            sendToSandbox({ type: 'reset' });
            dbg('[pickcat-workshop] 🛑 应急逃生已启动：已发 reset（换新 Worker），插件=' +
                (Object.keys(state.installed).filter((i) => state.installed[i].type === 'plugin').join(',') || '(无)'));
            toast('🛑 应急逃生已启动：所有插件已停、主题已摘，页面回到原生样子。再点一次就恢复。', 9000);
            // 顺手把所有权还给你：撕掉全部设置租约
            await set({ [CLAIMS_KEY]: {} });
            loadAllConfigs();
            if (panelRefreshHook) { try { panelRefreshHook(); } catch (e) { /* ignore */ } }
        } else if (!next) {
            // 关掉逃生开关：把刚才摘下的主题贴回去，再重启插件
            if (state.pausedSkin) {
                const back = catalog.filter((i) => i && i.id === state.pausedSkin)[0];
                const backId = state.pausedSkin;
                state.pausedSkin = null;
                if (back) {
                    try { await applySkin(back); } catch (e) { /* ignore */ }
                } else {
                    dbg('[pickcat-workshop] 逃生开关关闭：找不到主题 ' + backId + '，跳过恢复');
                }
            }
            toast('应急逃生已关闭，插件按原样重启');
            await runPlugins();
        }
        render();
    }

    /* ---------------- 沙盒通信 ---------------- */

    function ensureSandbox() {
        // iframe 有可能被页面的重渲染「顺手」弄掉（body 被换掉、或别的扩展清掉节点），
        // 这时候它虽然还在变量里，但已经不在文档里、也永远不会再发 ready。
        if (frame && (!frame.isConnected || !frame.contentWindow)) {
            try { frame.remove(); } catch (e) { /* ignore */ }
            frame = null;
            frameReady = false;
        }
        if (frame && frameReady) return Promise.resolve();
        if (!frame) {
            frame = document.createElement('iframe');
            frame.id = 'pickcat-sandbox-frame';
            frame.src = chrome.runtime.getURL('sandbox.html');
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
            (document.body || document.documentElement).appendChild(frame);
        }
        return new Promise((resolve) => {
            readyResolvers.push(resolve);
            setTimeout(() => {
                if (!frameReady) {
                    const i = readyResolvers.indexOf(resolve);
                    if (i !== -1) readyResolvers.splice(i, 1);
                    // 超时 = 这一只 iframe 没起来（有的页面加载慢、或者被别的扩展拦了）。
                    // 拆掉它，让下一次重试重新建一个 —— 留着反而是死马。
                    try {
                        if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
                    } catch (e) { /* ignore */ }
                    frame = null;
                    frameReady = false;
                    resolve();
                }
            }, 6000);
        });
    }

    devPushHook = function () {
        try { sendToSandbox({ type: 'dev', payload: { on: PICKCAT_DEV } }); } catch (e) { }
    };

function sendToSandbox(msg) {
        if (!frame || !frame.contentWindow) return;
        try {
            frame.contentWindow.postMessage(Object.assign({ __pickcat: 1 }, msg), '*');
        } catch (e) { /* 忽略 */ }
    }

    function replyCall(id, ok, data) {
        sendToSandbox({ type: 'call-reply', id: id, ok: ok, data: data });
    }

    window.addEventListener('message', (ev) => {
        const d = ev.data;
        if (!d || d.__pickcat !== 1) return;
        // 只接受我们自己那个 iframe 发来的消息，防止页面脚本伪造信封调用宿主能力
        if (!frame || !frame.contentWindow || ev.source !== frame.contentWindow) return;

        if (d.type === 'ready') {
            const self = d.self || {};
            dbg('[pickcat] 沙盒就绪：origin=' + self.origin + ' canEval=' + self.canEval + ' 已拦截网络 API=' + JSON.stringify(self.stubbedNet || []));
            if (self.netLeaked && self.netLeaked.length) {
                console.warn('[pickcat] 以下网络 API 的隔离桩未生效：' + self.netLeaked.join(', '));
            }
            frameReady = true;
        try { sendToSandbox({ type: 'dev', payload: { on: PICKCAT_DEV } }); } catch (e) { }
            readyResolvers.splice(0).forEach((fn) => fn());
            try { onSandboxReady(); } catch (e) { /* ignore */ }
            return;
        }
        if (d.type === 'call') {
            try {
                const result = handleCall(d.method, d.args || {}, d.pluginId);
                if (result && typeof result.then === 'function') {
                    result.then((r) => replyCall(d.id, true, r)).catch((e) => replyCall(d.id, false, { error: String(e && e.message || e) }));
                } else {
                    replyCall(d.id, true, result);
                }
            } catch (e) {
                replyCall(d.id, false, { error: String(e && e.message || e) });
            }
            return;
        }
        if (d.type === 'log') {
            const p = d.payload || {};
            if (p.level === 'error') console.error('[pickcat-plugin:' + p.pluginId + ']', p.text);
            else dbg('[pickcat-plugin:' + p.pluginId + ']', p.text);
            return;
        }
        if (d.type === 'plugin-unloaded') {
            removePluginUi((d.payload || {}).id);
            return;
        }

        if (d.type === 'crashed') {
            const p = d.payload || {};
            const ids = (p.ids && p.ids.length) ? p.ids : (p.id ? [p.id] : []);
            let touched = false;
            ids.forEach(function (id) {
                const rec = state.installed[id];
                if (!rec) return;
                rec.crashed = true;
                rec.crashReason = p.reason || '无响应';
                delete rec.enabled;
                // 自由档崩了就当作「这次运行到此为止」，别让它下次刷新又自己跑起来
                if (rec.freeRun) rec.freeRun = false;
                touched = true;
                const item = itemById(id);
                toast('⚡「' + (item ? item.name : id) + '」无响应，已强制停用：' + (rec.crashReason || '') +
                    '。页面没事，可以在这儿点「重试」。', 9000);
                removePluginUi(id);
            });
            if (!touched) return;
            saveState();
            render();
            renderFreeBar();
            return;
        }

        if (d.type === 'worker-failed') {
            console.warn('[pickcat-workshop] 插件运行时启动失败：' + ((d.payload || {}).error || ''));
            return;
        }
    });

    // 用户点「重试」：清掉卡死标记，重建 Worker，重新跑一遍
    /* 自由档插件的手动开关：跑了就挂一条常驻提示，让用户随时能掐掉。 */
    async function runFree(id) {
        const rec = state.installed[id];
        if (!rec) return;
        rec.freeRun = true;
        rec.enabled = true;
        await saveState();
        await runPlugins();
        renderFreeBar();
        toast('「' + (rec.name || id) + '」已在运行。它能看到并改动整个页面，不放心就点下面的「停止」。');
    }

    async function stopFree(id) {
        const rec = state.installed[id];
        sendToSandbox({ type: 'stop', payload: { id: id } });
        domUnobserveAll(id);
        removePluginUi(id);
        if (rec) {
            rec.freeRun = false;
            await saveState();
        }
        renderFreeBar();
        render();
    }

    function renderFreeBar() {
        const running = Object.keys(state.installed).filter((id) => {
            const rec = state.installed[id];
            if (!rec || rec.type !== 'plugin' || !rec.freeRun) return false;
            const it = itemById(id);
            return it && tierOf(it) === 'free';
        });
        let bar = document.getElementById('pickcat-free-bar');
        if (!running.length) {
            if (bar) bar.remove();
            return;
        }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'pickcat-free-bar';
            document.body.appendChild(bar);
        }
        bar.innerHTML = '<span class="pc-free-tip">🔴 自由档运行中 ' + running.length + ' 个</span>' +
            running.map((id) => {
                const name = (state.installed[id] && state.installed[id].name) || id;
                return '<button class="pc-free-stop" data-free="' + esc(id) + '" type="button">停止 ' + esc(name) + '</button>';
            }).join('') +
            (running.length > 1 ? '<button class="pc-free-stop" data-free="__all" type="button">全部停止</button>' : '');
        bar.onclick = (e) => {
            const t = e.target && e.target.getAttribute && e.target.getAttribute('data-free');
            if (!t) return;
            if (t === '__all') { running.forEach((id) => stopFree(id)); return; }
            stopFree(t);
        };
    }

    async function revivePlugin(id) {
        const rec = state.installed[id];
        if (!rec) return;
        delete rec.crashed;
        delete rec.crashReason;
        await saveState();
        sendToSandbox({ type: 'revive', payload: { id: id } });
        render();
        toast('正在重启「' + (itemById(id) ? itemById(id).name : id) + '」…');
        setTimeout(function () { runPlugins(); }, 300);
    }

    // 卸载之后的一句提醒。
    // 内置条目是我们自己写的，举报它没有意义，所以只对社区条目露这一句。
    function reportHint(item) {
        if (!item || item.source !== 'community') return '';
        return '　如果它做过奇怪的事，可以在这张卡上点 ⚑ 举报。';
    }

    // 举报：不搞自己的服务器，直接开一个预填好的 GitHub Issue。
    // 好处是「举报」这件事本身也是公开、可追溯的，谁都能看见。
    //
    // 但点举报的人里，十个有九个其实想要的不是「举报」，
    // 而是「让作者知道 / 让东西别再坏」—— 那件事在评论区解决得快得多。
    // 所以先弹一段说明，把「先去评论区」摆在前
    // 面，再问要不要继续。
    function reportItem(item) {
        showReportNotice(item);
    }

    function showReportNotice(item) {
        const name = item.name || item.id;
        const wrap = document.createElement('div');
        wrap.className = 'ws-modal ws-consent open';
        wrap.innerHTML = `<div class="ws-modal-card" style="max-width:430px">
            <h3 class="ws-modal-title">⚑ 举报之前，先说三句</h3>
            <p class="ws-modal-sub">${esc(name)} · ${item.type === 'theme' ? '主题' : '插件'} · by ${esc(item.author || '匿名')}</p>
            <div class="ws-note">
                <p><b>1. 先去原帖的评论区看一眼。</b>作者一般都在，回得最快；我也会在站内发消息把情况说清楚。</p>
                <p><b>2. 举报是开一个公开的 GitHub Issue。</b>我一个人维护，周中在学校拿不到手机 —— <b>举报统一在周末 / 节假日处理</b>，不是十分钟。</p>
                <p><b>3. 如果它在骗你输密码或 API Key：</b>先打开右上角的「🛑 应急逃生」把它全停掉，再来举报。</p>
            </div>
            <div class="ws-modal-foot">
                <button class="ws-btn" data-r="back">知道了，先去评论区</button>
                <button class="ws-btn primary" data-r="go">继续去 GitHub 举报</button>
            </div>
        </div>`;
        const finish = (go) => {
            wrap.remove();
            if (go) openReportIssue(item);
            else toast('看完评论区要是还觉得不对劲，回来点 ⚑ 就行', 5000);
        };
        wrap.querySelector('[data-r="back"]').addEventListener('click', () => finish(false));
        wrap.querySelector('[data-r="go"]').addEventListener('click', () => finish(true));
        shadow.appendChild(wrap);
    }

    function openReportIssue(item) {
        const title = '[举报] ' + item.id;
        const body = [
            '### 举报的条目',
            '',
            '`' + item.id + '`　（' + (item.name || '') + ' · ' + (item.type === 'theme' ? '主题' : '插件') + ' · by ' + (item.author || '匿名') + '）',
            '',
            '### 问题类型',
            '',
            '- [ ] 看起来在骗人（诱导输入密码 / Key 等）',
            '- [ ] 页面显示异常 / 挡不住内容',
            '- [ ] 内容不适合出现在这里',
            '- [ ] 其他',
            '',
            '### 具体描述',
            '',
            '（在这里写清楚你看到了什么；有截图的话可以直接把图拖进来）',
            '',
            '### 处理时效',
            '',
            '维护者是学生，周中拿不到手机，**举报统一在周末 / 节假日处理**。',
            '如果情况紧急，麻烦在原始帖子评论区也留一句，作者通常回得更快。',
            '',
            '### 你的浏览器',
            '',
            navigator.userAgent
        ].join('\n');
        const url = REPO_URL + '/issues/new?labels=report&title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
        try {
            window.open(url, '_blank', 'noopener');
        } catch (e) {
            copyText(url);
            toast('已复制举报链接，粘贴到浏览器打开就行');
        }
    }

    /* ---------------- DOM 桥 ----------------
     *
     * 插件在沙盒里没有 document，所以「改页面」这件事只能由宿主代做。
     * 两档：
     *   Tier B（均衡）：清单里声明 "anchor": ["editor"]，只能操作锚点根之内的节点
     *   Tier C（自由）：申请 dom-global，可以动整页，但仍禁止：删节点、写 innerHTML、
     *                  碰扩展自己的节点、改 href/src、插入脚本类标签
     *
     * 插件侧拿到的是**句柄**（字符串），不是 DOM 对象 —— postMessage 传不过去，
     * 也没法让插件留着引用去搞事。句柄只在本次页面生命周期内有效。
     */

    const DOM_ANCHOR_KINDS = ['editor', 'composer', 'post', 'header'];

    const DOM_ANCHORS = {
        editor: ['textarea#post-content', 'textarea[name="content"]', '.ProseMirror', '[contenteditable="true"]', 'form textarea'],
        composer: ['main form', 'form'],
        post: ['article', '[class*="prose"]', 'main'],
        header: ['header', 'nav', '[role="banner"]']
    };

    function domAnchorRoot(kind) {
        const list = DOM_ANCHORS[kind];
        if (!list) return null;
        for (const sel of list) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    const domHandles = new Map();   // handle -> { el, pluginId }
    let domSeq = 0;

    function domHandleOf(el, pluginId) {
        if (!el) return null;
        let found = null;
        domHandles.forEach((v, k) => { if (!found && v.el === el && v.pluginId === pluginId) found = k; });
        if (found) return found;
        const h = 'n' + (++domSeq);
        domHandles.set(h, { el: el, pluginId: pluginId });
        return h;
    }

    function domElOf(handle, pluginId) {
        const rec = domHandles.get(String(handle));
        if (!rec || rec.pluginId !== pluginId) throw new Error('无效的节点句柄（跨插件或已失效）');
        if (!rec.el || !rec.el.isConnected) throw new Error('这个节点已经不在页面上了');
        return rec.el;
    }

    const PICKCAT_OWN = '#pickcat-settings-host, #pickcat-decor, #pickcat-plugin-bar, .pickcat-ws-card, #pickcat-ws-toast, #pickcat-cursor-style, #pickcat-custom-theme-style, #pickcat-sandbox-frame';

    // 这个插件能不能碰这个节点
    function domAllowed(rec, el) {
        if (!el || el.nodeType !== 1) return false;
        if (el === document.documentElement) return false;
        if (el.closest(PICKCAT_OWN)) return false;

        if ((rec.permissions || []).indexOf('dom-global') >= 0) return true;

        const anchors = Array.isArray(rec.anchor) ? rec.anchor : [];
        if (!anchors.length) return false;
        return anchors.some((k) => {
            const root = domAnchorRoot(k);
            return root && (root === el || root.contains(el));
        });
    }

    function domNeed(rec, el) {
        if (!domAllowed(rec, el)) {
            const anchors = Array.isArray(rec.anchor) ? rec.anchor.join(' / ') : '（未声明）';
            throw new Error('这个节点不在插件被允许的范围内（锚点：' + anchors + '）');
        }
    }

    const DOM_ATTR_ALLOW = ['class', 'title', 'placeholder', 'role', 'tabindex', 'disabled', 'hidden', 'aria-label', 'aria-hidden', 'aria-expanded', 'aria-selected'];
    function domAttrOk(name) {
        if (DOM_ATTR_ALLOW.indexOf(name) >= 0) return true;
        return /^data-[a-z0-9-]+$/.test(name) || /^aria-[a-z]+$/.test(name);
    }

    // 样式白名单（和主题审计器同一套思路：只允许「画」，不允许「藏」和「连网」）
    const DOM_STYLE_ALLOW = /^(color|background(-[a-z]+)?|border(-[a-z]+)?|box-shadow|outline(-[a-z]+)?|font(-[a-z]+)?|line-height|letter-spacing|text-(align|decoration|transform|shadow|overflow|wrap)|opacity|fill|stroke|padding(-[a-z]+)?|margin(-[a-z]+)?|gap|row-gap|column-gap|display|align-[a-z]+|justify-[a-z]+|flex(-[a-z]+)?|grid(-[a-z]+)?|width|height|min-[a-z]+|max-[a-z]+|top|left|right|bottom|position|overflow(-[a-z]+)?|border-radius|box-sizing|cursor|z-index|transform|transition(-[a-z]+)?|animation(-[a-z]+)?|backdrop-filter|object-fit|list-style(-[a-z]+)?|visibility|white-space|word-break|order|aspect-ratio)$/;
    const DOM_STYLE_DENY_VAL = /url\s*\(|expression\s*\(|javascript:|@import|<script/i;

    function domStyleOk(prop, value) {
        if (!DOM_STYLE_ALLOW.test(prop)) throw new Error('样式属性「' + prop + '」不在白名单里');
        const v = String(value);
        if (v.length > 200) throw new Error('样式值太长');
        if (DOM_STYLE_DENY_VAL.test(v)) throw new Error('样式值里有被禁止的写法');
        if (prop === 'position' && /fixed|sticky/.test(v)) throw new Error('插件不能用 position:' + v);
        if (prop === 'z-index' && Math.abs(parseInt(v, 10) || 0) > 1200) throw new Error('z-index 超出范围（±1200）');
        return v;
    }

    // 极简 HTML 消毒：只留结构性标签，属性同样走白名单
    const DOM_TAGS_ALLOW = ['div', 'span', 'p', 'b', 'i', 'em', 'strong', 'small', 'br', 'hr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'button', 'section', 'header', 'footer', 'label'];
    function domSanitize(html) {
        const doc = new DOMParser().parseFromString('<div id="r">' + String(html).slice(0, 20000) + '</div>', 'text/html');
        const root = doc.getElementById('r');
        const walk = (node) => {
            Array.from(node.children).forEach((el) => {
                const tag = el.tagName.toLowerCase();
                if (DOM_TAGS_ALLOW.indexOf(tag) < 0) {
                    el.remove();
                    return;
                }
                Array.from(el.attributes).forEach((a) => {
                    const name = a.name.toLowerCase();
                    if (name === 'style') {
                        let safe = '';
                        el.style.cssText.split(';').forEach((pair) => {
                            const idx = pair.indexOf(':');
                            if (idx < 0) return;
                            const p = pair.slice(0, idx).trim().toLowerCase();
                            const v = pair.slice(idx + 1).trim();
                            try { if (domStyleOk(p, v)) safe += p + ':' + v + ';'; } catch (e) { }
                        });
                        el.setAttribute('style', safe);
                        return;
                    }
                    if (!domAttrOk(name)) el.removeAttribute(a.name);
                });
                if (el.hasAttribute('class')) {
                    const cls = el.getAttribute('class').split(/\s+/).filter((c) => /^[a-zA-Z][\w-]{0,40}$/.test(c));
                    el.setAttribute('class', cls.join(' '));
                }
                walk(el);
            });
        };
        walk(root);
        return root.innerHTML;
    }

    const domObservers = new Map();   // pluginId -> [MutationObserver]
    function domObserve(rec, args, pluginId) {
        const list = domObservers.get(pluginId) || [];
        if (list.length >= 3) throw new Error('最多同时监听 3 个区域');
        const target = args && args.anchor
            ? domAnchorRoot(args.anchor)
            : (rec.permissions || []).indexOf('dom-global') >= 0 ? document.body : null;
        if (!target) throw new Error('找不到要监听的区域');
        let timer = 0;
        const mo = new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = 0;
                try {
                    sendToSandbox({ type: 'event', payload: { name: 'dom-change', anchor: args && args.anchor || 'global' } });
                } catch (e) { }
            }, 150);
        });
        mo.observe(target, { childList: true, subtree: true, characterData: true });
        list.push(mo);
        domObservers.set(pluginId, list);
        return { ok: true, watching: list.length };
    }
    function domUnobserveAll(pluginId) {
        (domObservers.get(pluginId) || []).forEach((mo) => { try { mo.disconnect(); } catch (e) { } });
        domObservers.delete(pluginId);
        Array.from(domHandles.entries()).forEach(([h, v]) => { if (v.pluginId === pluginId) domHandles.delete(h); });
    }

    function domCall(method, args, pluginId) {
        const rec = state.installed[pluginId];
        if (!rec) throw new Error('插件未安装或已卸载：' + pluginId);
        const a = args || {};

        if (method === 'dom.query') {
            const sel = String(a.selector || '').slice(0, 200);
            if (!sel) throw new Error('缺少 selector');
            const root = a.anchor ? domAnchorRoot(a.anchor) : ((rec.permissions || []).indexOf('dom-global') >= 0 ? document.body : null);
            if (!root) throw new Error('找不到锚点区域：' + (a.anchor || '(未声明)'));
            const limit = Math.min(Number(a.limit) || 50, 200);
            const els = Array.from(root.querySelectorAll(sel)).slice(0, limit).filter((el) => domAllowed(rec, el));
            return {
                count: els.length,
                handles: els.map((el) => domHandleOf(el, pluginId)),
                tags: els.map((el) => el.tagName.toLowerCase())
            };
        }

        if (method === 'dom.observe') return domObserve(rec, a, pluginId);

        const el = domElOf(a.handle, pluginId);
        domNeed(rec, el);

        if (method === 'dom.text') return String(el.innerText || el.textContent || '').slice(0, 20000);
        if (method === 'dom.attr') return el.getAttribute(String(a.name || ''));

        if (method === 'dom.setAttr') {
            const name = String(a.name || '').toLowerCase();
            if (!domAttrOk(name)) throw new Error('属性「' + name + '」不在白名单里');
            if (a.value === null || a.value === undefined) { el.removeAttribute(name); return true; }
            el.setAttribute(name, String(a.value).slice(0, 2000));
            return true;
        }

        if (method === 'dom.addClass' || method === 'dom.removeClass') {
            const cls = String(a.class || '').split(/\s+/).filter((c) => /^[a-zA-Z][\w-]{0,40}$/.test(c));
            if (!cls.length) throw new Error('类名不合法');
            cls.forEach((c) => { method === 'dom.addClass' ? el.classList.add(c) : el.classList.remove(c); });
            return true;
        }

        if (method === 'dom.style') {
            const prop = String(a.prop || '').toLowerCase();
            const value = domStyleOk(prop, a.value);
            el.style.setProperty(prop, value);
            return true;
        }

        if (method === 'dom.setText') {
            el.textContent = String(a.text === undefined ? '' : a.text).slice(0, 2000);
            return true;
        }

        if (method === 'dom.insert') {
            const html = domSanitize(a.html);
            const pos = a.position === 'before' ? 'beforebegin' : a.position === 'after' ? 'afterend' : a.position === 'prepend' ? 'afterbegin' : 'beforeend';
            el.insertAdjacentHTML(pos, html);
            return { ok: true };
        }

        throw new Error('未知的 DOM 操作：' + method);
    }

    const NEED_PERM = {
        getPostContent: 'dom-read',
        addInteractionButton: 'ui-interaction',
        showCard: 'ui-interaction',
        updateCard: 'ui-interaction',
        closeCard: 'ui-interaction',
        showToast: 'notify',
        copy: 'clipboard-write',
        'storage.set': 'storage',
        fetch: 'network',
        'dom.query': 'dom-read',
        'dom.text': 'dom-read',
        'dom.attr': 'dom-read',
        'dom.observe': 'dom-read',
        'dom.setAttr': 'dom-write',
        'dom.addClass': 'dom-write',
        'dom.removeClass': 'dom-write',
        'dom.style': 'dom-write',
        'dom.setText': 'dom-write',
        'dom.insert': 'dom-write'
    };

    // 插件消息配额：单插件每秒最多 60 条，防止恶意插件刷爆宿主
    const MSG_QUOTA = 60;
    const msgBuckets = new Map();   // pluginId -> { t, n }
    function checkQuota(pluginId) {
        const now = Date.now();
        let b = msgBuckets.get(pluginId);
        if (!b || now - b.t > 1000) { b = { t: now, n: 0 }; msgBuckets.set(pluginId, b); }
        b.n++;
        if (b.n > MSG_QUOTA) {
            throw new Error('调用太频繁（超过 ' + MSG_QUOTA + ' 次/秒），已限流');
        }
    }

    // 宿主侧再判一遍 hosts 白名单：沙盒里的判断不能当安全依据
    function hostAllowed(hosts, url) {
        let u;
        try { u = new URL(String(url)); } catch (e) { return false; }
        if (u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        return (hosts || []).some((h) => {
            h = String(h).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
            return host === h || host.slice(-(h.length + 1)) === '.' + h;
        });
    }

    // 唯一的网络出口：交给 background service worker
    function proxyFetch(pluginId, args) {
        const rec = state.installed[pluginId];
        if (!hostAllowed(rec.hosts, args && args.url)) {
            return Promise.reject(new Error('域名不在该插件的 hosts 白名单内，请求已被拦截'));
        }
        return new Promise((resolve, reject) => {
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                reject(new Error('网络请求超时'));
            }, 32000);
            try {
                chrome.runtime.sendMessage({
                    type: 'pickcat-net',
                    payload: {
                        url: args.url,
                        method: args.method || 'GET',
                        headers: args.headers || {},
                        body: args.body
                    }
                }, (res) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    const err = chrome.runtime.lastError;
                    if (err) { reject(new Error('网络通道不可用：' + err.message)); return; }
                    resolve(res || { ok: false, error: '没有拿到响应' });
                });
            } catch (e) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(new Error('网络通道不可用：' + ((e && e.message) || e)));
            }
        });
    }

    function handleCall(method, args, pluginId) {
        const rec = state.installed[pluginId];
        if (!rec || rec.type !== 'plugin') throw new Error('插件 ' + pluginId + ' 未安装或已停用');
        checkQuota(pluginId);
        const need = NEED_PERM[method];
        if (need && (rec.permissions || []).indexOf(need) === -1) {
            throw new Error('插件没有申请「' + need + '」权限，调用被拒绝');
        }

        switch (method) {
            case 'fetch': return proxyFetch(pluginId, args || {});
            case 'getPostContent': return getPostContent();
            case 'addInteractionButton': return addButton(pluginId, args);
            case 'removeInteractionButton': removeButton(args.buttonId); return true;
            case 'showCard': return showCard(args, pluginId);
            case 'updateCard': updateCard(args.cardId, args.text); return true;
            case 'closeCard': closeCard(args.cardId); return true;
            case 'showToast': toast(args.text); return true;
            case 'copy': return copyText(args.text);
            case 'storage.set': return saveStorage(pluginId, args.key, args.value);
            case 'dom.query':
            case 'dom.text':
            case 'dom.attr':
            case 'dom.observe':
            case 'dom.setAttr':
            case 'dom.addClass':
            case 'dom.removeClass':
            case 'dom.style':
            case 'dom.setText':
            case 'dom.insert': return domCall(method, args, pluginId);
            default: throw new Error('未知的调用：' + method);
        }
    }

    /* ---------------- 插件能用到的能力实现 ---------------- */

    function getPostContent() {
        const pick = (sels) => {
            for (const s of sels) {
                const el = document.querySelector(s);
                if (el && el.innerText && el.innerText.trim().length > 60) return el;
            }
            return null;
        };
        const h1 = document.querySelector('h1');
        let title = (h1 && h1.innerText ? h1.innerText : '').trim();
        if (!title) title = (document.title || '').replace(/\s*[-|｜—].*$/, '').trim();

        const box = pick(['article', 'main', '[class*="prose"]', '[class*="markdown"]', '[class*="post-content"]', '[class*="postContent"]', '[class*="detail"]']);
        const raw = box ? box.innerText : (document.body ? document.body.innerText : '');
        const text = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
        return { title: title, text: text.slice(0, 12000), url: location.href };
    }

    function ensurePageStyle() {
        if (pageStyleInjected) return;
        pageStyleInjected = true;
        const st = document.createElement('style');
        st.id = 'pickcat-ws-style';
        st.textContent = `
            #pickcat-plugin-bar { position: fixed; left: 18px; bottom: 96px; z-index: 999990; display: flex; flex-direction: column; gap: 8px; }
            #pickcat-plugin-bar .ws-pbtn { display: flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 999px;
                border: 1px solid rgba(255,255,255,.18); background: rgba(28,28,38,.86); color: #fff; font: 600 13px/1 system-ui, sans-serif;
                cursor: pointer; box-shadow: 0 8px 22px rgba(0,0,0,.28); backdrop-filter: blur(10px); transition: transform .18s ease, background .18s ease; }
            #pickcat-plugin-bar .ws-pbtn:hover { transform: translateY(-2px); background: rgba(79,70,229,.9); }
            .pickcat-ws-card { position: fixed; right: 22px; bottom: 90px; z-index: 999991; width: 340px; max-height: 68vh;
                display: flex; flex-direction: column; background: rgba(24,24,32,.94); color: #e8e8ef; border: 1px solid rgba(255,255,255,.14);
                border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.42); backdrop-filter: blur(12px);
                font: 13px/1.6 system-ui, sans-serif; overflow: hidden; }
            .pickcat-ws-card .ws-ch { display: flex; align-items: center; gap: 8px; padding: 11px 12px; border-bottom: 1px solid rgba(255,255,255,.1); }
            .pickcat-ws-card .ws-ct { flex: 1; font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .pickcat-ws-card .ws-cx { border: 0; background: transparent; color: #9aa0b4; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 4px; }
            .pickcat-ws-card .ws-cb { padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
            .pickcat-ws-card .ws-cb::-webkit-scrollbar { width: 10px; }
            .pickcat-ws-card .ws-cb::-webkit-scrollbar-track { background: transparent; }
            .pickcat-ws-card .ws-cb::-webkit-scrollbar-thumb { background-color: rgba(255,255,255,.18);
                border-radius: 999px; border: 3px solid transparent; background-clip: content-box; }
            .pickcat-ws-card .ws-cb:hover::-webkit-scrollbar-thumb { background-color: rgba(255,255,255,.34); background-clip: content-box; }
            .pickcat-ws-card .ws-cf { display: flex; gap: 8px; padding: 8px 12px 12px; }
            .pickcat-ws-card .ws-cf button { flex: 1; padding: 7px; border-radius: 8px; border: 1px solid rgba(255,255,255,.16);
                background: transparent; color: #d7d9e3; font: 600 12px system-ui, sans-serif; cursor: pointer; }
            .pickcat-ws-card .ws-cf button:hover { border-color: #7c7cf0; color: #b9b9ff; }
            .pickcat-ws-card.loading .ws-cb::after { content: ''; display: inline-block; width: 9px; height: 9px; margin-left: 6px;
                border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: pickcat-spin .8s linear infinite; }
            @keyframes pickcat-spin { to { transform: rotate(360deg); } }
            /* 自由档常驻提示：只要它在跑，这条就一直挂在顶部，随时能掐 */
            #pickcat-free-bar { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); z-index: 999999;
                display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 10px;
                background: rgba(34,16,16,.94); border: 1px solid rgba(250,50,45,.55); color: #ffd9d8;
                font: 12px/1 system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.45); backdrop-filter: blur(10px); }
            #pickcat-free-bar .pc-free-tip { font-weight: 700; letter-spacing: .2px; }
            #pickcat-free-bar .pc-free-stop { padding: 6px 10px; border-radius: 6px; cursor: pointer;
                border: 1px solid rgba(255,255,255,.22); background: rgba(255,255,255,.1); color: #fff; font: 600 12px system-ui, sans-serif; }
            #pickcat-free-bar .pc-free-stop:hover { background: #fa322d; border-color: #fa322d; }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    function ensureBar() {
        let bar = document.getElementById('pickcat-plugin-bar');
        if (!bar) {
            ensurePageStyle();
            bar = document.createElement('div');
            bar.id = 'pickcat-plugin-bar';
            (document.body || document.documentElement).appendChild(bar);
        }
        return bar;
    }

    function addButton(pluginId, args) {
        const bar = ensureBar();
        if (bar.querySelector(`[data-btn="${CSS.escape(args.buttonId)}"]`)) return true;
        const b = document.createElement('button');
        b.className = 'ws-pbtn';
        b.dataset.btn = args.buttonId;
        b.dataset.plugin = pluginId;
        const icon = document.createElement('span');
        icon.textContent = args.icon || '✨';
        const label = document.createElement('span');
        label.textContent = args.label || '插件';
        b.appendChild(icon);
        b.appendChild(label);
        b.addEventListener('click', () => {
            sendToSandbox({ type: 'event', payload: { name: 'button-click', buttonId: args.buttonId } });
        });
        bar.appendChild(b);
        return true;
    }

    function removeButton(buttonId) {
        const el = document.querySelector(`#pickcat-plugin-bar [data-btn="${CSS.escape(buttonId)}"]`);
        if (el) el.remove();
        const bar = document.getElementById('pickcat-plugin-bar');
        if (bar && !bar.children.length) bar.remove();
    }

    function removePluginUi(pluginId) {
        const bar = document.getElementById('pickcat-plugin-bar');
        if (bar) {
            Array.prototype.slice.call(bar.querySelectorAll('[data-plugin]')).forEach((b) => {
                if (b.dataset.plugin === pluginId) b.remove();
            });
            if (!bar.children.length) bar.remove();
        }
        Array.prototype.slice.call(document.querySelectorAll('.pickcat-ws-card[data-plugin="' + CSS.escape(pluginId) + '"]')).forEach((c) => c.remove());
    }

    function showCard(args, pluginId) {
        ensurePageStyle();
        const id = 'pickcat-ws-card-' + (++cardSeq);
        const el = document.createElement('div');
        el.className = 'pickcat-ws-card' + (args.loading ? ' loading' : '');
        el.id = id;
        if (pluginId) el.dataset.plugin = pluginId;
        el.innerHTML = '<div class="ws-ch"><span class="ws-ct"></span><button class="ws-cx" title="关闭">×</button></div>' +
            '<div class="ws-cb"></div><div class="ws-cf"><button class="ws-copy">复制</button></div>';
        el.querySelector('.ws-ct').textContent = args.title || '插件输出';
        el.querySelector('.ws-cb').textContent = args.text || '';
        el.querySelector('.ws-cx').addEventListener('click', () => el.remove());
        el.querySelector('.ws-copy').addEventListener('click', () => {
            copyText(el.querySelector('.ws-cb').textContent || '').then(() => toast('已复制'));
        });
        (document.body || document.documentElement).appendChild(el);
        return id;
    }

    function updateCard(cardId, text) {
        const el = document.getElementById(cardId);
        if (!el) return;
        el.classList.remove('loading');
        el.querySelector('.ws-cb').textContent = text;
    }

    function closeCard(cardId) {
        const el = document.getElementById(cardId);
        if (el) el.remove();
    }

    function copyText(text) {
        const done = () => toast('已复制到剪贴板');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        }
        return Promise.resolve(fallbackCopy(text, done));
    }

    function fallbackCopy(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中复制'); }
        ta.remove();
    }

    function saveStorage(pluginId, key, value) {
        if (!pluginData[pluginId]) pluginData[pluginId] = {};
        pluginData[pluginId][key] = value;
        return savePluginData(pluginId).then(() => true);
    }

    /* ---------------- 启动插件 ---------------- */

    async function sha256Hex(text) {
        try {
            if (!(window.crypto && window.crypto.subtle && window.TextEncoder)) return '';
            const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
            return Array.prototype.map.call(new Uint8Array(buf), (b) => ('00' + b.toString(16)).slice(-2)).join('');
        } catch (e) {
            return '';
        }
    }

    async function loadPluginCode(item) {
        let url = '';
        if (item.entry) url = assetUrl(item, item.entry);
        else if (item.url) url = assetUrl(item, item.url);
        if (!url) throw new Error('该插件没有代码入口');

        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error('读取插件代码失败：' + res.status);
        const code = await res.text();
        if (!code || code.length > 200 * 1024) throw new Error('插件代码为空或超过 200KB');

        // 社区插件带 sha256 时必须对得上，防止 CDN 上的内容被换掉
        if (item.sha256) {
            const got = await sha256Hex(code);
            if (!got) throw new Error('本环境不支持指纹校验，已拒绝运行');
            if (got !== item.sha256) throw new Error('代码指纹不匹配（清单写的是 ' + item.sha256.slice(0, 8) + '…，实际 ' + got.slice(0, 8) + '…）');
        } else if (item.source === 'community') {
            throw new Error('社区插件必须在清单里提供 sha256');
        }
        return code;
    }

    // 沙盒是懒创建的，冷启动可能慢一拍：给它几次重试的机会，而不是一次就放弃。
    const SANDBOX_MAX_TRIES = 3;
    let sandboxTries = 0;
    let sandboxRetryTimer = null;

    function scheduleSandboxRetry() {
        if (sandboxRetryTimer) return;
        sandboxRetryTimer = setTimeout(() => {
            sandboxRetryTimer = null;
            runPlugins();
        }, sandboxTries * 1200);
    }

    // 沙盒真正就绪的那一刻，如果刚才因为没就绪而跳过启动，就补跑一次。
    function onSandboxReady() {
        // 只有「确实跳过过」才补跑，否则正常冷启动会重复启动一遍插件。
        const skipped = sandboxTries > 0;
        sandboxTries = 0;
        if (sandboxRetryTimer) { clearTimeout(sandboxRetryTimer); sandboxRetryTimer = null; }
        if (!skipped) return;
        const pending = Object.keys(state.installed).some((id) => {
            const rec = state.installed[id];
            return rec && rec.type === 'plugin' && rec.enabled !== false && !rec.crashed;
        });
        if (pending) setTimeout(() => { runPlugins(); }, 0);
    }

    async function runPlugins() {        if (state.safeMode) return;
        const targets = Object.keys(state.installed).filter((id) => {
            const rec = state.installed[id];
            if (rec.revoked || isRevoked(id)) return false;   // 被下架的插件永不再启动
            if (rec.type !== 'plugin' || rec.enabled === false) return false;
            // 自由档（dom-global）能改整个页面，绝不自作主张地跑：
            // 必须用户这次会话里亲手点了「运行」，刷新页面也不自动续。
            const it = itemById(id);
            if (it && tierOf(it) === 'free' && !rec.freeRun) return false;
            return true;
        });
        if (!targets.length) return;
        dbg('[pickcat-workshop] 启动插件：' + targets.join(', ') + '（已安装清单：' +
            (Object.keys(state.installed).join(',') || '(空)') + '）');

        await ensureSandbox();
        if (!frameReady) {
            // 沙盒是懒创建的，冷启动那一下偶尔会赶不上（iframe 还没跑起来）。
            // 这不是错误，重试就好 —— 以前这里直接 warn + 放弃，用户看到的是
            // 「沙盒未就绪」的报错，而且插件直到刷新页面才可能起来。
            if (sandboxTries < SANDBOX_MAX_TRIES) {
                sandboxTries += 1;
                dbg('[pickcat-workshop] 沙盒还没就绪，' + (sandboxTries * 1200) + 'ms 后重试（第 ' +
                    sandboxTries + '/' + SANDBOX_MAX_TRIES + ' 次）');
                scheduleSandboxRetry();
            } else {
                console.warn('[pickcat-workshop] 沙盒尝试 ' + SANDBOX_MAX_TRIES + ' 次仍未就绪，本次不启动插件（刷新页面即可重试）');
                sandboxTries = 0;
            }
            return;
        }
        sandboxTries = 0;

        for (const id of targets) {
            const rec = state.installed[id];
            const item = itemById(id);
            if (!item) continue;
            // 上次卡死过的插件不自动启动，等用户在卡片上点「重试」
            if (rec.crashed) continue;
            try {
                const code = await loadPluginCode(item);

                // 代码指纹变了 = 作者换了内容，必须让用户重新确认一次，
                // 不能因为「已经装过了」就静默升级权限。
                const hash = await sha256Hex(code);
                if (hash && rec.codeHash && rec.codeHash !== hash) {
                    rec.needsConfirm = true;
                    rec.newHash = hash;
                    await saveState();
                    toast('「' + item.name + '」代码已更新，请到创意工坊重新确认');
                    render();
                    continue;
                }
                if (rec.needsConfirm) continue;      // 等用户确认
                if (hash && !rec.codeHash) { rec.codeHash = hash; await saveState(); }

                sendToSandbox({
                    type: 'run',
                    payload: {
                        id: id,
                        code: code,
                        data: pluginData[id] || {},
                        meta: {
                            id: item.id,
                            name: item.name,
                            version: item.version,
                            author: item.author,
                            hosts: rec.hosts || [],
                            granted: rec.permissions || []
                        }
                    }
                });
            } catch (e) {
                console.warn('[pickcat-workshop] 启动 ' + id + ' 失败：' + (e && e.message || e));
                toast('插件「' + item.name + '」启动失败');
            }
        }
    }

    /* ---------------- 事件绑定 ---------------- */

    // bind() 在 IIFE 作用域里，拿不到 mount(root) 的形参，所以把根节点存一份
    let wsRoot = null;

    function bind() {
        els.chips.addEventListener('click', (ev) => {
            const chip = ev.target.closest ? ev.target.closest('.ws-chip') : null;
            if (!chip) return;
            filterCat = chip.dataset.filter;
            render();
        });

        els.search.addEventListener('input', () => {
            keyword = els.search.value.trim();
            render();
        });

        els.safeMode.addEventListener('change', () => setSafeMode(els.safeMode.checked));

        if (els.updateAll) {
            els.updateAll.addEventListener('click', () => { updateAll(); });
        }

        const openFullBtn = wsRoot ? wsRoot.getElementById('wsOpenFull') : null;
        if (openFullBtn) {
            openFullBtn.addEventListener('click', () => {
                // 交给 background 开新标签页。
                // 内容脚本直接 window.open('chrome-extension://…') 会被 Chrome 拦成
                // ERR_BLOCKED_BY_CLIENT —— 页面 origin 没有直达扩展页的权限。
                try {
                    chrome.runtime.sendMessage({ type: 'pickcat-open', payload: { page: 'workshop' } }, (res) => {
                        const err = (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message);
                        if (!res || !res.ok) toast('打不开工坊页：' + (err || '未知原因'), 5000);
                    });
                } catch (e) {
                    toast('打不开工坊页：' + ((e && e.message) || e), 5000);
                }
            });
        }

        if (els.refresh) {
            els.refresh.addEventListener('click', async () => {
                els.refresh.disabled = true;
                els.refresh.textContent = '同步中…';
                // 手动同步 = 不听缓存，先把旧缓存删掉，免得又被它顶回来
                try { await remove([CATALOG_CACHE_KEY]); } catch (e) { /* ignore */ }
                const r = await refreshCommunity(null);
                els.refresh.disabled = false;
                els.refresh.textContent = '🌐 同步';
                toast(r === 'ok'
                    ? `社区清单已同步：${remoteMerged} 个条目` + (remoteUpdated ? `（清单 ${String(remoteUpdated).slice(0, 16).replace('T', ' ')}）` : '')
                    : '社区清单同步失败，先用内置内容');
            });
        }

        wsRoot.addEventListener('click', function (ev) {
            const btn = ev.target.closest ? ev.target.closest('button[data-act]') : null;
            if (!btn) return;
            const id = btn.dataset.id;
            const act = btn.dataset.act;
            const item = itemById(id);
            if (act === 'install' && item) install(item);
            else if (act === 'uninstall') uninstall(id);
            else if (act === 'toggle') togglePlugin(id);
            else if (act === 'reconfirm' && item) reconfirm(item);
            else if (act === 'revive') revivePlugin(id);
            else if (act === 'freeRun') runFree(id);
            else if (act === 'freeStop') stopFree(id);
            else if (act === 'report' && item) reportItem(item);
            else if (act === 'update' && item) updateItem(item);
            else if (act === 'update-all') updateAll();
            else if (act === 'openPlugPage') {
                openPluginPage(id);
            }        }, true);

        wsRoot.addEventListener('change', function (ev) {
            const input = ev.target;
            if (!input || !input.dataset || !input.dataset.field) return;
            const card = input.closest('[data-card]');
            if (!card) return;
            const id = card.dataset.card;
            if (!pluginData[id]) pluginData[id] = {};
            if (!pluginData[id].settings) pluginData[id].settings = {};
            // switch 存 boolean，number 存数字，其余存字符串
            let val = input.value;
            if (input.dataset.kind === 'bool' || input.type === 'checkbox') val = !!input.checked;
            else if (input.type === 'number') val = input.value === '' ? '' : Number(input.value);
            pluginData[id].settings[input.dataset.field] = val;
            savePluginData(id).then(() => {
                sendToSandbox({ type: 'storage-sync', payload: { id: id, data: pluginData[id] } });
                toast('已保存设置');
            });
        });
    }

    /* ---------------- 对外接口 ---------------- */

    // 老用户补登记：清单里新加了 claims（比如万圣夜惊魂）时，不用卸载重装也能生效。
    // 只在「已安装版本」和「清单版本」不一致时补一次，这样用户手动点过「释放」不会被反复抢回去。
    async function syncClaimsFromCatalog() {
        let touched = false;
        for (const id of Object.keys(state.installed)) {
            const item = itemById(id);
            const rec = state.installed[id];
            if (!item || !rec || !item.claims || !item.claims.length) continue;
            if (rec.claimVer === item.version) continue;
            await pushClaims(item);
            rec.claimVer = item.version;
            touched = true;
            dbg('[pickcat-workshop] 已补登记接管项：', id, item.claims.map((c) => c.key).join(', '));
        }
        if (touched) {
            await saveState();
            loadAllConfigs();
            if (panelRefreshHook) { try { panelRefreshHook(); } catch (e) { /* ignore */ } }
        }
    }

    async function mount(root) {
        if (!mount.__iconGuard) {
            mount.__iconGuard = true;
            // 图床图挂了就退回 emoji，别留个破图占位
            document.addEventListener('error', function (e) {
                const t = e.target;
                if (!t || t.tagName !== 'IMG' || !t.parentElement) return;
                if (!t.parentElement.classList.contains('ws-ico')) return;
                t.parentElement.classList.remove('ws-ico');
                t.parentElement.textContent = '🖼';
            }, true);
        }
        shadow = root;
        wsRoot = root;
        els.grid = root.getElementById('wsGrid');
        els.chips = root.getElementById('wsChips');
        els.search = root.getElementById('wsSearch');
        els.safeMode = root.getElementById('wsSafeMode');
        els.status = root.getElementById('wsStatusText');
        els.refresh = root.getElementById('wsRefresh');
        els.tier = root.getElementById('wsTier');
        els.tierHint = root.getElementById('wsTierHint');
        els.updateAll = root.getElementById('wsUpdateAll');
        if (!els.grid) return;
        try {
            dbg('[pickcat-workshop] 工坊就绪 · v' + chrome.runtime.getManifest().version +
                ' · 逃生开关=' + (state.safeMode ? '开' : '关'));
        } catch (e) { /* ignore */ }

        bind();

        const res = await get([WS_STATE_KEY]);
        state = res[WS_STATE_KEY] && typeof res[WS_STATE_KEY] === 'object'
            ? Object.assign({ installed: {}, safeMode: false, pausedSkin: null }, res[WS_STATE_KEY])
            : { installed: {}, safeMode: false, pausedSkin: null };
        if (!state.installed) state.installed = {};

        const dataKeys = Object.keys(state.installed).map((id) => WS_DATA_PREFIX + id);
        const dataRes = dataKeys.length ? await get(dataKeys) : {};
        dataKeys.forEach((k) => { pluginData[k.replace(WS_DATA_PREFIX, '')] = dataRes[k] || {}; });

        // 沙盒等级：默认「均衡」，只有用户明确签过免责协议才会是「自由」
        try {
            const tRes = await get([TIER_KEY]);
            currentTier = TIERS.indexOf(tRes[TIER_KEY]) >= 0 ? tRes[TIER_KEY] : 'balanced';
        } catch (e) { currentTier = 'balanced'; }
        syncTierUI();

        await loadCatalog();
        render();
        await syncClaimsFromCatalog();

        if (els.tier) els.tier.addEventListener('change', (e) => setTier(e.target.value));

        // 刷新页面后把皮肤重新贴回去（纯 CSS / 装饰件，不依赖插件沙盒）
        // 但「应急逃生」开着时不要贴 —— 那个开关的语义就是「现在别给我任何效果」。
        if (state.safeMode) {
            if (state.skin && state.skin.id && !state.pausedSkin) state.pausedSkin = state.skin.id;
            removeSkin();
        } else if (state.skin && state.skin.id) {
            const skinItem = itemById(state.skin.id);
            if (skinItem) await applySkin(skinItem);
        }

        if (runningCount() > 0) runPlugins();
    }

    function onTabOpen() {
        if (!els.grid) return;
        render();
        // 打开工坊不设门槛：逛市场、看主题都不需要签任何东西。
        // 需要确认的只有一件事 —— 让第三方代码在你页面上跑起来（装插件那一刻）。
        // 这里只留一句一次性提醒，不拦路。
        if (!hintShown) {
            hintShown = true;
            readConsent().then((signed) => {
                if (!signed) toast('装「主题」不用确认；装「插件」（会跑代码）时会请你看一次说明，签一次就够喵。', 8000);
            }).catch(() => { });
        }
    }

    /* 整页工坊（workshop.html）通过 background/tabs 消息调进这里。
       为什么让页面转手给内容脚本：注入 CSS、起沙盒、摘皮肤都只有页面上下文能做。 */
    async function cmd(op, payload) {
        const p = payload || {};
        if (op === 'ping') {
            return { ok: true, version: (function () { try { return chrome.runtime.getManifest().version; } catch (e) { return ''; } })(), installed: Object.keys(state.installed).length };
        }
        if (op === 'install') {
            const item = itemById(p.id);
            if (!item) return { ok: false, error: '清单里没有这个条目（可能已下架）' };
            if (isInstalled(p.id)) return { ok: true, already: true };
            await install(item, { skipConfirm: !!p.skipConfirm });
            return { ok: isInstalled(p.id) };
        }
        if (op === 'uninstall') {
            await uninstall(p.id);
            return { ok: !isInstalled(p.id) };
        }
        if (op === 'update') {
            const upItem = itemById(p.id);
            if (!upItem) return { ok: false, error: '清单里没有这个条目（可能已下架）' };
            if (!isInstalled(p.id)) return { ok: false, error: '它还没装呢' };
            await updateItem(upItem);
            return { ok: true };
        }
        if (op === 'toggle') {
            await togglePlugin(p.id);
            return { ok: true };
        }
        if (op === 'refresh') {
            await refreshCommunity(null);
            return { ok: true, total: catalog.length };
        }
        return { ok: false, error: '未知操作：' + op };
    }

    // 整页工坊发来的指令（content script 与扩展页共享 runtime）
    try {
        chrome.runtime.onMessage.addListener((msg, sender, reply) => {
            if (!msg || msg.type !== 'pickcat-ws') return false;
            if (sender && sender.id && sender.id !== chrome.runtime.id) return false;
            cmd(msg.op, msg.payload)
                .then((r) => reply(r || { ok: false }))
                .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
            return true;   // 异步回包
        });
    } catch (e) { /* 扩展上下文失效时忽略 */ }

    return { mount: mount, onTabOpen: onTabOpen, onPluginTab: onPluginTab, run: runPlugins, toast: toast };
})();

/* ==========================================================================
   模块 7：版本升级提示（只弹一次）
   说明：content script 拿不到 chrome.runtime.onInstalled，
        所以自己存一个「上次运行的版本号」来判断是升级还是首次安装。
   ========================================================================== */
(function initVersionNotice() {
    const VER_KEY = 'pickcat_app_version';
    // 旧版本（没有版本号标记）留下的痕迹，用来区分「升级」和「全新安装」
    const LEGACY_KEYS = ['pickcatBgUrl', 'pickcatMaskEnabled', 'pickcatCursor', 'pickcatCustomCursor'];

    function cmpVer(a, b) {
        const pa = String(a || '0').split('.');
        const pb = String(b || '0').split('.');
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const x = parseInt(pa[i], 10) || 0;
            const y = parseInt(pb[i], 10) || 0;
            if (x !== y) return x > y ? 1 : -1;
        }
        return 0;
    }

    function currentVersion() {
        try {
            if (chrome.runtime && chrome.runtime.getManifest) {
                return chrome.runtime.getManifest().version;
            }
        } catch (e) { /* 扩展被重载后旧上下文会抛错，忽略 */ }
        return '';
    }

    function show(text) {
        try {
            if (typeof Workshop !== 'undefined' && Workshop && Workshop.toast) {
                Workshop.toast(text, 9000);
            }
        } catch (e) { /* 面板还没建好就静默跳过 */ }
    }

    setTimeout(function () {
        const ver = currentVersion();
        if (!ver) return;
        try {
            chrome.storage.local.get([VER_KEY].concat(LEGACY_KEYS), function (res) {
                if (chrome.runtime.lastError) return;
                res = res || {};
                const prev = res[VER_KEY];
                const hasLegacy = LEGACY_KEYS.some(function (k) {
                    return res[k] !== undefined && res[k] !== '' && res[k] !== null;
                });

                if (prev && cmpVer(prev, ver) >= 0) return;   // 同版本或更旧，不打扰

                if (prev || hasLegacy) {
                    // 老用户升级：只说版本变化和新增了什么，不要吓唬人
                    // （以前这里写「加喵后缀需要重填」，但旧版 Pickcat-Plus 的键和新版同名同义，
                    //   背景/遮罩/指针全部自动继承；真正要重填的只有「独立的加喵插件」用户，
                    //   而那种用户是全新安装、storage 是空的，根本走不到这个分支，所以文案放在 README 里就好）
                    show('⚡ PICKCAT Plus 已更新到 v' + ver);
                } else {
                    // 全新安装：欢迎一下
                    show('🐾 欢迎使用 PICKCAT Plus v' + ver + '，点右边的小球开始折腾喵～');
                }

                try {
                    chrome.storage.local.set({ [VER_KEY]: ver });
                } catch (e) { /* 忽略 */ }
            });
        } catch (e) { /* 上下文失效，忽略 */ }
    }, 3000);
})();

