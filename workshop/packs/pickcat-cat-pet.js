// PICKCAT 小桌宠 · 工坊插件版
// 一只会陪你逛帖子的小红猫，点一下就有惊喜。
// 作者: Helencpu

const CAT_LINES = [
  "喵~ 这个帖子看起来很有意思呢！",
  "喵呜~ 这个话题我也想凑凑热闹！",
  "嘿嘿，被你戳到小肉垫了喵！",
  "喵！你今天逛了好多帖子呀，喝口水吧~",
  "喵呜，这个作者好厉害呀！",
  "蹭蹭蹭~ 再来点有趣的帖子吧喵",
  "喵~ 点我一下，我就喵一声给你听！",
  "你看你看，这个评论区好热闹呀喵！",
];

async function main() {
  // 读取历史撸猫次数
  let count = 0;
  try {
    const saved = await PickcatPlus.storage.get("petCount");
    if (typeof saved === "number") count = saved;
  } catch (_) {}

  function nextLine() {
    count += 1;
    try { PickcatPlus.storage.set("petCount", count); } catch (_) {}
    const line = CAT_LINES[Math.floor(Math.random() * CAT_LINES.length)];
    return line + "\n\n（你已经撸我 " + count + " 次啦 🐾）";
  }

  // 在帖子交互栏加一个 🐱 按钮
  await PickcatPlus.addInteractionButton({ icon: "🐱", label: "小桌宠" }, async () => {
    const cardId = await PickcatPlus.showCard({
      title: "🐱 PICKCAT 小桌宠",
      text: nextLine(),
    });
    // 4 秒后自动收起卡片
    setTimeout(function () {
      try { PickcatPlus.closeCard(cardId); } catch (_) {}
    }, 4000);
  });

  PickcatPlus.log("PICKCAT 小桌宠已上线 🐱，累计撸猫次数:", count);
}

main();