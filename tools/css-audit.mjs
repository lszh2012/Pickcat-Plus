/**
 * PICKCAT Plus —— 主题样式白名单审计
 *
 * 为什么要「白名单」而不是「黑名单」：
 *   黑名单只能拦住你已经想到的写法，而 CSS 能做的事比大多数人想的多——
 *   铺一层全屏覆盖做视觉钓鱼、用 pointer-events 让真按钮点不到、
 *   用 content 凭空造出假文字、用 cursor 换成「手型/输入框」骗点击。
 *   这些都没有关键词可以抓，只能反过来规定「允许什么」。
 *
 * 用法（被 tools/validate.mjs 和 GitHub Action 共用）：
 *   import { auditCss } from './css-audit.mjs';
 *   const problems = auditCss(css, { id: 'theme-xxx' });
 *   // problems: [{ level:'error'|'warn', msg }]
 *
 * 作用域规则：每条选择器都必须以 `html.<htmlClass>` 开头，
 * 其中 htmlClass 默认 `pickcat-theme-<id>`（与 content.js 的 skinClassOf 保持一致）。
 * 这样一份样式表只能改「这个主题自己的世界」，碰不到扩展的面板和别的主题。
 */

/** 允许声明的属性（前缀匹配，`*` 表示任意后缀） */
const PROP_ALLOW = [
    'color',
    'background*',
    'border*',
    'border-radius*',
    'box-shadow*',
    'outline*',
    'font*',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-decoration*',
    'text-shadow*',
    'text-align',
    'text-transform',
    'text-overflow',
    'white-space',
    'opacity',
    'accent-color',
    'caret-color',
    'scrollbar*',
    'transition*',
    'animation*',
    'transform',
    'transform-origin',
    'transform-style',
    'perspective',
    'backdrop-filter',
    'filter',
    'fill',
    'stroke',
    'stroke-width',
    'list-style*',
    'padding*',
    'margin*',
    'gap',
    'row-gap',
    'column-gap',
    'display',
    'align-items',
    'align-content',
    'align-self',
    'justify-content',
    'justify-items',
    'justify-self',
    'flex*',
    'grid*',
    'width',
    'height',
    'min-width',
    'min-height',
    'max-width',
    'max-height',
    'top',
    'left',
    'right',
    'bottom',
    'position',
    'overflow*',
    'object-fit',
    'object-position',
    'visibility',
    'content-visibility',
    'cursor',
    'mix-blend-mode',
    'isolation',
    'column-count',
    'column-gap',
    'column-rule*',
    'columns',
    'aspect-ratio',
    'box-sizing',
    'contain',
    'will-change',
    'user-select',
    'shape-rendering',
    'mask*',
    'color-scheme',
    'transform-box',
    'transform-origin',
    'text-wrap',
    'scroll-behavior',
    'overscroll-behavior*',
    'content',
    'z-index',
    'pointer-events'
];

/**
 * 明确禁止的属性（哪怕在上面的前缀表里命中）
 * 注意：content / position / z-index / pointer-events 不在这里——它们在伪元素上是合法装饰手段，
 * 由 valueProblem() 按上下文单独判定。
 */
const PROP_DENY = ['behavior', 'clip', 'clip-path', 'mask-image', 'inset', 'float', 'resize'];

