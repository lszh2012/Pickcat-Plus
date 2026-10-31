/**
 * 把一份投稿 JSON 落成仓库里的文件，并幂等地更新 workshop/community.json。
 *
 * 输入（由 tools/issue-to-submission.mjs 生成，或手写）：
 *   {
 *     "type": "theme" | "plugin",
 *     "id": "theme-xxx",
 *     "name": "名字",
 *     "author": "署名",
 *     "desc": "一句话简介",
 *     "version": "1.0.0",
 *     "code": "CSS 或 JS 全文",
 *     "htmlClass": "pickcat-theme-xxx",     // 主题可选
 *     "apply": { "pickcatBgUrl": "..." },   // 主题可选
 *     "permissions": ["dom-read"],           // 插件
 *     "hosts": ["api.example.com"],          // 插件
 *     "mode": "dark", "claims": [...], "settings": [...]   // 都可选
 *   }
 *
 * 用法：
 *   node tools/publish.mjs --input submission.json
 *   node tools/publish.mjs --input submission.json --dry-run
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { auditCss, formatReport } from './css-audit.mjs';

const CATALOG = 'workshop/community.json';
const PACKS = 'workshop/packs';
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;
const PLUGIN_BANNED = [
    { re: /\beval\s*\(/, msg: '禁止 eval(' },
    { re: /\bnew\s+Function\s*\(/, msg: '禁止 new Function(' },
    { re: /\bimport\s*\(/, msg: '禁止动态 import()' },
    { re: /\brequire\s*\(/, msg: '禁止 require(' },
    { re: /\bchrome\s*\./, msg: '禁止访问 chrome.*' },
    { re: /\bdocument\s*\./, msg: '禁止直接操作页面 DOM（用 PickcatPlus.getPostContent()）' },
    { re: /\bwindow\s*\.\s*parent\b/, msg: '禁止访问 window.parent' },
    { re: /\blocalStorage\b/, msg: '禁止使用 localStorage' },
    { re: /<script/i, msg: '禁止拼接 script 标签' }
];

function die(msg) {
    console.error('❌ ' + msg);
    process.exit(1);
}

function argOf(name, dflt) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : dflt;
}

export function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function auditPlugin(code, perms, hosts) {
    const problems = [];
    if (!code || !code.trim()) problems.push('插件代码是空的');
    if (Buffer.byteLength(code, 'utf8') > 200 * 1024) problems.push('插件超过 200KB');
    PLUGIN_BANNED.forEach((b) => {
        if (b.re.test(code)) problems.push(b.msg);
    });
    if (perms.indexOf('network') >= 0 && !hosts.length) {
        problems.push('声明了 network 权限但没有 hosts 白名单');
    }
    if (hosts.length && perms.indexOf('network') < 0) {
        problems.push('写了 hosts 但没声明 network 权限');
    }
    hosts.forEach((h) => {
        if (!/^[a-z0-9*.-]+\.[a-z]{2,}$/i.test(h)) problems.push('hosts 格式不对：' + h);
        if (h.replace('*.', '').indexOf('.') < 0) problems.push('hosts 不能是顶级域：' + h);
    });
    return problems;
}

function buildItem(sub) {
    const isTheme = sub.type === 'theme';
    const item = {
        id: sub.id,
        type: sub.type,
        name: sub.name,
        emoji: sub.emoji || (isTheme ? '🎨' : '🧩'),
        category: isTheme ? 'theme' : (sub.category || 'enhance'),
        author: sub.author || '匿名',
        version: sub.version || '1.0.0',
        verified: 'unverified',
        desc: String(sub.desc || '').slice(0, 240)
    };
    if (sub.mode && ['dark', 'light', 'any'].indexOf(sub.mode) >= 0) item.mode = sub.mode;

    if (isTheme) {
        item.cssFile = PACKS + '/' + sub.id + '.css';
        item.htmlClass = sub.htmlClass || ('pickcat-theme-' + String(sub.id).replace(/^theme[-_]/i, ''));
        item.apply = sub.apply || {};
    } else {
        item.entry = PACKS + '/' + sub.id + '.js';
        item.permissions = sub.permissions || [];
        item.hosts = sub.hosts || [];
        item.sha256 = sha256(sub.code);
        if (sub.settings) item.settings = sub.settings;
    }
    if (Array.isArray(sub.claims) && sub.claims.length) item.claims = sub.claims;
    return item;
}

export function upsertItem(catalog, item) {
    const items = Array.isArray(catalog.items) ? catalog.items.slice() : [];
    const idx = items.findIndex((i) => i && i.id === item.id);
    if (idx >= 0) items[idx] = item;
    else items.push(item);
    items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return Object.assign({}, catalog, {
        schema: catalog.schema || 1,
        updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        items: items
    });
}

function main() {
    const input = argOf('--input');
    const dryRun = process.argv.indexOf('--dry-run') >= 0;
    if (!input) die('用法：node tools/publish.mjs --input submission.json [--dry-run]');

    let sub;
    try {
        sub = JSON.parse(readFileSync(input, 'utf8'));
    } catch (e) {
        die('读不了 ' + input + '：' + (e && e.message));
    }

    // ---- 1. 基本字段 ----
    sub.id = String(sub.id || '').trim().toLowerCase();
    if (!ID_RE.test(sub.id)) die('id 不合法：' + sub.id + '（只能小写字母/数字/._-，2~49 位）');
    if (!sub.name) die('缺少名字');
    if (!sub.code) die('缺少代码内容');
    if (sub.type !== 'theme' && sub.type !== 'plugin') die('type 只能是 theme 或 plugin');

    // ---- 2. 内容审计 ----
    if (sub.type === 'theme') {
        const problems = auditCss(sub.code, { id: sub.id, htmlClass: sub.htmlClass || ('pickcat-theme-' + String(sub.id).replace(/^theme[-_]/i, '')) });
        const errors = problems.filter((p) => p.level === 'error');
        if (errors.length) {
            console.error(formatReport(sub.id, problems));
            die('样式没通过白名单审计，见上面的原因');
        }
    } else {
        const problems = auditPlugin(sub.code, sub.permissions || [], sub.hosts || []);
        if (problems.length) {
            problems.forEach((p) => console.error('❌ ' + p));
            die('插件没通过机器审查');
        }
    }

    // ---- 3. 写文件 ----
    const item = buildItem(sub);
    const target = sub.type === 'theme' ? item.cssFile : item.entry;
    const catalogRaw = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : { schema: 1, items: [] };
    const existed = (catalogRaw.items || []).some((i) => i && i.id === item.id);
    const next = upsertItem(catalogRaw, item);

    const plan = [
        (existed ? '♻️  更新 ' : '🆕 新增 ') + target + '（' + Buffer.byteLength(sub.code, 'utf8') + ' 字节）',
        '📋 community.json 条目数：' + (catalogRaw.items || []).length + ' → ' + next.items.length,
        '🕒 updated = ' + next.updated
    ];
    plan.forEach((l) => console.log(l));

    if (dryRun) {
        console.log('\n--dry-run：没有写入任何文件');
        return;
    }

    writeFileSync(target, sub.code.replace(/\r\n/g, '\n'), 'utf8');
    writeFileSync(CATALOG, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log('\n✅ 已发布：' + item.id + (item.sha256 ? '（sha256 ' + item.sha256.slice(0, 12) + '…）' : ''));
}

if (process.argv[1] && process.argv[1].endsWith('publish.mjs')) {
    main();
}
