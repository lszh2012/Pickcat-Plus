/**
 * 打包发行版 zip。
 *
 *   node tools/pack.mjs
 *
 * 为什么要自己写 ZIP：这台机器是 ConstrainedLanguage，`System.IO.Compression`
 * 用不了（Add-Type 被拒），而 `Compress-Archive` 会把条目名写成反斜杠 ——
 * 那种 zip 在 macOS / Linux 上解压出来是一坨带反斜杠的怪文件名。
 * 所以这里手写 local header / central directory / EOCD，条目名一律正斜杠。
 *
 * 排除规则（**别删**）：
 *   - 点开头的目录与文件（.git / .tmp* / 本地预览…），.github 例外
 *   - snapshots/（我们自己留的版本快照，体积大且与发行无关）
 *   - 仓库里的大图原稿与历史 zip
 *   - AI-HANDOFF.md（给 AI 看的协作文档，明确不上传、不打包）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, relative } from 'node:path';

const MANIFEST = JSON.parse(readFileSync('manifest.json', 'utf8'));
const OUT = `PICKCAT-Plus-v${MANIFEST.version}.zip`;

const SKIP_DIRS = new Set(['.git', 'snapshots', 'node_modules']);
const SKIP_FILES = new Set(['AI-HANDOFF.md', 'white_logo.png', 'black_logo.png', 'icon.png']);
const SKIP_RE = /^(PICKCAT-Plus-.*\.zip$|\.)/;

const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (SKIP_DIRS.has(name)) continue;
            if (name.charAt(0) === '.' && name !== '.github') continue;
            walk(full, out);
        } else {
            if (SKIP_FILES.has(name)) continue;
            if (SKIP_RE.test(name) && name.charAt(0) === '.') continue;
            if (/^PICKCAT-Plus-.*\.zip$/.test(name)) continue;
            out.push(full);
        }
    }
    return out;
}

const files = walk('.', []).sort();
const locals = [];
const centrals = [];
let offset = 0;

for (const full of files) {
    const name = relative('.', full).split('\\').join('/');
    const data = readFileSync(full);
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);          // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);              // 固定时间，保证可复现
    local.writeUInt16LE(0x2821, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...locals, ...centrals, eocd]);
writeFileSync(OUT, zip);

const names = files.map((f) => relative('.', f).split('\\').join('/'));
readdirSync('.').forEach((f) => {
    if (/^PICKCAT-Plus-v.*\.zip$/.test(f) && f !== OUT) {
        unlinkSync(f);
        console.log('  清掉旧包 ' + f);
    }
});

console.log(`\n📦 ${OUT}`);
console.log(`   条目 ${files.length} · ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`   反斜杠条目 ${names.filter((n) => n.indexOf('\\') >= 0).length} · manifest 在根 ${names.includes('manifest.json')}`);
console.log(`   含 .github ${names.some((n) => n.indexOf('.github/') === 0)} · 含 AI-HANDOFF.md ${names.includes('AI-HANDOFF.md')}`);
console.log('');
