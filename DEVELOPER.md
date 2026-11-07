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
| `decor` | 可选 | 装饰件，见 2.6。**主题不能往页面里插节点，只能用这里声明的零件** |
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
- 开了「🛑 应急逃生」时所有租约一次性释放（插件全停、主题皮肤摘掉，安装状态保留）。
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
| 配色、渐变背景、圆角、边框、阴影、字体、滚动条、选中色 | 新增任意 DOM（左侧图标栏、横幅、悬浮预览卡……） |
| 覆盖站点 CSS 变量（`--ui-*` 一类） | 改路由、改页面结构、插入按钮 |
| 隐藏/显示站内已有元素 | 读取或请求数据 |
| 使用 `decor` 里已实现的装饰件（见 2.6） | 自带 SVG / 图片 / 自定义装饰节点 |

想做后者，得写**插件**。

### 2.6 装饰件（`decor`）

主题是纯数据，不能往页面里塞节点 —— 但「四角蛛网」这种观感又确实需要节点。所以扩展自己实现了一批**装饰件**，主题只能挑零件、调参数：

```json
"decor": [
  "corner-web"
]
```

带参数的写法：

```json
"decor": [
  { "type": "corner-web", "color": "rgba(210,182,250,0.72)", "opacity": 0.9, "emoji": false }
]
```

| 装饰件 | 效果 | 可调参数 |
| --- | --- | --- |
| `corner-web` | 左下 / 右下两张蛛网，各挂一只会轻轻摇晃的蜘蛛（默认带 🎃👻🍬 三个小吊牌） | `color`（网的颜色，≤40 字）、`opacity`（0–1）、`emoji`（false 关掉吊牌） |

规矩：

- 最多 4 项，同一种不能重复；
- 写未知类型会**校验失败**（不是静默忽略），别拼错；
- 装饰层是 `position:fixed` + `pointer-events:none`，不挡点击；
- 想加新的装饰件（雪花、樱花、点赞粒子……）就提 Issue 说清楚画什么，实现一次之后所有主题都能用。

### 2.6.1 图标与预览图（icon / preview.image）

图标三种写法，任选其一：

```json
"icon": "🎃"
"icon": "https://pickcat.dao3.fun/api/v1/files/01a1xxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx"
"icon": "data:image/png;base64,iVBORw0KGgo..."
```

| 写法 | 上限 | 说明 |
| --- | --- | --- |
| emoji | 4 个字符 | 最省事，永远能显示 |
| 官方图床直链 | 320 字符 | **只存引用不存图**：仓库里不放图片文件 |
| data URI | 26KB | 小图内联，适合线条图标 |

- 图床地址必须形如 `https://pickcat.dao3.fun/api/v1/files/<uuid>`，客户端与校验器都按这个前缀卡死。
- 图片读取失败时会自动回落成 🖼，不会留破图占位。
- 详情页配图用 `"preview": { "image": "<同样的图床直链>" }`；也可以继续用 `preview.bg` 的 CSS 渐变（零网络）。

### 2.7 整页背景与沙盒等级

**`pageBackground`（布尔，可选）**

如果你的主题在 CSS 里自己画了整页背景（比如 `html.pickcat-theme-xxx body { background-image: … }`），请写上 `"pageBackground": true`。

原因：站点内容外面套了一层不透明容器，它的类名**会变**（我们亲眼见过它从 `min-h-dvh bg-muted` 改成 `min-h-[var(--page-scroll-height,100dvh)]`）。写了这个字段，扩展就会在运行时自己找出「盖住页面的那一层」并让它透明，而不是靠你在 CSS 里赌类名。

```json
{
  "id": "theme-example",
  "type": "theme",
  "cssFile": "workshop/packs/theme-example.css",
  "htmlClass": "pickcat-theme-example",
  "pageBackground": true
}
```

**`tier`（可省略，通常不用写）**

市场里每张卡会显示 🟢 安全 / 🟡 均衡 / 🔴 自由，这个等级是**机器按你声明的能力算出来的**，不是你自己填的：

