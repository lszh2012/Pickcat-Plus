/**
 * 把 GitHub Issue 表单（.github/ISSUE_TEMPLATE/workshop-submission.yml）解析成投稿 JSON。
 *
 * Issue 表单渲染出来的正文长这样：
 *   ### 名字
 *
 *   薄荷海
 *
 *   ### 代码内容（CSS 或 JS 全文，直接粘贴）
 *
 *   ```text
 *   .x { color: red }
 *   ```
 *
 * 所以「按 `### ` 切块 → 标签归一 → 取值」就够了。
 *
 * 用法：
 *   node tools/issue-to-submission.mjs --body-file body.md --out submission.json
 *   node tools/issue-to-submission.mjs --body-file body.md --print
 */

import { readFileSync, writeFileSync } from 'node:fs';

const LABELS = [
    { re: /用到的权限|permissions?/i, key: 'perms' },
    { re: /为什么需要这些权限/, key: 'why' },
    { re: /hosts\s*白名单|hosts/i, key: 'hosts' },
    { re: /htmlClass/i, key: 'htmlClass' },
    { re: /apply\s*设置|apply/i, key: 'apply' },
    { re: /作品类型/, key: 'kind' },
    { re: /^名字|^名称/, key: 'name' },
    { re: /^id/i, key: 'id' },
    { re: /署名/, key: 'author' },
    { re: /一句话简介|^简介/, key: 'desc' },
    { re: /代码内容|^代码/, key: 'code' },
    { re: /确认事项/, key: 'confirm' }
];

const NONE = ['_No response_', 'No response', '无', '空', ''];

function clean(text) {
    let t = String(text || '').trim();
    if (NONE.indexOf(t) >= 0) return '';
    // 去掉 ```lang ... ``` 包裹
    const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
    if (fence) t = fence[1];
    return t.trim();
}

function parseBody(body) {
    const out = {};
    if (!body) return out;

    // 按行扫描：遇到 `### xxx` 就开始一个新块
    const lines = String(body).replace(/\r\n/g, '\n').split('\n');
    let cur = null;
    let buf = [];
    const flush = () => {
        if (!cur) return;
        const key = LABELS.find((l) => l.re.test(cur));
        if (key && out[key.key] === undefined) {
            out[key.key] = buf.join('\n');
        }
    };
    for (const line of lines) {
        const m = line.match(/^###\s+(.+?)\s*$/);
        if (m) {
            flush();
            cur = m[1].trim();
            buf = [];
        } else if (cur) {
            buf.push(line);
        }
    }
    flush();

    Object.keys(out).forEach((k) => { out[k] = clean(out[k]); });
    return out;
}

function checkboxValues(raw) {
    const picked = [];
    String(raw || '').split('\n').forEach((line) => {
        const m = line.match(/^\s*-\s*\[(x|X)\]\s*(.+?)\s*$/);
        if (m) picked.push(m[2].trim());
    });
    return picked;
}

function parseHosts(raw) {
    return String(raw || '')
        .split(/[\n,)]+/)
        .map((s) => s.trim().replace(/^\*\./, '').replace(/[，。；]/g, ''))
        .filter((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s));
}

function safeJson(raw, fallback) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error('apply 里的 JSON 解析不了：' + (e && e.message));
    }
}

export function buildSubmission(fields) {
    const kindRaw = fields.kind || '';
    const type = /插件/.test(kindRaw) ? 'plugin' : 'theme';
    const id = String(fields.id || '').trim().toLowerCase();

    const sub = {
        type: type,
        id: id,
        name: String(fields.name || '').trim(),
        author: String(fields.author || '').trim(),
        desc: String(fields.desc || '').trim(),
        version: '1.0.0',
        code: String(fields.code || '').trim()
    };

    if (type === 'theme') {
        if (fields.htmlClass) sub.htmlClass = fields.htmlClass.trim();
        sub.apply = safeJson(fields.apply, {});
    } else {
        const perms = checkboxValues(fields.perms)
            .map((s) => s.split(/[（(]/)[0].trim())
            .filter(Boolean);
        sub.permissions = perms;
        sub.hosts = parseHosts(fields.hosts);
        sub.why = String(fields.why || '').trim();
    }

    return sub;
}

function main() {
    const args = process.argv.slice(2);
    const arg = (name) => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : '';
    };

    const bodyFile = arg('--body-file');
    if (!bodyFile) {
        console.error('用法：node tools/issue-to-submission.mjs --body-file body.md [--out submission.json] [--print]');
        process.exit(2);
    }

    const body = readFileSync(bodyFile, 'utf8');
    const fields = parseBody(body);
    let sub;
    try {
        sub = buildSubmission(fields);
    } catch (e) {
        console.error('❌ ' + (e && e.message));
        process.exit(1);
    }

    if (!sub.id || !sub.name || !sub.code) {
        console.error('❌ 投稿信息不完整：id / 名字 / 代码内容 都是必填的');
        console.error('   解析到：' + JSON.stringify(Object.keys(fields)));
        process.exit(1);
    }

    if (args.indexOf('--print') >= 0) {
        console.log(JSON.stringify(sub, null, 2));
        return;
    }

    const out = arg('--out') || 'submission.json';
    writeFileSync(out, JSON.stringify(sub, null, 2) + '\n', 'utf8');
    console.log('✅ 已生成 ' + out + '（' + sub.type + ' · ' + sub.id + '）');
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('issue-to-submission.mjs')) {
    main();
}
