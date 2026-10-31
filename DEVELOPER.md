# 创意工坊 · 开发者指南

> 本文件说明如何向 PICKCAT Plus 的创意工坊提交内容。
> 两种类型：**主题（theme，纯 CSS + 数据）** 和 **插件（plugin，沙盒里跑的 JS）**。
> 不需要服务器，不需要打包工具，会改 JSON 和写 CSS 就能做。

---

## 0. 三十秒版本

1. 写一个 CSS 文件（或一个 JS 文件）。
2. 在 `workshop/community.json` 里加一条 JSON。
3. 本地跑 `node tools/validate.mjs`，全绿。
4. 提 Issue（推荐，网页填空）或 PR。
5. 合并后最长 24 小时，所有用户的工坊里就会出现你的作品。

---

## 1. 目录约定

```
workshop/
  builtin.json        # 官方内置清单，只有维护者能动
  community.json      # 社区清单 ← 你改这里
  packs/
    theme-mint.css    # 你的主题样式
    my-plugin.js      # 你的插件代码
```

一次提交只动两个地方：`workshop/community.json` + `workshop/packs/` 下的你自己的文件。
不要改 `content.js`、`builtin.json`、别人的 `.css` / `.js`。

---

## 2. 主题（推荐，最难做出安全问题）

主题 = 一份 CSS + 几个设置项的值。它**不执行任何代码**，只是被注入到页面 `<style>` 里。

### 2.1 清单条目

