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
5. 合并后最长 10 分钟，所有用户的工坊里就会自动同步到你的作品（也可以让用户点「🌐 同步」立刻拉）。

---

## 1. 目录约定

```
workshop/
  builtin.json        # 内置清单（随扩展打包），只有维护者能动
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
| `mode` | 建议 | `"dark"` / `"light"` / `"any"`（默认）。声明这套皮肤更适合哪种配色；和用户当前模式不搭时，卡片上会挂一个提醒，用户切换模式时最多提示一次。**不阻止安装**。 |
| `claims` | 可选 | 你要「接管」的设置项，见 2.5 |

### 2.2 `apply` 允许的键

| 键 | 值 | 说明 |
| --- | --- | --- |
| `pickcatBgUrl` | URL 或 CSS 渐变 | 支持 `linear-gradient(...)` / `radial-gradient(...)` 等，**推荐用渐变**，零外链、断网也能看 |
| `pickcatBgBase64` | `data:image/...` | 不推荐：会占用户存储配额（上限 5MB） |
| `pickcatMaskEnabled` | `true` / `false` | 背景遮罩，暗色主题建议 `true` |
| `pickcatCursor` | `default` / `style1` / `style2` / `style3` / `style6` / `custom` | 指针样式 |
| `pickcatCustomCursor` | `data:image/png;base64,...` | 仅当 `custom` 时有效，**必须 32×32**，条目别超过 8KB |

### 2.3 接管设置项（`claims`，可选）

有些主题必须锁死某几个设置才成立：暗色主题要关掉背景遮罩、配套指针不能换。用 `claims` 声明它们。

```json
"claims": [
  {
    "key": "pickcatMaskEnabled",
    "value": false,
    "label": "背景遮罩",
    "reason": "夜色背景再叠一层灰纱会发闷，也会糊掉月亮。"
  }
]
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | ✅ | 只能是：`pickcatBgUrl` / `pickcatBgBase64` / `pickcatMaskEnabled` / `pickcatCursor` / `pickcatCustomCursor` / `pickcatHideCat` / `pickcatKitten4` / `pickcatCategoryList` / `pickcatCreationGrid` |
| `value` | ✅ | 你要强制使用的值，类型必须和该设置一致（布尔 / 指针枚举 / 字符串） |
| `label` | ✅ | 给人看的名字（≤60 字），会显示在安装弹窗和设置面板的锁标签上 |
| `reason` | 建议 | 为什么必须锁（≤80 字），显示在安装弹窗里 |

规则：

- **用户原来的值不会被覆盖**。扩展只存一份「租约」，读取配置时在内存里临时套用你的值；卸载/禁用/点「释放」立刻恢复用户自己的设置。
- 单条最多 **5 项**；同一个键最多被 **3 个**插件同时接管（后装的优先）。
- 用户随时可以在设置面板里看到「🔒 由「X」接管 · 点此释放」，所以 `label` 和 `reason` 要写清楚，别写「设置」这种废话。
- 开了「安全模式」时所有租约一次性释放。
- 滥用（把 9 项全锁上）会被打回改。

### 2.4 CSS 规则（会被自动审计，不合格直接拒）
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

### 2.5 主题能做 / 不能做
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
| `settings` | 选填 | 安装后展示给用户的设置表单，最多 12 项（见 3.1.1） |
| `mode` | 选填 | `"dark"` / `"light"` / `"any"`，声明插件对配色的偏好，只做提示 |
| `claims` | 选填 | 和主题一样，可以接管设置项（见 2.3）。插件一般不需要，插件自己的设置请用 `settings` |

#### 3.1.1 `settings` 怎么写

用户装上插件后，卡片上会出现一个「⚙」，点开就是你声明的表单。改完自动保存，同时会推给运行中的插件（不用重装）。

```json
"settings": [
  { "key": "apiKey", "label": "API Key", "type": "password",
    "placeholder": "sk-...", "hint": "只存在本机，不会上传。" },
  { "key": "model", "label": "模型", "type": "select",
    "default": "deepseek-chat", "options": ["deepseek-chat", "moonshot-v1-8k"] },
  { "key": "maxLen", "label": "最长字数", "type": "number",
    "default": 200, "min": 50, "max": 2000 },
  { "key": "emoji", "label": "显示表情", "type": "switch", "default": true }
]
```

| 字段 | 说明 |
| --- | --- |
| `key` | ✅ 字母/数字/下划线，插件里靠它取值 |
| `label` | 显示名，不写就用 `key` |
| `type` | `text`（默认）/ `password`（打点）/ `select`（必须有 `options`）/ `number`（可配 `min`/`max`）/ `switch`（布尔开关） |
| `default` | 默认值。`switch` 用 `true/false`，`number` 用数字，`select` 必须是 options 里的一个 |
| `options` | 仅 `select`：字符串数组，或 `[{"value":"deepseek-chat","label":"DeepSeek 对话"}]` |
| `placeholder` / `hint` | 输入框占位符 / 下方灰色小字说明 |