| 你的包 | 推导结果 |
| --- | --- |
| 主题（CSS / decor / apply） | 🟢 安全 |
| 插件声明了 `dom-read` / `ui-interaction` / `network` | 🟡 均衡 |
| 插件声明了 `dom-global`（改写整页） | 🔴 自由 |

`tier` 字段只能把自己**降得更严格**（比如你只有 `ui-interaction` 却想标成安全档），**不能**宣称自己比推导结果更安全 —— 写了也会被取更宽松的那个。

> ⚠️ `dom-write`（锚点内改动）和 `dom-global`（改写整页）这两个能力**当前还没实装**，先列在权限表里只是为了让清单能提前声明、卡片能如实显示。真正开放时会单独发公告。

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
PickcatPlus.dom.*                // 改页面（见 3.4.1），需要 dom-read / dom-write
PickcatPlus.log(...args)         // 打到控制台，便于调试
```

最小可用插件：

```js
const id = await PickcatPlus.addInteractionButton({ icon: '🔢', label: '字数' }, async () => {
    const post = await PickcatPlus.getPostContent();
    await PickcatPlus.showToast(`正文 ${post.text.length} 字`);
});
```

### 3.4.1 改页面（DOM 桥）

插件跑在 Worker 里，**没有 `document`**，也没有任何 DOM 对象。想改页面，就请宿主代做 —— 能力按两档给：

| 清单里写 | 档位 | 能碰什么 |
|---|---|---|
| `"anchor": ["editor"]` | 🟡 均衡 | 只在锚点根之内的节点 |
| `"permissions": [..., "dom-global"]` | 🔴 自由 | 整页（除扩展自己的界面） |

锚点枚举：`editor`（帖子编辑框）、`composer`（发帖表单）、`post`（正文区）、`header`（顶栏 / 导航）。

```js
const { handles, count } = await PickcatPlus.dom.query('article h2', { anchor: 'post' });
if (count) {
    const h = handles[0];
    await PickcatPlus.dom.style(h, 'border-left', '3px solid #fa322d');
    await PickcatPlus.dom.setAttr(h, 'data-seen', '1');
    console.log(await PickcatPlus.dom.text(h));
}
```

可用方法（全部返回 Promise，句柄是字符串）：

| 方法 | 权限 | 说明 |
|---|---|---|
| `dom.query(sel, { anchor, limit })` | dom-read | 返回 `{ count, handles, tags }`，最多 200 个 |
| `dom.text(handle)` | dom-read | 取文本（≤20000 字） |
| `dom.attr(handle, name)` | dom-read | 读属性 |
| `dom.observe({ anchor })` + `dom.onChange(cb)` | dom-read | 页面变动通知，150ms 合并，最多 3 个区域 |
| `dom.setAttr(handle, name, value)` | dom-write | 属性白名单见下 |
| `dom.addClass` / `dom.removeClass(handle, cls)` | dom-write | 类名须匹配 `[a-zA-Z][\w-]{0,40}` |
| `dom.style(handle, prop, value)` | dom-write | 样式白名单见下 |
| `dom.setText(handle, text)` | dom-write | 纯文本（不解析 HTML） |
| `dom.insert(handle, html, position)` | dom-write | `before / after / prepend / end`，HTML 会过消毒器 |

**做不到的事**（不是没实现，是故意不给）：

- 删除节点、写任意 `innerHTML`、读用户正在输入的内容；
- 改 `href` / `src`、加 `on*` 事件属性、插 `<script> / <iframe> / <style>`；
- 碰扩展自己的界面（设置面板、工坊卡片、装饰层）；
- `position: fixed / sticky`、`url()`（防止盖住整页或往外发请求）、`z-index` 超 ±1200。

样式白名单：颜色 / 背景 / 边框 / 阴影 / 字体 / 文本 / 透明度 / 间距 / 尺寸 / display / flex / grid / 定位（非 fixed）/ 圆角 / 光标 / transform / transition / animation / 滤镜等，具体见源码 `DOM_STYLE_ALLOW`。

属性白名单：`class` / `title` / `placeholder` / `role` / `tabindex` / `disabled` / `hidden` / `aria-*`；自定义数据用 `data-*`。

> 自由档（`dom-global`）不会自动启动：用户必须每次亲手点「手动运行」，跑起来后页面顶部会一直挂着一条「🔴 自由档运行中 · 停止」。

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

### 方式 A：提 Issue（推荐，不用懂 git —— 而且**全自动**）

打开 [新建 Issue](../../issues/new/choose)，选「🎨 创意工坊投稿」，按表单填：

- 作品类型、名字、署名、简介
- CSS 或 JS 的**完整内容**（直接粘贴）
- 用到的权限和原因（插件）

提交之后不需要等任何人：

```
你点提交
   ↓  几秒
