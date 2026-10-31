#!/usr/bin/env node
/**
 * 校验撤回表 workshop/revoked.json。
 *
 * 撤下架是个「紧急操作」，最怕的就是手忙脚乱的时候把 JSON 写坏了 ——
 * 写坏之后客户端拉到的就是空表，等于所有下架全部失效。所以这里查得很死：
 *   - 文件必须是合法 JSON
 *   - id 必须符合命名规则
 *   - 每条必须有 reason（写给人看的，不能空着）
 *   - 顺便提示：撤一个不存在于任何清单的 id，多半是打错字了
 *
 *   node tools/validate-revoked.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const FILE = 'workshop/revoked.json';
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;

function loadCatalogIds() {
    const ids = {};
    for (const f of ['workshop/builtin.json', 'workshop/community.json']) {
        try {
            const json = JSON.parse(readFileSync(f, 'utf8'));
            (json.items || []).forEach((i) => { if (i && i.id) ids[i.id] = 1; });
        } catch (e) { /* 清单坏了是另一份检查的事 */ }
    }
    return ids;
}

function main() {
    if (!existsSync(FILE)) {
        console.error('❌ 找不到 ' + FILE);
        process.exit(1);
    }

    let json;
    try {
        json = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch (e) {
        console.error('❌ ' + FILE + ' 不是合法 JSON：' + (e && e.message));
        console.error('   紧急情况下这份文件写坏 = 所有下架失效，请先跑一次 node -e "JSON.parse(require(\'fs\').readFileSync(\'workshop/revoked.json\',\'utf8\'))"');
        process.exit(1);
    }

    const errors = [];
    const warns = [];

    if (json.schema !== 1) errors.push('schema 必须是 1（现在是 ' + json.schema + '）');
    const items = json.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
        errors.push('items 必须是一个对象：{ "条目id": { "reason": "...", "at": "..." } }');
    }

    const known = loadCatalogIds();
    const ids = items && typeof items === 'object' ? Object.keys(items) : [];

    ids.forEach((id) => {
        if (!ID_RE.test(id)) errors.push('id 不合法：' + id);
        const rec = items[id];
        if (!rec || typeof rec !== 'object') {
            errors.push(id + ' 的值必须是 { reason, at }');
            return;
        }
        if (!rec.reason || !String(rec.reason).trim()) {
            errors.push(id + ' 缺少 reason（写清楚为什么下架，用户会看到这句话）');
        } else if (String(rec.reason).length > 120) {
            warns.push(id + ' 的 reason 超过 120 字，客户端会截断');
        }
        if (rec.at && !/^\d{4}-\d{2}-\d{2}/.test(String(rec.at))) {
            warns.push(id + ' 的 at 不是 ISO 日期（形如 2026-11-02T10:00:00Z）');
        }
        if (!known[id]) {
            warns.push(id + ' 不在任何清单里 —— 确认一下 id 有没有打错（下架一个不存在的条目不会有任何效果）');
        }
    });

    if (errors.length) {
        errors.forEach((e) => console.error('❌ ' + e));
        console.error('\n结果：❌ 撤回表有 ' + errors.length + ' 个问题');
        process.exit(1);
    }

    warns.forEach((w) => console.warn('⚠️  ' + w));
    console.log('✅ 撤回表检查通过（当前下架 ' + ids.length + ' 条）' + (ids.length ? '：' + ids.join(', ') : ''));
}

main();
