#!/usr/bin/env node
/**
 * 插件脚手架 —— 生成一个能跑的最小插件 + 对应的清单片段。
 *
 *   node tools/new-plugin.mjs 字数统计 char-count
 *   node tools/new-plugin.mjs 字数统计 char-count --theme   （生成主题皮肤模板）
 *
 * 生成后：
 *   1. 把打印出来的 JSON 粘进 workshop/community.json 的 items 数组
 *   2. node tools/validate.mjs --fix     （自动补上 sha256）
 *   3. 改代码，再跑一次 --fix
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [name, id] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const isTheme = process.argv.includes('--theme');

if (!name || !id) {
  console.log('\n用法：node tools/new-plugin.mjs <显示名> <id>\n');
  console.log('  node tools/new-plugin.mjs 字数统计 char-count');
  console.log('  node tools/new-plugin.mjs 樱花春日 theme-sakura --theme\n');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9._-]{1,48}$/.test(id)) {
  console.log('\n❌ id 只能是小写字母/数字/-/./_，且不超过 49 个字符\n');
  process.exit(1);
}

const file = join(ROOT, 'workshop', 'packs', isTheme ? `${id}.css` : `${id}.js`);
if (existsSync(file)) {
  console.log(`\n❌ 文件已存在：workshop/packs/${id}${isTheme ? '.css' : '.js'}\n`);
  process.exit(1);
}

const jsTemplate = `/**
 * ${name}
 * 作者：<你的名字>
 *
 * 规则速查（详细的看 DEVELOPER.md）：
 *   - 单文件，不能用 import / require
 *   - 联网只能用 PickcatPlus.fetch()，域名要写进清单的 hosts
 *   - 不能碰 document / chrome / window.parent / localStorage
 */

// 1) 在页面左下角加一个按钮（图标 + 文字）
const buttonId = await PickcatPlus.addInteractionButton(
  { id: 'run', icon: '✨', label: '${name}' },
  async () => {
    try {
      // 2) 读当前帖子的标题和正文
      const post = await PickcatPlus.getPostContent();

      // 3) 先弹一张卡片，别让用户干等
      const cardId = await PickcatPlus.showCard({
        title: '✨ ${name}',
        text: '正在处理…',
        loading: true,
      });

      // 4) 干活（这里换成你真正要做的事）
      const result = '标题：' + post.title + '\\n正文 ' + post.text.length + ' 字';

      // 5) 更新卡片
      await PickcatPlus.updateCard(cardId, { text: result, loading: false });
    } catch (e) {
      await PickcatPlus.showToast('出错了：' + e.message);
    }
  }
);

// 页面卸载 / 插件被停用时清理（可选）
// PickcatPlus.onUnload?.(() => {});
`;

const cssTemplate = `/* ${name} · 作者：<你的名字>
 *
 * 规则：只能用 CSS，不许 @import、不许外链 url()（data: 除外）。
 * 全部规则挂在 html.pickcat-theme-${id} 下，避免影响别的主题。
 */

html.pickcat-theme-${id} {
  --ui-radius: 12px;
}

html.pickcat-theme-${id} body {
  background: linear-gradient(160deg, #101828, #1d2939 60%, #0b1220);
}

/* 卡片圆角 */
html.pickcat-theme-${id} article {
  border-radius: var(--ui-radius);
}

/* 滚动条 */
html.pickcat-theme-${id} ::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 999px;
}
`;

writeFileSync(file, isTheme ? cssTemplate : jsTemplate, 'utf8');

const snippet = isTheme
  ? {
      id: id,
      type: 'theme',
      name: name,
      emoji: '🎨',
      category: 'theme',
      author: '<你的名字>',
      version: '1.0.0',
      desc: '<一句话说清它看起来是什么样>',
      htmlClass: `pickcat-theme-${id}`,
      cssFile: `workshop/packs/${id}.css`,
      apply: {
        pickcatBgUrl: '',
        pickcatBgBase64: '',
        pickcatMaskEnabled: false,
        pickcatCursor: 'default',
      },
    }
  : {
      id: id,
      type: 'plugin',
      name: name,
      emoji: '✨',
      category: 'tool',
      author: '<你的名字>',
      version: '1.0.0',
      desc: '<一句话说清它做什么>',
      entry: `workshop/packs/${id}.js`,
      permissions: ['dom-read', 'ui-interaction'],
      hosts: [],
      sha256: '<先留空，跑 --fix 自动填>',
    };

console.log(`\n✅ 已生成：workshop/packs/${id}${isTheme ? '.css' : '.js'}\n`);
console.log('把下面这段加进 workshop/community.json 的 items 数组里：\n');
console.log(JSON.stringify(snippet, null, 2));
console.log('\n然后跑：node tools/validate.mjs --fix\n');