GitHub Actions 自动跑：解析表单 → 审计代码 → 写文件 → 更新清单 → 提交 main
   ↓
成功：机器人在 Issue 里回一张回执，然后把 Issue 关掉
失败：机器人在 Issue 里回一张「哪里不合格 → 怎么改」的对照表，Issue 保持开着
   ↓
改完直接编辑这条 Issue（不用重新提）→ 自动重跑
```

上线延迟：raw 源 **5 分钟**、客户端清单 **10 分钟**内自动同步（等不及可以让用户点一下工坊里的「🌐 同步」）。

**注意「自动」的边界**：

- **主题（纯 CSS）是真全自动**。CSS 改不了网页行为，我们能把它审计到「只允许画图」的程度（白名单见 2.4），所以机器判过就上架。
- **插件（JS）是「自动上架 + 事后可秒撤」**。JS 没法在事前证明无害，机器只能挡住明显越界的写法（读 DOM、`eval`、外链、白名单外联网……）。**不要**写一个看起来像正常插件、实际干坏事的东西 —— 用户点右下角的 ⚑ 举报，维护者在手机上改 `workshop/revoked.json` 一行，最多 10 分钟全量停用并弹「已下架」。**下架本身很快，但维护者周中拿不到手机，举报统一在周末 / 节假日处理。**

### 方式 B：提 PR（会 git 的话更快）

1. Fork 仓库
2. 新建分支 `workshop/你的id`
3. 加两个文件：`workshop/packs/<你的id>.css|js` 和改动后的 `workshop/community.json`
4. `node tools/validate.mjs` 全绿
5. 提 PR，说明：作品名、用了哪些权限、为什么需要、是否联网（发给谁）

PR 只要**动的是 `workshop/` 里面的文件**、CI 全绿、且不是草稿，就会被自动 squash 合并；碰了 `tools/`、`.github/`、`content.js` 的 PR 一律等人工 —— 不然有人能顺手改掉校验器本身。

---

## 6. 审核与更新

- 社区条目会显示作者署名和「🌐 社区 · 未经审核」标记，用户安装前会看到权限清单。
- 维护者只会给随扩展打包的条目打「✅ 内置」，社区条目永远是「未经审核」——这是设计，不是歧视。
- **更新**：改文件 + 升 `version` + 若是插件同步更新 `sha256`，重新提交一次即可（Issue 通道直接编辑原 Issue）。用户那边最长 10 分钟就会自动同步到（也可让用户点「🌐 同步」立刻拉）。
- **自动闸门（机器做的）**：id / 路径 / 类型 / 字段白名单 / CSS 逐条属性白名单 / 插件禁词 / 体积 / sha256 / `network` 与 `hosts` 必须成对。全在 `tools/css-audit.mjs` + `tools/publish.mjs`，CI 与本地跑的是同一份。
- **人只做机检做不了的事**：读一遍这段代码到底想干什么、权限要得合不合理。**这是事后抽查，不阻塞上架**（维护者只有周末在电脑前）。
- **出了问题怎么办**：见 §6.1。

### 6.1 撤回表（`workshop/revoked.json`）

这就是「事前审核」的替代品 —— 一个**不需要用电脑**的紧急开关。

```json
{
  "schema": 1,
  "items": {
    "plugin-xxx": {
      "reason": "诱导用户输入账号密码",
      "at": "2026-11-02T10:00:00Z"
    }
  }
}
```

加进 `items` 之后：

1. 客户端最多 10 分钟内拉到新表；
2. 已装用户那边插件**立刻停止运行**、页面上的卡片被移除；
3. 工坊里那张卡变成「⛔ 已下架」+ 下架原因，只留「卸载」按钮；
4. 用户会收到一条 9 秒的提示：「⛔『X』已被下架：原因」。

删掉某一项 = 撤销下架（用户重新点安装即可恢复）。**拉不到新表时客户端沿用旧表** —— 绝不可能因为网络抖动把「下架」变回「恢复」。

改完记得本跑一遍 `node tools/validate-revoked.mjs`（`tools/check.mjs` 已包含）。这份文件写坏了 = 所有下架同时失效，所以校验器查得很死。

### 6.2 举报

> 处理时效：维护者是学生，**周中拿不到手机，举报统一在周末 / 节假日处理**。
> 点 ⚑ 的弹窗会先说这件事，并建议用户先去原帖评论区反馈 —— 那条路通常更快，维护者也会在站内发消息说明。


社区条目的卡片上有一个 ⚑ 按钮，用户点它会打开一个**预填好的 GitHub Issue**（带条目 id、作者、问题类型勾选、浏览器版本）。举报是公开的，所有人都能看见处理过程 —— 这也是「不藏事」的一部分。

---

## 7. 安全边界

> 线程模型（2.5.1 起）：**每个插件一个独立 Worker**。插件之间不共享全局作用域，
> 死循环只会掐掉自己那个线程，其它插件不受影响。「应急逃生」会一次性销毁全部线程。（请知悉）

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

---

## 8. 换图标（条目配图）

清单里一个字段搞定，三种写法任选其一：

```json
{ "icon": "🎃" }
{ "icon": "https://pickcat.dao3.fun/api/v1/files/01a1xxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx" }
{ "icon": "data:image/png;base64,iVBORw0KGgo..." }
```

| 写法 | 上限 | 说明 |
| --- | --- | --- |
| emoji | 4 个字符 | 最省事，任何环境都能显示 |
| 官方图床直链 | 320 字符 | 上传到点猫图床后拿 `/api/v1/files/<uuid>`；**仓库里不放图片文件** |
| data URI | 26KB | 单色线条图标内联，超过会被丢弃 |

- 前缀写错（不是 `https://pickcat.dao3.fun/api/v1/files/`）、超过 26KB，客户端都会**静默丢弃并回落成 📦**，`tools/validate.mjs` 会直接报错。
- 图片加载失败时自动变 🖼，不会留破图占位。
- 详情页大图用 `"preview": { "image": "<同样的图床直链>" }`；想零网络就用 `preview.bg` 的 CSS 渐变。
- 改完跑 `node tools/check.mjs`，它会校验 icon 与 preview.image。

