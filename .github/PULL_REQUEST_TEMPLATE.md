# 投稿自查（四问）

请先勾掉这四行，再提 PR。规则细节见 [DEVELOPER.md](../../DEVELOPER.md)。

- [ ] `node tools/validate.mjs` 全绿（id 唯一、路径存在、CSS/JS 红线、sha256 匹配）
- [ ] 只改了两处：`workshop/community.json` + `workshop/packs/` 下我自己的文件
- [ ] 插件：没有 `eval` / `new Function` / `import` / 混淆代码；联网只走 `PickcatPlus.fetch()`，域名写进了 `hosts`
- [ ] 主题：没有 `@import`，`url()` 只有 `data:`，选择器挂在 `html.<htmlClass>` 下

---

## 这个作品是什么

<!-- 一句话。比如：一个深海薄荷配色的主题 / 一个显示字数的插件 -->

## 用了哪些权限，为什么

<!-- 主题填「无」。插件请逐条说明，尤其 network 要写清楚发给谁、发什么 -->

## 是否联网 / 发给谁

<!-- 不联网写「否」。联网写域名 + 发送内容 + 是否含用户隐私 -->

## 本地自测截图

<!-- 装上之后的截图，最好带控制台。没有截图也能提，但会慢一轮 -->
