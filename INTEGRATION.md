# 与 PickScribe 联动 · 接入说明

> 给 [PickScribe](https://github.com/GrantPome/PickScribe) 作者（Grant）看的。
> 目标：两个扩展在同一个页面上**互相发现、互相喊话**，用户不用知道谁在干活。
> 成本：你那边加 **不到 20 行** 代码，不需要改权限，不需要改 manifest。

## 一、为什么只能这么联

两个扩展各自往 `pickcat.dao3.fun` 注入 content script。它们：

- 运行在**同一个页面**里
- 但各自的 `world` 与变量是**互相看不见**的（Chrome 隔离各扩展的脚本上下文）
- 不能直接调用对方的函数、读对方的 storage

唯一合法且零权限的通道是 **`window.postMessage`**：消息打到页面窗口，谁的监听器在谁就能收到。

所以协议设计成「广播 + 自报家门」：谁先加载都行，谁都不知道对方存不存在也行。

## 二、协议 v1（已经在 PICKCAT Plus 2.5.3 里实现）

所有消息都是普通对象，`targetOrigin` 用 `'*'`（页面同源，不放任何隐私数据）。

| 方向 | type | 作用 |
| --- | --- | --- |
| Plus → 对方 | `pickcat:link-ping` | 「我是 PICKCAT Plus，在吗」 |
| 对方 → Plus | `pickscribe:hello` | 「我在，这是我版本和能力」 |
| 对方 → Plus | `pickscribe:link-ping` | 「我是 PickScribe，在吗」 |
| Plus → 对方 | `pickcat:hello` | 「我在，这是我版本和能力」 |
| Plus → 对方 | `pickcat:open-ai` | 「请把 AI 面板打开」（用户点了联动按钮） |

字段约定：

```js
{ source: 'pickcat-plus', type: 'pickcat:link-ping', version: '2.5.3' }
{ source: 'pickscribe',   type: 'pickscribe:hello', version: '3.8.1', features: ['ai', 'editor'] }
```

`source` 用来避免误认——页面上别的脚本可能也在发消息。

## 三、你这边要加的代码（约 18 行）

放在你 content script 初始化处即可：

```js
// ---- PICKCAT Plus 联动 ----
(function linkPickcatPlus() {
    const send = (o) => { try { window.postMessage(o, '*'); } catch (e) {} };

    window.addEventListener('message', (ev) => {
        const d = ev.data;
        if (!d || typeof d !== 'object') return;

        // 对方在找我们：回一句「我在」
        if (d.source === 'pickcat-plus' && d.type === 'pickcat:link-ping') {
            send({ source: 'pickscribe', type: 'pickscribe:hello', version: chrome.runtime.getManifest().version, features: ['ai', 'editor'] });
            return;
        }

        // 对方请我们打开 AI 助手
        if (d.source === 'pickcat-plus' && d.type === 'pickcat:open-ai') {
            if (typeof openAIWriter === 'function') openAIWriter();   // ← 换成你自己的入口函数
        }
    });

    // 我们先喊一声（对方可能比我们早加载）
    [0, 1500, 4000].forEach((ms) => setTimeout(() => send({ source: 'pickscribe', type: 'pickscribe:link-ping' }), ms));
})();
```

只需要把 `openAIWriter()` 换成你真正的「打开 AI 面板」函数名。其它照抄即可。

## 四、你那边能拿到什么

Plus 的 `pickcat:hello` 会带：

```js
{ source: 'pickcat-plus', type: 'pickcat:hello', version: '2.5.3', features: ['editor', 'workshop', 'dom-bridge'] }
```

`features` 目前是这三种，以后只增不改：

| feature | 含义 |
| --- | --- |
| `editor` | 内置了可视化编辑器（Markdown ↔ 富文本） |
| `workshop` | 有创意工坊（主题 / 插件市场） |
| `dom-bridge` | 插件可以操作页面 DOM（锚点内 / 自由档） |

你可以据此决定要不要显示「配合 PICKCAT Plus 使用体验更好」之类的提示。

## 五、Plus 这边做了什么

- 「关于」页有一张 **🔗 联动 · PickScribe** 卡片：
  - 检测到你就显示「已连接 PickScribe vX」，按钮变成「打开 PickScribe 助手」（点了发 `pickcat:open-ai`）。
  - 没检测到就显示介绍 + 「了解 PickScribe」按钮（跳你的仓库）。
- 启动后约 5 秒内会喊 5 次 `pickcat:link-ping`，之后不再打扰。
- README / 致谢里已把你的项目列出来了。

## 六、互惠（我们这边承诺）

- PICKCAT Plus 的 README、关于页、工坊「联动」分类都会署你的名并链到仓库。
- 你做的宣传图会用在 README 顶部与社区帖里，署名按你要求写。
- 只要协议不变，Plus 2.5.x 全系列都通。

## 七、以后想扩展的话（v2 草案，先不做）

- `pickcat:ask-ai` + `pickscribe:ai-result`：把整篇文章丢过去、拿回摘要（现在 Plus 自己也能做，但你想统一入口也行）。
- `pickscribe:editor-state`：告诉我们你的编辑器开没开，避免两个编辑器抢同一个 textarea。

先跑通 v1，用一段时间再谈 v2。