## 9. 让插件动页面（DOM 能力）

插件本身没有 `document`，动页面必须由宿主代做。两个档位：

### 9.1 均衡档：锚点内（推荐）

清单声明锚点，插件只能碰锚点根**之内**的节点：

```json
{
  "id": "my-editor-helper",
  "type": "plugin",
  "permissions": ["dom-read", "dom-write", "ui-interaction"],
  "anchor": ["editor"]
}
```

锚点枚举（只能这四个）：

| 锚点 | 匹配到的东西 |
| --- | --- |
| `editor` | 发帖 / 回帖的输入区 |
| `composer` | 编辑表单容器 |
| `post` | 帖子正文区 |
| `header` | 顶部导航 |

插件里这样用：

```js
const hit = await PickcatPlus.dom.query('textarea, [contenteditable]', { anchor: 'editor' });
if (hit.count) {
    const h = hit.handles[0];
    await PickcatPlus.dom.setAttr(h, 'placeholder', '在这里写点什么喵…');
    await PickcatPlus.dom.style(h, 'min-height', '220px');
    await PickcatPlus.dom.insert(h, '<div class="my-tip">已启用增强</div>', 'after');
}
```

可用方法：`query` / `text` / `attr` / `setAttr` / `addClass` / `removeClass` / `style` / `setText` / `insert` / `observe` / `onChange`。