**插件里怎么读**（只在 `storage` 权限下可用）：

```js
const cfg = Object.assign(
  { apiKey: '', model: 'deepseek-chat' },          // 兜底默认值，用户没填也能跑
  (await PickcatPlus.storage.get('settings')) || {}
);
```

> 约定：所有表单值统一存在 `settings` 这个键下（**不是**每个字段一个键），这样一次 `storage.get('settings')` 就能全拿到。`ai-summary` 就是这么写的，可以抄。

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

## 4. 本地自检（三条命令，全自动）

```bash
# ① 生成模板（可选，省得手抄字段）
node tools/new-plugin.mjs 我的插件 my-plugin
node tools/new-plugin.mjs 我的主题 theme-xxx --theme

# ② 一条命令跑完所有检查（等同 CI 做的事）
node tools/check.mjs

# ③ 如果只是 sha256 忘了填 / 改了代码没同步，让它自己写回去
node tools/check.mjs --fix
```

`validate.mjs` 做的是**和扩展内完全一样的检查**：字段合法性、id 唯一、路径存在、CSS 红线、插件禁词、sha256 比对、体积上限。
全绿再提交，能省掉一轮来回。

> 合并后扩展里还会再查一次（扩展才是最终防线），所以本地过了不代表审核一定过，但基本不会因为格式被打回。

**CI 会自动跑同一套检查**：提了 PR 之后，GitHub 的「创意工坊检查」会立刻跑一遍 —— 绿勾 = 格式没问题，红叉 = 点 Details 看是哪条。另有一条扩展体积上限（2MB），超了也是红叉。

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

- 社区条目会显示作者署名和「🌐 社区 · 未经审核」标记，用户安装前会看到权限清单。
- 维护者只会给随扩展打包的条目打「✅ 内置」，社区条目永远是「未经审核」——这是设计，不是歧视。
- **更新**：改文件 + 升 `version` + 若是插件同步更新 `sha256`，重新提交一次即可。用户那边最长 10 分钟就会自动同步到（也可让用户点「🌐 同步」立刻拉）。
- 审核分级：直接拒（混淆 / 远程加载代码 / 读 Cookie / 白名单外联网 / 伪装成内置条目）、打回改（权限过大、hosts 通配、超体积）、合并标「已审核」。
- **自动化到哪一步**：格式、路径、禁词、体积、sha256、CSS 红线全部由 `tools/validate.mjs` 和 CI 机检；**人只做机检做不了的事** —— 看这段代码到底想干什么、权限要得合不合理。机检过不了的 PR 不用人看，红叉自己会挡住。

---

## 7. 安全边界（请知悉）

- 插件跑在 `sandbox.html`（无 `chrome.*`、`origin: null`）。
- **沙盒被 CSP 物理断网**：`connect-src 'none'; child-src 'none'; object-src 'none'`。也就是说插件进程里**根本没有可用的网络函数**，也造不出子 iframe 去另开一条路 —— 这是浏览器强制的，不是我们"帮忙删了一下"。
- 联网唯一出口是 `PickcatPlus.fetch()`：沙盒 → 宿主（`content.js`，再判一遍 hosts 白名单）→ `background.js`（background service worker 真正发请求）。出口硬规则：只允许 https、只允许 GET/POST/PUT/PATCH/DELETE、**一律不带 Cookie**、30 秒超时、响应上限 512KB。
- 你要联网，就必须在清单里写 `hosts` 白名单，而且要 `network` 权限；两者缺一个都直接拒装。
- 单插件消息配额 60 条/秒，超了宿主就限流。
- **代码变了要重新确认**：我们记录每个已装插件的代码 `sha256`。作者更新代码后，客户端会发现指纹变化，把插件挂起并弹「代码已更新 · 重新确认」，用户点了才继续跑 —— 不存在"偷偷升级权限"。
- 主题是纯数据 + 纯 CSS，不执行代码，风险显著低于插件。
- **你的代码跑在独立 Worker 里**，沙盒页只做中继与看门狗。所以：`while(true){}`、`for(;;)` 这类死循环**不会**拖死用户的页面，只会让「你这个插件」被强制终止并自动停用。判定用的是**心跳**：正常等待网络时心跳照发，只有同步死循环会让心跳断掉，12 秒没心跳就掐。代价是：Worker 里没有 `document`、`window`、`Image`、`iframe`、`localStorage`，只有 `PickcatPlus` 那一套异步 API —— 别去碰 DOM，本来也不该碰。

---

有任何格式问题，先跑 `node tools/validate.mjs`；还不行就提 Issue 问，别憋着喵。
