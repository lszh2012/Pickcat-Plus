console.log('🚀 PICKCAT Plus 已启动');

// ==========================================
// 1. 鼠标指针注入（单箭头与自定义）
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

    // 获取指针路径
    let normal = '';
    if (cursorStyle === 'custom' && customBase64 && customBase64.startsWith('data:image')) {
        normal = customBase64;
    } else {
        // style1, style2, style3, style6 默认读取 styleX.png
        normal = chrome.runtime.getURL(`cursors/${cursorStyle}.png`);
    }

    // 统一映射：因为没有全套，所有交互点都使用同一个指针，但保留 pointer/text 的语义
    let cssText = `
        html, body, div, span, p, h1, h2, h3, h4, h5, h6, li, ul, ol, table, tr, td, th, main, header, footer, section, article, textarea, input, a, button, [role="button"], select, option, summary, img, canvas, svg, video {
            cursor: url('${normal}'), auto !important;
        }
        a, a *, button, button *, [role="button"], .cursor-pointer, select, option, summary, [onclick], .btn {
            cursor: url('${normal}'), pointer !important;
        }
        input, textarea, [contenteditable="true"], p, span, .prose, .markdown-body {
            cursor: url('${normal}'), text !important;
        }
    `;

    cursorStyleTag.textContent = cssText;
    console.log(`✅ 鼠标指针注入成功:`, cursorStyle);
}

// ==========================================
// 2. 背景与遮罩
// ==========================================
function applyBackground(bgUrl, maskEnabled) {
    if (!bgUrl || bgUrl.length < 5) {
        document.documentElement.style.removeProperty('background-image');
    } else {
        let finalBgImage = `url('${bgUrl}')`;
        if (maskEnabled) {
            const isDarkMode = document.documentElement.classList.contains('dark');
            const maskColor = isDarkMode ? 'rgba(15, 15, 15, 0.85)' : 'rgba(255, 255, 255, 0.85)';
            finalBgImage = `linear-gradient(${maskColor}, ${maskColor}), url('${bgUrl}')`;
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
        body, #__next, #root, .bg-canvas, .min-h-dvh { 
            background-color: transparent !important; 
            background-image: none !important; 
        } 
        img[src*="home-decoration"], img[src*="search-decoration"] { 
            display: none !important; 
        }
    `;
}

// ==========================================
// 3. 注入 Kitten4 (不覆盖KN)
// ==========================================
function injectKitten4() {
    if (document.getElementById('pickcat-custom-kitten4')) return;
    const links = document.querySelectorAll('a');
    for (let link of links) {
        if (link.id !== 'pickcat-custom-kitten4' && link.textContent.includes('KittenN')) {
            const clone = link.cloneNode(true);
            clone.id = 'pickcat-custom-kitten4';
            clone.href = 'https://kitten4.codemao.cn/';
            clone.target = '_blank';
            
            const img = clone.querySelector('img');
            if (img) {
                img.src = 'https://pic1.imgdb.cn/i/034hpkyOpuw8Chd1mYXPav.png';
                img.style.objectFit = 'contain';
            }
            
            const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
            let textNode;
            while ((textNode = walker.nextNode())) {
                if (textNode.nodeValue.includes('KittenN')) {
                    textNode.nodeValue = textNode.nodeValue.replace('KittenN', 'Kitten4');
                    break;
                }
            }
            
            link.parentNode.insertBefore(clone, link.nextSibling);
            break; 
        }
    }
}

// ==========================================
// 4. 帖子外链
// ==========================================
function processLinks() {
    const currentHost = window.location.hostname;
    document.querySelectorAll('a').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href.includes('/forum/category/')) return;
        const isExternal = !href.startsWith('#') && !href.includes(currentHost) && !href.startsWith('javascript:') && !href.startsWith('/');
        if (isExternal) {
            link.setAttribute('target', '_blank');
            if (!link.dataset.externalHooked) {
                link.dataset.externalHooked = 'true';
                link.addEventListener('click', function(e) {
                    if (e.button === 0) { 
                        e.preventDefault(); 
                        e.stopPropagation(); 
                        window.open(href, '_blank'); 
                    }
                });
            }
        }
    });
}

// ==========================================
// 5. 初始化与监听
// ==========================================
function init() {
    chrome.storage.local.get(['pickcatBgUrl', 'pickcatMaskEnabled', 'pickcatCursor', 'pickcatCustomCursor'], (res) => {
        const bgUrl = res.pickcatBgUrl || '';
        const maskEnabled = res.pickcatMaskEnabled !== undefined ? res.pickcatMaskEnabled : true;
        
        // 容错：如果用户之前存过 style4/style5，强制回退到 default
        let cursorStyle = res.pickcatCursor || 'default'; 
        if (['style4', 'style5'].includes(cursorStyle)) {
            cursorStyle = 'default';
        }
        
        const customCursor = res.pickcatCustomCursor || '';
        
        applyBackground(bgUrl, maskEnabled);
        injectCursorStyle(cursorStyle, customCursor); 
    });
    processLinks();
    injectKitten4();
}

function startApp() {
    if (!document.body) { 
        setTimeout(startApp, 50); 
        return; 
    }
    
    const observer = new MutationObserver(() => { 
        processLinks(); 
        injectKitten4(); 
    });
    observer.observe(document.body, { childList: true, subtree: true });
    
    init();
}

startApp();

chrome.storage.onChanged.addListener((changes) => {
    if (changes.pickcatBgUrl || changes.pickcatMaskEnabled || changes.pickcatCursor || changes.pickcatCustomCursor) { 
        init(); 
    }
});