### 9.2 自由档：整页（谨慎）

`"permissions": ["dom-global"]` —— 不再受锚点限制，但：

- 仍不能碰扩展自己的 UI（设置面板、插件条、工坊卡片、沙盒 iframe）
- 仍不能删节点、不能写 `innerHTML`、不能改 `href` / `src`、不能插 `<script>` `<iframe>`
- 用户必须把「允许安装」调到 🔴 自由，并**每 24 小时重签一次**确认
- 自由档插件**不会自动启动**，每次要用户亲手点「手动运行」，页面顶部常驻「🔴 自由档运行中 N 个 · 停止」

写属性 / 样式都是白名单制：`class` `title` `placeholder` `data-*` `aria-*` 等可写，`onclick` `href` `src` 一律拒绝；样式禁 `url()` `expression()` `position: fixed`，`z-index` 限 ±1200。

## 10. 安全分级（谁能装什么）

等级由**能力推导**，不是开发者随便填的：

| 申请了 | 自动归为 | 用户侧显示 |
| --- | --- | --- |
| 什么都没有（纯数据 / 主题） | 🟢 安全 | 一次确认都不用 |
| `dom-read` / `dom-write` / `ui-interaction` / `notify` / `storage` / `network` | 🟡 均衡 | 装第一个插件时签一次说明 |
| `dom-global` | 🔴 自由 | 签免责（勾选 + 手打「自由」），24 小时后作废 |

用户可以在工坊顶部把「允许安装」调低，调低之后高等级条目按钮会变成「🔒 需要🟡 均衡」，装不了。

清单里也可以写 `"tier"`，但**只能把自己标得更严格**，不能标得更宽松——写 `safe` 而实际申请了 `dom-global`，仍然会按自由档处理。

## 11. 发新版 / 客户端怎么更新

### 11.1 一次发版要做的事

1. 改三处版本号（**必须一致**，否则「检查更新」会一直误报）：
   - `manifest.json` 的 `"version"`
   - `content.js` 关于页里的 `PICKCAT Plus vX.Y.Z`
   - `README.md` 徽章 `Version-vX.Y.Z`
2. `README.md` 加一节 `### vX.Y.Z` 更新日志。
3. `node tools/check.mjs`（清单 + 撤回表 + 六个 JS 语法）。
4. `node tools/pack.mjs` → 生成 `PICKCAT-Plus-vX.Y.Z.zip` 并自动删旧包。
5. 把改动传到 GitHub（网页上传即可；`.github/` 这类点开头目录要在网页里手打路径新建）。
6. 发 Release，把 zip 传上去。

### 11.2 客户端怎么知道自己该更新

扩展是「解压加载」的，**没有自动更新通道**（Chrome 只给商店版本自动更新）。所以：

- 关于页有「检查更新」：拉远端的 `manifest.json` 比版本号，结果缓存 6 小时。
- 有新版 → 「🎉 有新版本 vX.Y.Z 可用」，按钮变「去下载」，点开 Release 页。
- 没网 → 「检查失败，网络不太顺，稍后再试喵」，不影响任何功能。

发布时**一定要更新远端 `manifest.json`**，否则所有人都会显示「已是最新」。

### 11.3 工坊条目怎么更新

清单条目的 `version` 比本地装的大，工坊卡片就会出现「可更新」徽章与「更新到 vX」按钮；插件权限有变化时会重新弹一次确认。设置面板里也能点「更新全部」。

### 11.4 清单本身多久生效

客户端拉社区清单的缓存是 **10 分钟**；点工坊的「同步」会立刻重拉。GitHub raw 自身还有约 5 分钟缓存，刚推上去的东西马上看不到很正常。

## 12. 与 PickScribe 联动

完整协议见 `INTEGRATION.md`。一句话：用 `window.postMessage` 互相自报家门（`pickcat:hello` / `pickscribe:hello`），Plus 的「关于」页会显示连接状态，对方装了就能一键「打开 PickScribe 助手」。