```json
{
  "id": "theme-mint",
  "type": "theme",
  "name": "薄荷海",
  "emoji": "🌿",
  "category": "dark",
  "author": "你的名字",
  "version": "1.0.0",
  "desc": "深海薄荷渐变 + 圆角卡片。",
  "cssFile": "workshop/packs/theme-mint.css",
  "htmlClass": "pickcat-theme-mint",
  "apply": {
    "pickcatBgUrl": "linear-gradient(160deg,#0b3b3c,#0e6b63 45%,#082529)",
    "pickcatBgBase64": "",
    "pickcatMaskEnabled": false,
    "pickcatCursor": "style3",
    "pickcatCustomCursor": ""
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 小写字母/数字/`._-`，2–49 位，**全局唯一，定了别改** |
| `type` | ✅ | 固定 `"theme"` |
| `name` / `emoji` / `desc` | ✅ | 卡片上显示的名字、图标、简介（desc ≤ 240 字） |
| `author` | ✅ | 你的署名 |
| `version` | ✅ | 语义化版本，内容改了要升 |
| `cssFile` | ✅ | 仓库内相对路径，必须以 `.css` 结尾 |
| `htmlClass` | 建议 | 注入时加到 `<html>` 上的类名，只能字母数字 `_-` |
| `apply` | ✅ | 要写入的设置项，见下表 |

### 2.2 `apply` 允许的键

| 键 | 值 | 说明 |
| --- | --- | --- |
| `pickcatBgUrl` | URL 或 CSS 渐变 | 支持 `linear-gradient(...)` / `radial-gradient(...)` 等，**推荐用渐变**，零外链、断网也能看 |
| `pickcatBgBase64` | `data:image/...` | 不推荐：会占用户存储配额（上限 5MB） |
| `pickcatMaskEnabled` | `true` / `false` | 背景遮罩，暗色主题建议 `true` |
| `pickcatCursor` | `default` / `style1` / `style2` / `style3` / `style6` / `custom` | 指针样式 |
| `pickcatCustomCursor` | `data:image/png;base64,...` | 仅当 `custom` 时有效，**必须 32×32**，条目别超过 8KB |

### 2.3 CSS 规则（会被自动审计，不合格直接拒）

- ❌ 不能 `@import`、不能 `url()` 引外部资源（只允许 `data:`）。
  想让主题带图？请转成 base64 内联，或干脆用 CSS 渐变 / 内联 SVG data URI。
- ❌ 不能出现 `expression(`、`behavior:`、`javascript:`。
- ❌ 不能 `position: fixed` 做全屏遮挡、不能给 `html`/`body` 加 `display: none`（会被判定为「劫持页面」）。
- ✅ 建议所有选择器都挂在 `html.<你的 htmlClass>` 下面，这样卸载时整体失效，不会污染别的主题。

```css
html.pickcat-theme-mint article {
    border-radius: 16px !important;
    border: 1px solid rgba(120, 240, 210, 0.18) !important;
}
```

### 2.4 主题能做 / 不能做

| 能做 | 做不到 |
| --- | --- |
| 配色、渐变背景、圆角、边框、阴影、字体、滚动条、选中色 | 新增 DOM（比如左侧图标栏、横幅、悬浮预览卡） |
| 覆盖站点 CSS 变量（`--ui-*` 一类） | 改路由、改页面结构、插入按钮 |
| 隐藏/显示站内已有元素 | 读取或请求数据 |

想做后者，得写**插件**。

---

## 3. 插件（JS，跑在沙盒里）

插件代码在独立的 `sandbox.html` iframe 里执行：`origin` 为 `null`、拿不到 `chrome.*`、拿不到用户的 Cookie / 其它扩展数据。

### 3.1 清单条目

```json
{
  "id": "my-plugin",
  "type": "plugin",
  "name": "字数统计",
  "emoji": "🔢",
  "category": "tool",
  "author": "你的名字",
  "version": "1.0.0",
  "desc": "在帖子右下角显示正文字数。",
  "entry": "workshop/packs/my-plugin.js",
  "permissions": ["dom-read", "ui-interaction"],
  "hosts": [],
  "sha256": "填 node tools/validate.mjs 打印出来的值",
  "settings": [
    { "key": "unit", "label": "单位", "type": "select", "options": ["字", "词"], "default": "字" }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `entry` | ✅ | 仓库内相对路径，必须是 `.js`，单个文件 |
| `permissions` | ✅ | 见 3.2，取最小集合 |
| `hosts` | 有 `network` 时必填 | 允许访问的域名白名单 |
| `sha256` | ✅ | 文件的 SHA-256。内容一改就要同步更新 |
| `settings` | 选填 | 安装后展示给用户的设置表单，最多 12 项，`type` 支持 `text` / `password` / `select` / `number` / `switch` |

### 3.2 权限

| 权限 | 风险 | 含义 |
| --- | --- | --- |
| `dom-read` | 低 | 读取当前帖子的标题和正文 |
| `ui-interaction` | 低 | 在页面上加按钮、弹卡片 |
| `notify` | 低 | 弹一条提示 |
| `clipboard-write` | 中 | 写剪贴板 |
| `storage` | 中 | 存自己的配置（按插件 id 隔离） |
| `network` | 高 | 联网，**必须**同时给 `hosts` 白名单，白名单外的请求会被硬拒 |

### 3.3 硬规则（违反了不会合并）

- 单文件，**禁止** `import` / `require` / 动态 `import()`（沙盒里根本没有模块系统）。
- **禁止**混淆、压缩到不可读、或用 base64 藏代码。
- 联网**只能**用 `PickcatPlus.fetch()`，且域名必须在你的 `hosts` 里。
- **禁止**出现 `chrome.`、`document`、`window.parent`、`localStorage`、`eval(`、`new Function(`。
- 体积 ≤ 200KB。
- 产品红线：**不许替用户写正文内容**（AI 代写类功能不收）。做总结、翻译、排版、检索都可以。

### 3.4 可用的 API

```js
PickcatPlus.meta                 // { id, name, version, author }
PickcatPlus.getPostContent()     // → Promise<{ title, text, url }>
PickcatPlus.addInteractionButton({ icon, label }, onClick)  // → Promise<buttonId>
PickcatPlus.showCard({ title, text, loading })              // → Promise<cardId>
PickcatPlus.updateCard(cardId, { text, loading })
PickcatPlus.closeCard(cardId)
PickcatPlus.showToast(text)
PickcatPlus.copy(text)           // 需要 clipboard-write
PickcatPlus.storage.get(key) / .set(key, value) / .all()    // 需要 storage
PickcatPlus.fetch(url, options)  // 需要 network，走 hosts 白名单
PickcatPlus.onPostChange(cb)     // 用户切换帖子时触发
PickcatPlus.log(...args)         // 打到控制台，便于调试
```

最小可用插件：

```js
const id = await PickcatPlus.addInteractionButton({ icon: '🔢', label: '字数' }, async () => {
    const post = await PickcatPlus.getPostContent();
    await PickcatPlus.showToast(`正文 ${post.text.length} 字`);
});
```

### 3.5 计算 sha256

```bash
node tools/validate.mjs      # 清单里 sha256 填错时，它会直接把正确值打印出来
```

---

## 4. 本地自检

```bash
node tools/validate.mjs
```

它做的是**和扩展内完全一样的检查**：字段合法性、id 唯一、路径存在、CSS 红线、插件禁词、sha256 比对、体积上限。
全绿再提交，能省掉一轮来回。

> 合并后扩展里还会再查一次（扩展才是最终防线），所以本地过了不代表审核一定过，但基本不会因为格式被打回。

---

## 5. 怎么提交

### 方式 A：提 Issue（推荐，不用懂 git）

打开 [新建 Issue](../../issues/new/choose)，选「🎨 创意工坊投稿」，按表单填空：

- 作品类型、名字、署名、简介
- CSS 或 JS 的**完整内容**（直接粘贴）
- 用到的权限和原因（插件）

维护者会把它写进 `community.json` 并合并。你不需要 fork、不需要装 git。

### 方式 B：提 PR（会 git 的话更快）

1. Fork 仓库
2. 新建分支 `workshop/你的id`
3. 加两个文件：`workshop/packs/<你的id>.css|js` 和改动后的 `workshop/community.json`
4. `node tools/validate.mjs` 全绿
5. 提 PR，说明：作品名、用了哪些权限、为什么需要、是否联网（发给谁）

---

## 6. 审核与更新

- 社区条目会显示作者署名和「🌐 社区 · 未审核」标记，用户安装前会看到权限清单。
- 官方只会给自己的条目打「✅ 官方认证」，社区条目永远是「未审核」——这是设计，不是歧视。
- **更新**：改文件 + 升 `version` + 若是插件同步更新 `sha256`，重新提交一次即可。用户那边最长 24 小时收到。
- 审核分级：直接拒（混淆 / 远程加载代码 / 读 Cookie / 白名单外联网 / 伪装官方）、打回改（权限过大、hosts 通配、超体积）、合并标「已审核」。

---

## 7. 安全边界（请知悉）

- 插件跑在 `sandbox.html`（无 `chrome.*`、`origin: null`），原生 `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource` 会在启动时被替换成抛错桩，联网只能走 `PickcatPlus.fetch()`。
- 这层白名单是**合作式**的：它挡住误用和明显的越权，但沙盒里终究是在跑第三方代码。所以：**只装你信任的来源**，看到要求 `network` + 宽泛 hosts 的插件，多想三秒。
- 主题是纯 CSS，不执行代码，风险显著低于插件。

---

有任何格式问题，先跑 `node tools/validate.mjs`；还不行就提 Issue 问，别憋着喵。
