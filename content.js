console.log('🚀 PICKCAT Plus (稳定悬浮版) 已启动');

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
    let normal = cursorStyle === 'custom' && customBase64 ? customBase64 : safeGetURL(`cursors/${cursorStyle}.png`);
    cursorStyleTag.textContent = `
        html, body, div, span, p, h1, h2, h3, h4, h5, h6, li, ul, ol, table, tr, td, th, main, header, footer, section, article, textarea, input, a, button, [role="button"], select, option, summary, img, canvas, svg, video { cursor: url('${normal}'), auto !important; }
        a, a *, button, button *, [role="button"], .cursor-pointer, select, option, summary, [onclick], .btn { cursor: url('${normal}'), pointer !important; }
        input, textarea, [contenteditable="true"], p, span, .prose, .markdown-body { cursor: url('${normal}'), text !important; }
    `;
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
        ${hasBg ? `body, #__next, #root, .min-h-dvh { background-color: transparent !important; background-image: none !important; }` : ''}
        .pickcat-grid-layout { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 12px !important; width: 100% !important; }
        .pickcat-category-listified { display: flex !important; flex-direction: column !important; gap: 12px !important; width: 100% !important; }
        [data-pickcat-hidden] { display: none !important; }
    `;
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
function injectKitten4() {
    const existing = document.getElementById('pickcat-custom-kitten4');
    if (!config.kitten4) {
        // 关掉时要立刻消失，别等刷新
        if (existing) existing.remove();
        return;
    }
    if (existing) return;
    document.querySelectorAll('a').forEach(link => {
        if (link.id !== 'pickcat-custom-kitten4' && link.textContent.includes('KittenN')) {
            const p = link.parentNode;
            if (!p || !p.isConnected) return;
            const clone = link.cloneNode(true);
            clone.id = 'pickcat-custom-kitten4';
            clone.href = 'https://kitten4.codemao.cn/';
            clone.target = '_blank';
            const img = clone.querySelector('img');
            if (img) { img.src = safeGetURL('icons/kitten4.png'); img.style.objectFit = 'contain'; }
            const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
            let textNode;
            while ((textNode = walker.nextNode())) {
                if (textNode.nodeValue.includes('KittenN')) { textNode.nodeValue = textNode.nodeValue.replace('KittenN', 'Kitten4'); break; }
            }
            p.insertBefore(clone, link.nextSibling);
        }
    });
}

// 移除 Kitten4 克隆节点（开关从开到关时用）
function removeKitten4() {
    const node = document.getElementById('pickcat-custom-kitten4');
    if (node) node.remove();
}

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

function transformCreationCards() {
    if (!config.creationGrid) { revertCreationCards(); return; }

    const headings = Array.from(document.querySelectorAll('h2, h3, div')).filter(el => el.textContent.trim() === '创作');
    if (headings.length === 0) return;
    const heading = headings[0];

    const listContainer = heading.nextElementSibling;
    if (!listContainer || listContainer.tagName !== 'DIV') return;
    if (listContainer.classList.contains('pickcat-grid-layout')) return;

    const items = Array.from(listContainer.querySelectorAll('a')).filter(a => !a.hasAttribute(CLONE_FLAG));
    if (items.length === 0) return;

    listContainer.classList.add('pickcat-grid-layout');

    items.forEach(item => {
        const href = item.getAttribute('href');
        const titleText = item.querySelector('span.flex-1')?.textContent.trim() || item.textContent.trim();
        const imgSrc = item.querySelector('img')?.getAttribute('src');

        let descText = '';
        if (titleText.includes('Python') || titleText.includes('Py') || titleText.includes('海龟')) {
            descText = '学习python，如此简单';
        } else if (titleText.includes('Kitten4') || titleText.includes('K4')) {
            descText = '体验全新升级的源码编辑器';
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
                --primary: #4F46E5;
                --bg-glass: rgba(255, 255, 255, 0.85);
                --bg-card: rgba(255, 255, 255, 0.4);
                --text-main: #333;
                --text-muted: #888;
                --border: #eee;
                --switch-bg: #ccc;
                --panel-width: 520px;
                font-family: system-ui, -apple-system, sans-serif;
            }
            :host(.pickcat-dark) {
                --bg-glass: rgba(30, 30, 40, 0.85);
                --bg-card: rgba(255, 255, 255, 0.08);
                --text-main: #e5e7eb;
                --text-muted: #9ca3af;
                --border: rgba(255,255,255,0.1);
                --switch-bg: #4b5563;
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
            
            .nav-sidebar {
                width: 72px; border-right: 1px solid var(--border); display: flex;
                flex-direction: column; align-items: flex-start; padding: 16px 12px; gap: 12px; flex-shrink: 0;
                overflow: hidden; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); white-space: nowrap;
            }
            .nav-sidebar:hover { width: 180px; }

            .nav-item {
                display: flex; align-items: center; height: 48px; width: 48px;
                border-radius: 12px; cursor: pointer; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                color: var(--text-main); overflow: hidden;
            }
            .nav-sidebar:hover .nav-item { width: 100%; }
            .nav-item svg { width: 24px; height: 24px; fill: currentColor; flex-shrink: 0; margin-left: 12px; }
            .nav-item .nav-text {
                margin-left: 12px; font-size: 14px; font-weight: 500;
                opacity: 0; transition: opacity 0.2s 0.1s;
            }
            .nav-sidebar:hover .nav-text { opacity: 1; }
            .nav-item:hover { background: var(--bg-card); }
            .nav-item.active { background: var(--primary); color: white; }

            .content-area { flex: 1; padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 24px; }
            .tab-content { display: none; flex-direction: column; gap: 12px; }
            .tab-content.active { display: flex; }
            .section-title { font-size: 14px; font-weight: bold; color: var(--text-main); margin-bottom: 4px; }

            .row-card {
                background: var(--bg-card); border: 1px solid var(--border);
                border-radius: 12px; padding: 16px; display: flex; justify-content: space-between; align-items: center;
            }
            .row-info { display: flex; flex-direction: column; gap: 4px; }
            .row-title { font-size: 14px; font-weight: 600; color: var(--text-main); }
            .row-desc { font-size: 12px; color: var(--text-muted); }

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
            .ws-chip { padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-muted); font-size: 12px; cursor: pointer; }
            .ws-chip.active { border-color: var(--primary); color: var(--primary); background: rgba(79,70,229,0.12); font-weight: 600; }
            .ws-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
            .ws-card { border: 1px solid var(--border); background: var(--bg-card); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
            .ws-card-head { display: flex; align-items: center; gap: 6px; }
            .ws-emoji { font-size: 16px; line-height: 1; }
            .ws-name { font-size: 13px; font-weight: 600; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
            .ws-badge { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(34,197,94,0.15); color: #16a34a; white-space: nowrap; }
            .ws-badge.warn { background: rgba(245,158,11,0.15); color: #d97706; }
            .ws-preview { height: 32px; border-radius: 7px; border: 1px solid var(--border); }
            .ws-desc { font-size: 11.5px; line-height: 1.5; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
            .ws-tags { display: flex; gap: 4px; flex-wrap: wrap; }
            .ws-tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(99,102,241,0.12); color: var(--primary); }
            .ws-tag.danger { background: rgba(239,68,68,0.12); color: #ef4444; }
            .ws-actions { display: flex; gap: 6px; margin-top: 2px; }
            .ws-btn { flex: 1; padding: 6px 8px; font-size: 12px; border-radius: 7px; border: 1px solid var(--border); background: transparent; color: var(--text-main); cursor: pointer; transition: 0.2s; }
            .ws-btn:hover { border-color: var(--primary); color: var(--primary); }
            .ws-btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
            .ws-btn.primary:hover { opacity: 0.88; color: #fff; }
            .ws-btn.danger { background: #ef4444; border-color: #ef4444; color: #fff; }
            .ws-empty { grid-column: 1 / -1; text-align: center; color: var(--text-muted); font-size: 12.5px; padding: 26px 8px; line-height: 1.8; }
            .ws-settings { display: none; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px dashed var(--border); margin-top: 2px; }
            .ws-settings.open { display: flex; }
            .ws-settings label { font-size: 11px; color: var(--text-muted); }
            .ws-settings input { padding: 6px 8px; font-size: 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-glass); color: var(--text-main); outline: none; }
            .ws-settings .ws-hint { font-size: 10.5px; color: var(--text-muted); line-height: 1.5; }
            .ws-modal { position: fixed; inset: 0; z-index: 2147483003; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); }
            .ws-modal.open { display: flex; }
            .ws-modal-card { width: min(400px, 86vw); max-height: 78vh; overflow: auto; background: var(--bg-glass); border: 1px solid var(--border); border-radius: 14px; padding: 18px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
            .ws-modal-title { font-size: 15px; font-weight: 700; color: var(--text-main); margin: 0 0 6px; }
            .ws-modal-sub { font-size: 12px; color: var(--text-muted); margin: 0 0 12px; line-height: 1.6; }
            .ws-perm { display: flex; gap: 8px; font-size: 12px; padding: 7px 8px; border-radius: 8px; background: rgba(0,0,0,0.04); margin-bottom: 6px; color: var(--text-main); align-items: flex-start; }
            .ws-perm.high { background: rgba(239,68,68,0.1); }
            .ws-perm-txt { flex: 1; line-height: 1.5; }
            .ws-modal-foot { display: flex; gap: 8px; margin-top: 14px; }
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
                                <div class="row-title">Kitten4 快捷入口</div>
                                <div class="row-desc">在创作栏注入 K4 图标</div>
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
                        <div class="ws-top">
                            <input type="text" class="ws-search" id="wsSearch" placeholder="搜索主题 / 插件 / 作者…">
                        </div>
                        <div class="ws-status">
                            <span id="wsStatusText">已安装 0 个 · 运行中 0 个</span>
                            <label class="ws-safemode" title="安全模式：立刻停用所有插件，主题不受影响">
                                <input type="checkbox" id="wsSafeMode">
                                <span>⛑ 安全模式</span>
                            </label>
                        </div>
                        <div class="ws-chips" id="wsChips">
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
                        <div class="row-card" style="flex-direction: column; align-items: flex-start; gap: 12px;">
                            <h3 style="margin:0; color:var(--text-main);">PICKCAT Plus v2.1.1</h3>
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

    const navItems = shadow.querySelectorAll('.nav-item');
    const tabContents = shadow.querySelectorAll('.tab-content');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(i => i.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            item.classList.add('active');
            shadow.getElementById(item.dataset.tab).classList.add('active');
            if (item.dataset.tab === 'tab-workshop') {
                try { Workshop.onTabOpen(); } catch (e) { /* 工坊尚未挂载时忽略 */ }
            }
        });
    });

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
    const suffixSettingsArea = shadow.getElementById('suffix-settings-area');
    const suffixListEl = shadow.getElementById('suffixList');
    const newSuffixInput = shadow.getElementById('newSuffixInput');
    const addSuffixBtn = shadow.getElementById('addSuffixBtn');
    const suffixMode = shadow.getElementById('suffixMode');
    const randomToggle = shadow.getElementById('randomToggle');
    const resetAllBtn = shadow.getElementById('resetAllBtn');

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
        });
    }

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
        'pickcatHideCat', 'pickcatKitten4', 'pickcatCategoryList', 'pickcatCreationGrid'
    ], (res) => {
        config.hideCat = res.pickcatHideCat === true;
        config.kitten4 = res.pickcatKitten4 === true;
        config.categoryList = res.pickcatCategoryList === true;
        config.creationGrid = res.pickcatCreationGrid === true;

        config.bgUrl = res.pickcatBgUrl || '';
        config.bgBase64 = res.pickcatBgBase64 || '';
        config.maskEnabled = res.pickcatMaskEnabled === true;

        applyBackground(config.bgUrl, config.bgBase64, config.maskEnabled);
        
        let cursorStyle = res.pickcatCursor || 'default'; 
        if (['style4', 'style5'].includes(cursorStyle)) cursorStyle = 'default';
        injectCursorStyle(cursorStyle, res.pickcatCustomCursor || ''); 

        applyHideCat(config.hideCat);
        if (!config.kitten4) removeKitten4();
        injectKitten4();
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

const WS_PERM_DEFS = {
    'dom-read': { level: 'low', icon: '👀', label: '读取页面文字', desc: '只读当前页面的可见文字（用来取帖子正文）' },
    'ui-interaction': { level: 'low', icon: '🧩', label: '添加界面元素', desc: '在你页面上加按钮和结果卡片，不会改动站点原有元素' },
    'notify': { level: 'low', icon: '🔔', label: '弹出提示', desc: '右下角小提示，点一下就没' },
    'clipboard-write': { level: 'mid', icon: '📋', label: '写入剪贴板', desc: '只能写，不能读你剪贴板里的其他内容' },
    'storage': { level: 'mid', icon: '💾', label: '保存自己的配置', desc: '只写在插件自己的命名空间，读不到 PICKCAT 的其他设置' },
    'network': { level: 'high', icon: '🌐', label: '联网', desc: '仅限清单里声明的域名，白名单之外的请求会被硬拦' }
};

const Workshop = (function () {
    let shadow = null;
    let els = {};
    let catalog = [];
    let state = { installed: {}, safeMode: false };
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

    /* ---------------- 清单 ---------------- */

    async function loadCatalog() {
        try {
            const res = await fetch(chrome.runtime.getURL('workshop/builtin.json'));
            const json = await res.json();
            catalog = Array.isArray(json.items) ? json.items : [];
        } catch (e) {
            catalog = [];
            toast('工坊清单加载失败：' + (e && e.message || e));
        }
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

    function badgeOf(item) {
        if (item.verified === 'official') return '<span class="ws-badge">✅ 官方</span>';
        if (item.verified === 'reviewed') return '<span class="ws-badge">✅ 已审核</span>';
        return '<span class="ws-badge warn">⚠️ 未审核</span>';
    }

    function permsTags(item) {
        if (!item.permissions || !item.permissions.length) return '';
        return item.permissions.map((p) => {
            const d = WS_PERM_DEFS[p];
            const high = d && d.level === 'high' ? ' danger' : '';
            return `<span class="ws-tag${high}">${esc((d && d.icon) || '·')} ${esc(p)}</span>`;
        }).join('');
    }

    function cardHtml(item) {
        const inst = isInstalled(item.id);
        const rec = state.installed[item.id] || {};
        const preview = item.preview && item.preview.bg
            ? `<div class="ws-preview" style="background:${esc(item.preview.bg)}"></div>` : '';

        let actions = '';
        if (!inst) {
            actions = `<button class="ws-btn primary" data-act="install" data-id="${esc(item.id)}">安装</button>`;
        } else if (item.type === 'theme') {
            actions = `<button class="ws-btn danger" data-act="uninstall" data-id="${esc(item.id)}">卸载</button>`;
        } else {
            const on = rec.enabled !== false;
            actions =
                `<button class="ws-btn" data-act="toggle" data-id="${esc(item.id)}">${on ? '停用' : '启用'}</button>` +
                (item.settings ? `<button class="ws-btn" data-act="gear" data-id="${esc(item.id)}">⚙</button>` : '') +
                `<button class="ws-btn danger" data-act="uninstall" data-id="${esc(item.id)}">卸载</button>`;
        }

        let settings = '';
        if (inst && item.type === 'plugin' && item.settings) {
            settings = `<div class="ws-settings" data-settings="${esc(item.id)}">` +
                item.settings.map((f) => {
                    const val = ((pluginData[item.id] || {}).settings || {})[f.key];
                    const v = val !== undefined ? val : (f.default || '');
                    return `<label>${esc(f.label)}</label>` +
                        `<input type="${f.type === 'password' ? 'password' : 'text'}" data-field="${esc(f.key)}" ` +
                        `value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">`;
                }).join('') +
                `<div class="ws-hint">填入后自动保存。Key 只存在本机 chrome.storage，不会上传到任何服务器。</div>` +
                `</div>`;
        }

        return `<div class="ws-card" data-card="${esc(item.id)}">
            <div class="ws-card-head">
                <span class="ws-emoji">${esc(item.emoji || '📦')}</span>
                <span class="ws-name">${esc(item.name)}</span>
                ${badgeOf(item)}
            </div>
            ${preview}
            <div class="ws-desc">${esc(item.desc || '')}</div>
            <div class="ws-tags">${permsTags(item)}</div>
            <div class="ws-actions">${actions}</div>
            ${settings}
        </div>`;
    }

    function render() {
        if (!els.grid) return;
        const list = catalog.filter((i) => matchFilter(i) && matchKeyword(i));
        els.grid.innerHTML = list.length
            ? list.map(cardHtml).join('')
            : '<div class="ws-empty">没找到匹配的条目<br>换个关键词试试？</div>';

        const total = Object.keys(state.installed).length;
        els.status.textContent = `已安装 ${total} 个 · 运行中 ${runningCount()} 个`;
        els.safeMode.checked = !!state.safeMode;

        Array.prototype.forEach.call(els.chips.children, (c) => {
            c.classList.toggle('active', c.dataset.filter === filterCat);
        });
    }

    /* ---------------- 权限确认 ---------------- */

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

    function confirmInstall(item) {
        return new Promise((resolve) => {
            const modal = ensureModal();
            els.modalTitle.textContent = `安装「${item.name}」`;
            els.modalSub.textContent = item.type === 'theme'
                ? '这是一个主题包，纯数据、不含代码，会覆盖你当前的背景/指针设置（卸载时会还原）。'
                : '这是一个功能插件，代码将运行在受限沙盒里。它申请了以下能力：';

            if (item.type === 'theme') {
                els.modalList.innerHTML = '<div class="ws-perm"><span class="ws-perm-txt">🎨 修改背景图 / 遮罩 / 鼠标指针</span></div>';
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
                els.modalList.innerHTML = perms + hosts;
            }

            pendingConfirm = resolve;
            modal.classList.add('open');
        });
    }

    /* ---------------- 主题皮肤（纯 CSS 皮肤包） ---------------- */

    const SKIN_STYLE_ID = 'pickcat-ws-theme-style';
    let skinCssCache = null;

    function skinClassOf(item) {
        return item && item.htmlClass ? item.htmlClass : 'pickcat-theme-' + (item ? item.id : '');
    }

    function removeSkin() {
        const styleTag = document.getElementById(SKIN_STYLE_ID);
        if (styleTag) styleTag.remove();
        const active = state.skin;
        if (active && active.cls) document.documentElement.classList.remove(active.cls);
        state.skin = null;
    }

    async function fetchSkinCss(item) {
        if (item.css) return String(item.css);
        if (!item.cssFile) return '';
        if (skinCssCache && skinCssCache.id === item.id) return skinCssCache.css;
        const res = await fetch(chrome.runtime.getURL(item.cssFile));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const css = await res.text();
        // 防止样式表里塞 </style> 提前闭合标签
        skinCssCache = { id: item.id, css: css.replace(/<\/style/gi, '<\\/style') };
        return skinCssCache.css;
    }

    async function applySkin(item) {
        if (!item || (!item.css && !item.cssFile)) return true;
        let css = '';
        try {
            css = await fetchSkinCss(item);
        } catch (e) {
            console.warn('[pickcat] 主题样式加载失败：', e);
            toast('「' + item.name + '」的样式表加载失败');
            return false;
        }
        if (!css) return true;
        removeSkin();
        const styleTag = document.createElement('style');
        styleTag.id = SKIN_STYLE_ID;
        styleTag.textContent = css;
        (document.head || document.documentElement).appendChild(styleTag);
        const cls = skinClassOf(item);
        document.documentElement.classList.add(cls);
        state.skin = { id: item.id, cls: cls };
        return true;
    }

    /* ---------------- 安装 / 卸载 ---------------- */

    async function install(item) {
        const ok = await confirmInstall(item);
        if (!ok) return;

        if (item.type === 'theme') {
            const keys = Object.keys(item.apply || {});
            const prevRes = await get(keys);
            const prev = {};
            keys.forEach((k) => { prev[k] = prevRes[k]; });
            await set(item.apply || {});
            await applySkin(item);
            state.installed[item.id] = { type: 'theme', version: item.version, prev: prev, at: Date.now() };
        } else {
            state.installed[item.id] = {
                type: 'plugin',
                version: item.version,
                enabled: true,
                permissions: item.permissions || [],
                hosts: item.hosts || [],
                at: Date.now()
            };
            if (!pluginData[item.id]) {
                const defaults = {};
                (item.settings || []).forEach((f) => { if (f.default !== undefined) defaults[f.key] = f.default; });
                pluginData[item.id] = { settings: defaults };
                await savePluginData(item.id);
            }
        }

        await saveState();
        render();
        if (item.type === 'theme') {
            loadAllConfigs();
            toast(`已应用主题「${item.name}」`);
        } else {
            toast(`已安装「${item.name}」`);
            await runPlugins();
        }
    }

    async function uninstall(id) {
        const item = itemById(id);
        const rec = state.installed[id];
        if (!rec) return;

        if (rec.type === 'theme') {
            const prev = rec.prev || {};
            const patch = {};
            Object.keys(prev).forEach((k) => { patch[k] = prev[k] === undefined ? '' : prev[k]; });
            if (Object.keys(patch).length) await set(patch);
            if (state.skin && state.skin.id === id) removeSkin();
            loadAllConfigs();
        } else {
            sendToSandbox({ type: 'stop', payload: { id: id } });
            removePluginUi(id);
            await remove([WS_DATA_PREFIX + id]);
            delete pluginData[id];
        }

        delete state.installed[id];
        await saveState();
        render();
        toast(`已卸载「${item ? item.name : id}」`);
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
        state.safeMode = !!on;
        await saveState();
        if (state.safeMode) {
            Object.keys(state.installed).forEach((id) => {
                if (state.installed[id].type === 'plugin') {
                    sendToSandbox({ type: 'stop', payload: { id: id } });
                    removePluginUi(id);
                }
            });
            toast('⛑ 安全模式已开启，所有插件已停用');
        } else {
            toast('安全模式已关闭');
            await runPlugins();
        }
        render();
    }

    /* ---------------- 沙盒通信 ---------------- */

    function ensureSandbox() {
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
                    resolve();
                }
            }, 4000);
        });
    }

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
            console.log('[pickcat] 沙盒就绪：origin=' + self.origin + ' canEval=' + self.canEval + ' 已拦截网络 API=' + JSON.stringify(self.stubbedNet || []));
            if (self.netLeaked && self.netLeaked.length) {
                console.warn('[pickcat] 以下网络 API 的隔离桩未生效：' + self.netLeaked.join(', '));
            }
            frameReady = true;
            readyResolvers.splice(0).forEach((fn) => fn());
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
            else console.log('[pickcat-plugin:' + p.pluginId + ']', p.text);
            return;
        }
        if (d.type === 'plugin-unloaded') {
            removePluginUi((d.payload || {}).id);
            return;
        }
    });

    const NEED_PERM = {
        getPostContent: 'dom-read',
        addInteractionButton: 'ui-interaction',
        showCard: 'ui-interaction',
        updateCard: 'ui-interaction',
        closeCard: 'ui-interaction',
        showToast: 'notify',
        copy: 'clipboard-write',
        'storage.set': 'storage'
    };

    function handleCall(method, args, pluginId) {
        const rec = state.installed[pluginId];
        if (!rec || rec.type !== 'plugin') throw new Error('插件 ' + pluginId + ' 未安装或已停用');
        const need = NEED_PERM[method];
        if (need && (rec.permissions || []).indexOf(need) === -1) {
            throw new Error('插件没有申请「' + need + '」权限，调用被拒绝');
        }

        switch (method) {
            case 'getPostContent': return getPostContent();
            case 'addInteractionButton': return addButton(pluginId, args);
            case 'removeInteractionButton': removeButton(args.buttonId); return true;
            case 'showCard': return showCard(args);
            case 'updateCard': updateCard(args.cardId, args.text); return true;
            case 'closeCard': closeCard(args.cardId); return true;
            case 'showToast': toast(args.text); return true;
            case 'copy': return copyText(args.text);
            case 'storage.set': return saveStorage(pluginId, args.key, args.value);
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
            .pickcat-ws-card .ws-cf { display: flex; gap: 8px; padding: 8px 12px 12px; }
            .pickcat-ws-card .ws-cf button { flex: 1; padding: 7px; border-radius: 8px; border: 1px solid rgba(255,255,255,.16);
                background: transparent; color: #d7d9e3; font: 600 12px system-ui, sans-serif; cursor: pointer; }
            .pickcat-ws-card .ws-cf button:hover { border-color: #7c7cf0; color: #b9b9ff; }
            .pickcat-ws-card.loading .ws-cb::after { content: ''; display: inline-block; width: 9px; height: 9px; margin-left: 6px;
                border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: pickcat-spin .8s linear infinite; }
            @keyframes pickcat-spin { to { transform: rotate(360deg); } }
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
        Array.prototype.slice.call(document.querySelectorAll('#pickcat-ws-card-' + CSS.escape(pluginId))).forEach((c) => c.remove());
    }

    function showCard(args) {
        ensurePageStyle();
        const id = 'pickcat-ws-card-' + (++cardSeq);
        const el = document.createElement('div');
        el.className = 'pickcat-ws-card' + (args.loading ? ' loading' : '');
        el.id = id;
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

    async function loadPluginCode(item) {
        if (item.entry) {
            const res = await fetch(chrome.runtime.getURL(item.entry));
            if (!res.ok) throw new Error('读取插件代码失败：' + res.status);
            return await res.text();
        }
        if (item.url) {
            // 阶段 2 会改成“沙盒代取 + 指纹校验”，阶段 1 先只支持本地官方包
            throw new Error('远程插件将在阶段 2 支持');
        }
        throw new Error('该插件没有代码入口');
    }

    async function runPlugins() {
        if (state.safeMode) return;
        const targets = Object.keys(state.installed).filter((id) => {
            const rec = state.installed[id];
            return rec.type === 'plugin' && rec.enabled !== false;
        });
        if (!targets.length) return;

        await ensureSandbox();
        if (!frameReady) {
            console.warn('[pickcat-workshop] 沙盒未就绪，插件暂不启动');
            return;
        }

        for (const id of targets) {
            const rec = state.installed[id];
            const item = itemById(id);
            if (!item) continue;
            try {
                const code = await loadPluginCode(item);
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

        els.grid.addEventListener('click', (ev) => {
            const btn = ev.target.closest ? ev.target.closest('button[data-act]') : null;
            if (!btn) return;
            const id = btn.dataset.id;
            const act = btn.dataset.act;
            const item = itemById(id);
            if (act === 'install' && item) install(item);
            else if (act === 'uninstall') uninstall(id);
            else if (act === 'toggle') togglePlugin(id);
            else if (act === 'gear') {
                const box = els.grid.querySelector(`[data-settings="${CSS.escape(id)}"]`);
                if (box) box.classList.toggle('open');
            }
        });

        els.grid.addEventListener('change', (ev) => {
            const input = ev.target;
            if (!input || !input.dataset || !input.dataset.field) return;
            const card = input.closest('[data-card]');
            if (!card) return;
            const id = card.dataset.card;
            if (!pluginData[id]) pluginData[id] = {};
            if (!pluginData[id].settings) pluginData[id].settings = {};
            pluginData[id].settings[input.dataset.field] = input.value;
            savePluginData(id).then(() => {
                sendToSandbox({ type: 'storage-sync', payload: { id: id, data: pluginData[id] } });
                toast('已保存设置');
            });
        });
    }

    /* ---------------- 对外接口 ---------------- */

    async function mount(root) {
        shadow = root;
        els.grid = root.getElementById('wsGrid');
        els.chips = root.getElementById('wsChips');
        els.search = root.getElementById('wsSearch');
        els.safeMode = root.getElementById('wsSafeMode');
        els.status = root.getElementById('wsStatusText');
        if (!els.grid) return;

        bind();

        const res = await get([WS_STATE_KEY]);
        state = res[WS_STATE_KEY] && typeof res[WS_STATE_KEY] === 'object'
            ? Object.assign({ installed: {}, safeMode: false }, res[WS_STATE_KEY])
            : { installed: {}, safeMode: false };
        if (!state.installed) state.installed = {};

        const dataKeys = Object.keys(state.installed).map((id) => WS_DATA_PREFIX + id);
        const dataRes = dataKeys.length ? await get(dataKeys) : {};
        dataKeys.forEach((k) => { pluginData[k.replace(WS_DATA_PREFIX, '')] = dataRes[k] || {}; });

        await loadCatalog();
        render();

        // 刷新页面后把皮肤重新贴回去（纯 CSS，不依赖插件沙盒）
        if (state.skin && state.skin.id) {
            const skinItem = itemById(state.skin.id);
            if (skinItem && (skinItem.css || skinItem.cssFile)) {
                await applySkin(skinItem);
            } else if (state.skin.cls) {
                document.documentElement.classList.add(state.skin.cls);
            }
        }

        if (runningCount() > 0) runPlugins();
    }

    function onTabOpen() {
        if (!els.grid) return;
        render();
    }

    return { mount: mount, onTabOpen: onTabOpen, run: runPlugins, toast: toast };
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
                    show('⚡ PICKCAT Plus 已更新到 v' + ver + '：原来的设置都还在。新的「创意工坊」在侧栏第 4 个标签喵～');
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