const BANNED_TEXT = [
    { re: /@import/i, msg: '禁止 @import（外部样式可以拿来追踪用户）' },
    { re: /@font-face/i, msg: '禁止 @font-face（会向外部拉字体文件）' },
    { re: /@document/i, msg: '禁止 @document' },
    { re: /@namespace/i, msg: '禁止 @namespace' },
    { re: /expression\s*\(/i, msg: '禁止 expression()' },
    { re: /-moz-binding/i, msg: '禁止 -moz-binding' },
    { re: /javascript\s*:/i, msg: '禁止 javascript: 协议' },
    { re: /<\s*\/?\s*(script|iframe|style|link|object|embed|meta)/i, msg: '禁止在样式里写标签' },
    { re: /-webkit-(image-set|-moz)/i, msg: '禁止 image-set（可绕过 url() 检查拉外部图）' }
];

const URL_RE = /url\(\s*['"]?([^)'"]*)/gi;

function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function propAllowed(prop) {
    const p = prop.toLowerCase().trim();
    if (!p) return true;
    if (PROP_DENY.indexOf(p) >= 0) return false;
    // 自定义属性（--xxx）也允许，主题靠它改站点的 CSS 变量
    if (p.indexOf('--') === 0) return true;
    for (let i = 0; i < PROP_ALLOW.length; i++) {
        const rule = PROP_ALLOW[i];
        if (rule.indexOf('*') >= 0) {
            const prefix = rule.slice(0, -1);
            if (p.indexOf(prefix) === 0) return true;
        } else if (p === rule) {
            return true;
        }
    }
    return false;
}

/** 把一条声明的值做红线检查。pseudo = 这条规则作用在 ::before / ::after 上 */
function valueProblem(prop, value, pseudo) {
    const v = String(value || '').trim();
    const p = prop.toLowerCase();

    // url() 只允许 data:image/*
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(v))) {
        const u = (m[1] || '').trim();
        if (!/^data:image\//i.test(u)) {
            return '只允许 data:image/* 的内联图片，不允许外部地址（' + (u.slice(0, 40) || '空') + '）';
        }
    }

    // position：伪元素上可以是 absolute（做贴角装饰），真实元素只能 relative/static/sticky
    if (p === 'position') {
        if (/^\s*(fixed)\s*$/i.test(v)) return '禁止 position: fixed（能铺满屏幕覆盖内容）';
        if (/^\s*(absolute)\s*$/i.test(v) && !pseudo) {
            return 'position: absolute 只允许用在 ::before / ::after 这类装饰伪元素上';
        }
    }

    // content：只允许伪元素 + 一段引号里的文字（emoji / 符号），不许 attr() / url()
    if (p === 'content') {
        if (!pseudo) return 'content 只能用在 ::before / ::after 上';
        if (/attr\s*\(/i.test(v)) return 'content 里不允许 attr()（会把页面数据读出来当文字显示）';
        if (/url\s*\(/i.test(v)) return 'content 里不允许 url()';
        if (!/^(['"])[\s\S]*\1$/.test(v) && !/^(none|normal)$/i.test(v) && !/^counter\s*\(/i.test(v)) {
            return 'content 只能是一段引号里的文字（现在是 ' + v.slice(0, 30) + '）';
        }
    }

    // z-index：只允许伪元素上的小数值
    if (p === 'z-index') {
        if (!pseudo) return 'z-index 只能用在 ::before / ::after 上';
        const n = Number(v);
        if (!isFinite(n) || Math.abs(n) > 30) return 'z-index 只能用在 ::before / ::after 上，且数值要在 -30 ~ 30 之间（现在是 ' + v + '）';
    }

    // pointer-events：只允许 none（让装饰不吃鼠标事件），禁止 auto/all
    if (p === 'pointer-events') {
        if (!/^\s*none\s*$/i.test(v)) return 'pointer-events 只允许 none（现在 ' + v + '）';
    }

    // 尺寸类属性不允许用视口单位铺满屏幕
    if (['top', 'left', 'right', 'bottom', 'width', 'height', 'inset'].indexOf(p) >= 0) {
        if (/\b100(vw|vh|dvw|dvh|svh|lvh)\b/i.test(v)) {
            return '不允许用 100vw / 100vh 这种铺满屏幕的尺寸（' + p + ': ' + v + '）';
        }
    }

    if (p === 'cursor') {
        if (/url\s*\(/i.test(v)) return 'cursor 只能用关键字（不允许 url()）';
    }

    if (p === 'filter' || p === 'backdrop-filter') {
        if (/url\s*\(/i.test(v)) return 'filter 里不允许 url()';
    }

    return '';
}

/** 选择器检查：必须以 html.<htmlClass> 开头 */
function selectorProblem(sel, htmlClass) {
    const s = sel.trim();
    if (!s) return '选择器为空';
    if (s.indexOf(':root') >= 0) return '禁止使用 :root（会改到全局变量）';
    if (/(^|[\s,>+~])html\s*(\.|$|\{)/.test(s) && s.indexOf('html.' + htmlClass) !== 0) {
        return '选择器必须挂在 html.' + htmlClass + ' 下（现在是 ' + s.slice(0, 60) + '）';
    }
    if (s.indexOf('html.' + htmlClass) !== 0) {
        return '选择器必须以 html.' + htmlClass + ' 开头（现在是 ' + s.slice(0, 60) + '）';
    }
    // 不许命中扩展自己的 UI
    if (/\.pickcat-(settings|ws-|custom-|floating|hover|plugin-bar)/.test(s) || s.indexOf('#pickcat-') >= 0) {
        return '不允许改扩展自己的界面（' + s.slice(0, 60) + '）';
    }
    return '';
}

/**
 * 审计一份主题样式
 * @param {string} css
 * @param {{id?:string, htmlClass?:string}} opts
 * @returns {{level:'error'|'warn', msg:string}[]}
 */
export function auditCss(css, opts) {
    const o = opts || {};
    const id = o.id || '';
    const htmlClass = o.htmlClass || (id ? 'pickcat-theme-' + id : '');
    const out = [];
    const err = (msg) => out.push({ level: 'error', msg: msg });
    const warn = (msg) => out.push({ level: 'warn', msg: msg });

    if (!css || !String(css).trim()) {
        err('样式是空的');
        return out;
    }
    if (css.length > 65536) {
        err('样式超过 64KB（现在 ' + Math.round(css.length / 1024) + 'KB）');
        return out;
    }

    const body = stripComments(css);

    for (let i = 0; i < BANNED_TEXT.length; i++) {
        if (BANNED_TEXT[i].re.test(body)) err(BANNED_TEXT[i].msg);
    }

    // ---- 极简 CSS 解析：支持裸规则、@media/@supports 包裹、@keyframes ----
    let i = 0;
    let rules = 0;
    let depthGuard = 0;

    function parseBlock(text, insideAt) {
        let idx = 0;
        while (idx < text.length) {
            // 找下一个 '{'
            const open = text.indexOf('{', idx);
            if (open < 0) break;
            const head = text.slice(idx, open).trim();
            // 找配对的 '}'
            let depth = 1;
            let p = open + 1;
            while (p < text.length && depth > 0) {
                if (text[p] === '{') depth++;
                else if (text[p] === '}') depth--;
                p++;
            }
            const inner = text.slice(open + 1, p - 1);
            idx = p;

            if (!head) continue;

            if (head[0] === '@') {
                const atName = (head.match(/^@([a-z-]+)/i) || [])[1] || '';
                const lower = atName.toLowerCase();
                if (lower === 'media' || lower === 'supports' || lower === 'layer') {
                    if (depthGuard > 2) {
                        err('@' + atName + ' 嵌套太深');
                        continue;
                    }
                    depthGuard++;
                    parseBlock(inner, true);
                    depthGuard--;
                } else if (lower === 'keyframes' || lower === '-webkit-keyframes') {
                    rules++;
                    scanDeclarations(inner, 'keyframes');
                } else {
                    err('不允许的 @ 规则：@' + atName);
                }
                continue;
            }

            rules++;
            if (rules > 500) {
                err('规则数量超过 500 条，请精简');
                break;
            }

            // 选择器
            const sels = head.split(',');
            for (let s = 0; s < sels.length; s++) {
                const prob = selectorProblem(sels[s], htmlClass || 'pickcat-theme-xxx');
                if (prob) {
                    err(prob);
                    break;
                }
            }

            scanDeclarations(inner, head.slice(0, 40), /::(before|after|marker)\b/i.test(head));
        }
    }

    function scanDeclarations(block, where, pseudo) {
        // 去掉花括号里的嵌套规则（keyframes 内部形如 `0% { ... }`）
        const flat = block.replace(/\{[^{}]*\}/g, '');
        const decls = flat.split(';');
        for (let d = 0; d < decls.length; d++) {
            const line = decls[d];
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const prop = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim();
            if (!prop) continue;
            if (!propAllowed(prop)) {
                err('不允许的属性：' + prop + '（在 ' + where + '）');
                continue;
            }
            const vp = valueProblem(prop, value, !!pseudo);
            if (vp) err(vp + '（在 ' + where + '）');
        }
    }

    parseBlock(body, false);

    if (rules === 0) err('没有解析到任何样式规则，检查一下花括号是否配对');

    // 花括号平衡
    let open = 0;
    for (let k = 0; k < body.length; k++) {
        if (body[k] === '{') open++;
        else if (body[k] === '}') open--;
        if (open < 0) break;
    }
    if (open !== 0) err('花括号不配对（多出来 ' + Math.abs(open) + ' 个）');

    if (!out.length) warn('没有发现问题，但机器只能查规则，审美还是得作者自己把关');

    return out;
}

/** 生成一段给人看的报告 */
export function formatReport(id, problems) {
    const errors = problems.filter((p) => p.level === 'error');
    const warns = problems.filter((p) => p.level === 'warn');
    const lines = [];
    lines.push('主题 ' + id + '：' + (errors.length ? '❌ ' + errors.length + ' 个错误' : '✅ 通过'));
    errors.forEach((p) => lines.push('  ❌ ' + p.msg));
    warns.forEach((p) => lines.push('  ⚠️  ' + p.msg));
    return lines.join('\n');
}

export default { auditCss, formatReport };
