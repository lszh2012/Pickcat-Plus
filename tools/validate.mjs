#!/usr/bin/env node
/**
 * PICKCAT Plus · 创意工坊清单校验器
 *
 * 用法（在仓库根目录执行）：
 *   node tools/validate.mjs
 *   node tools/validate.mjs workshop/community.json
 *
 * 它和扩展里 content.js 的 sanitizeItem() 用的是同一套规则：
 * 你本地能过，合并后大概率也能过。合并后仍以扩展里的校验为准（那才是最终防线）。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const target = process.argv[2] || 'workshop/community.json';

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;
const PATH_RE = /^[A-Za-z0-9._/-]+$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const PERMS = ['dom-read', 'ui-interaction', 'notify', 'clipboard-write', 'storage', 'network'];
const APPLY_KEYS = ['pickcatBgUrl', 'pickcatBgBase64', 'pickcatMaskEnabled', 'pickcatCursor', 'pickcatCustomCursor'];
const CURSORS = ['default', 'style1', 'style2', 'style3', 'style6', 'custom'];
const MAX_CSS = 65536;
const MAX_JS = 200 * 1024;

let errors = 0;
let warns = 0;
const fail = (m) => { errors++; console.log('  ❌ ' + m); };
const warn = (m) => { warns++; console.log('  ⚠️  ' + m); };
const ok = (m) => console.log('  ✅ ' + m);

function cssProblem(css) {
  if (css.length > MAX_CSS) return `样式超过 ${MAX_CSS} 字节`;
  // 先去掉注释再查：注释里写「不能 @import」不该被误杀
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const banned = [/@import/i, /behavior\s*:/i, /expression\s*\(/i, /-moz-binding/i, /javascript\s*:/i, /<\/?script/i];
  for (const re of banned) if (re.test(body)) return '含有被禁止的写法（@import / expression / javascript: 等）';
  const urls = body.match(/url\(\s*['"]?[^)'"]*/gi) || [];
  for (const u of urls) {
    const v = u.replace(/url\(\s*['"]?/i, '').trim();
    if (!/^data:/i.test(v)) return '引用了外部资源：' + v.slice(0, 60);
  }
  return '';
}

const abs = resolve(ROOT, target);
if (!existsSync(abs)) {
  console.error('找不到清单文件：' + abs);
  process.exit(1);
}

let json;
try {
  json = JSON.parse(readFileSync(abs, 'utf8'));
} catch (e) {
  console.error('JSON 解析失败：' + e.message);
  process.exit(1);
}

console.log('\n📋 校验 ' + target + '\n');

if (json.schema !== 1) fail('schema 必须是 1');
if (!Array.isArray(json.items)) {
  fail('items 必须是数组');
  process.exit(1);
}
if (json.items.length > 200) fail('条目数超过 200');

const seen = new Set();

json.items.forEach((raw, i) => {
  const where = `#${i + 1} ${raw && raw.id ? raw.id : '(无 id)'}`;
  console.log('· ' + where);

  if (!raw || typeof raw !== 'object') return fail('条目必须是对象');
  if (!ID_RE.test(raw.id || '')) return fail('id 只能是小写字母/数字/._-，2-49 位');
  if (seen.has(raw.id)) return fail('id 重复：' + raw.id);
  seen.add(raw.id);

  if (!['theme', 'plugin'].includes(raw.type)) return fail("type 只能是 'theme' 或 'plugin'");
  if (!raw.name) fail('缺少 name');
  if (!raw.author) warn('缺少 author（会显示成「匿名」）');
  if (!raw.version) warn('缺少 version（会当成 1.0.0）');
  if (raw.desc && raw.desc.length > 240) fail('desc 超过 240 字');
  if (raw.verified && raw.verified !== 'unverified') {
    warn('verified 会被强制改成 unverified，社区条目不能自称官方/已审核');
  }

  if (raw.type === 'theme') {
    const apply = raw.apply || {};
    for (const k of Object.keys(apply)) {
      if (!APPLY_KEYS.includes(k)) fail(`apply 里有不被允许的键：${k}`);
    }
    if (apply.pickcatCursor && !CURSORS.includes(apply.pickcatCursor)) {
      fail('pickcatCursor 只能是：' + CURSORS.join(' / '));
    }
    if (apply.pickcatBgUrl && apply.pickcatBgUrl.length > 20000) fail('pickcatBgUrl 太长');
    if (!raw.cssFile && !raw.css) return fail('主题必须有 cssFile 或 css');

    if (raw.cssFile) {
      if (!PATH_RE.test(raw.cssFile)) return fail('cssFile 只能是仓库内的相对路径');
      if (raw.cssFile.includes('..')) return fail('cssFile 不能包含 ..');
      if (!/\.css$/i.test(raw.cssFile)) return fail('cssFile 必须以 .css 结尾');
      const p = join(ROOT, raw.cssFile);
      if (!existsSync(p)) return fail('cssFile 指向的文件不存在：' + raw.cssFile);
      const css = readFileSync(p, 'utf8');
      const prob = cssProblem(css);
      if (prob) fail(raw.cssFile + '：' + prob);
      else ok(`${raw.cssFile}（${(statSync(p).size / 1024).toFixed(1)} KB）样式检查通过`);
    }
    if (raw.htmlClass && !/^[A-Za-z0-9_-]{1,60}$/.test(raw.htmlClass)) fail('htmlClass 只能是字母数字_-');
  } else {
    const perms = raw.permissions || [];
    if (!Array.isArray(perms)) return fail('permissions 必须是数组');
    for (const p of perms) {
      if (!PERMS.includes(p)) fail('未知权限：' + p);
    }
    if (perms.includes('network')) {
      const hosts = raw.hosts || [];
      if (!hosts.length) fail("申请 network 权限必须同时提供 hosts 白名单");
      for (const h of hosts) {
        if (!HOST_RE.test(h)) fail('hosts 格式不对：' + h);
        if (h === '*' || /^\*\.[a-z]+$/.test(h) && h.split('.').length < 3) warn('hosts 过于宽泛：' + h);
      }
    }
    const entry = raw.entry || raw.url;
    if (!entry) return fail('插件必须有 entry 或 url');
    if (!PATH_RE.test(entry) || entry.includes('..')) return fail('entry 只能是仓库内的相对路径');
    if (!/\.js$/i.test(entry)) return fail('entry 必须以 .js 结尾');
    const p = join(ROOT, entry);
    if (!existsSync(p)) return fail('entry 指向的文件不存在：' + entry);
    const code = readFileSync(p, 'utf8');
    if (Buffer.byteLength(code) > MAX_JS) fail('插件代码超过 200KB');
    const banned = [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/, /\bchrome\./, /\bdocument\b/, /\bwindow\.parent\b/, /\blocalStorage\b/];
    for (const re of banned) {
      if (re.test(code)) fail(entry + ' 里有被禁止的写法：' + re);
    }
    const hash = createHash('sha256').update(code).digest('hex');
    if (!raw.sha256) {
      fail('插件必须提供 sha256（用下面的值填进去）');
      console.log('     sha256: "' + hash + '"');
    } else if (raw.sha256.toLowerCase() !== hash) {
      fail('sha256 不匹配。清单写的是 ' + raw.sha256);
      console.log('     实际文件的 sha256: "' + hash + '"');
    } else {
      ok('sha256 匹配：' + hash.slice(0, 12) + '…');
    }
  }
  console.log('');
});

console.log(`\n结果：${errors ? '❌ ' + errors + ' 个错误' : '✅ 全部通过'}${warns ? ' · ⚠️ ' + warns + ' 个警告' : ''}\n`);
process.exit(errors ? 1 : 0);
