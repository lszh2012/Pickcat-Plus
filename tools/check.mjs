#!/usr/bin/env node
/**
 * 一条命令跑完全部检查（等同于 CI 里做的事）。
 *
 *   node tools/check.mjs            # 检查
 *   node tools/check.mjs --fix      # 顺便把 sha256 写回去
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixArgs = process.argv.includes('--fix') ? ['--fix'] : [];
let bad = 0;

const step = (label, args) => {
  process.stdout.write(`\n===== ${label} =====\n`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) bad++;
};

step('社区清单', ['tools/validate.mjs', 'workshop/community.json', ...fixArgs]);
step('内置清单', ['tools/validate.mjs', 'workshop/builtin.json', ...fixArgs]);
step('撤回表', ['tools/validate-revoked.mjs']);

for (const f of ['content.js', 'sandbox.js', 'background.js']) {
  if (!existsSync(resolve(ROOT, f))) continue;
  process.stdout.write(`\n===== 语法检查 ${f} =====\n`);
  const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) bad++;
  else console.log('✅ ' + f);
}

if (bad) {
  console.log(`\n❌ 有 ${bad} 项没通过，先修再提交。\n`);
  process.exit(1);
}
console.log('\n🎉 全绿，可以提交了。\n');
