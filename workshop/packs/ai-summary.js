/* ============================================================
 * 创意工坊插件：✨ AI 总结
 * id: ai-summary   version: 1.0.0
 *
 * 运行在 PICKCAT Plus 沙盒里，只能通过 PickcatPlus 这套 API 干活：
 *   - 拿不到 chrome.* / Cookie / 你的账号
 *   - 网络只允许打清单里 hosts 白名单内的域名
 *   - API Key 存在 storage 里，只在你自己点「总结」时才发出去
 * ============================================================ */

const buttonId = await PickcatPlus.addInteractionButton(
    { id: 'summarize', icon: '✨', label: 'AI 总结' },
    onSummarize
).catch(function (e) {
    PickcatPlus.log('按钮注册失败：' + e.message);
    return null;
});

let busy = false;

async function readSettings() {
    const s = await PickcatPlus.storage.get('settings');
    return Object.assign(
        {
            apiKey: '',
            model: 'deepseek-chat',
            baseUrl: 'https://api.deepseek.com/chat/completions'
        },
        s || {}
    );
}

function sysPrompt() {
    return [
        '你是一个帮人快速扫帖子的助手。请用中文总结下面这篇社区帖子的内容。',
        '要求：',
        '1. 先用一句话说清「这帖子在讲什么」，不超过 40 字；',
        '2. 再列 3-5 条要点，每条一行，用「· 」开头，每条不超过 50 字；',
        '3. 如果帖子是代码或作品展示，要点里写清用了什么技术/做法；',
        '4. 如果帖子只是灌水或内容太少，直接说「这篇比较水」，然后一句话概括；',
        '5. 不要客套话、不要「总结如下」、不要 Markdown 标题和粗体。'
    ].join('\n');
}

async function onSummarize() {
    if (busy) {
        PickcatPlus.showToast('上一份总结还在路上…');
        return;
    }

    const cfg = await readSettings();
    if (!cfg.apiKey) {
        PickcatPlus.showToast('请先在「创意工坊 → AI 总结 → ⚙ 设置」里填入 API Key');
        openSettingsHint();
        return;
    }

    const post = await PickcatPlus.getPostContent();
    const text = (post && post.text || '').trim();
    if (text.length < 120) {
        PickcatPlus.showToast('这篇正文太短了，没什么可总结的');
        return;
    }

    const title = (post.title || '当前页面').slice(0, 40);
    busy = true;

    const cardId = await PickcatPlus.showCard({
        title: '✨ AI 总结 · ' + title,
        text: '正在读正文（' + text.length + ' 字）…',
        loading: true
    });

    try {
        const body = {
            model: cfg.model || 'deepseek-chat',
            stream: false,
            temperature: 0.3,
            max_tokens: 700,
            messages: [
                { role: 'system', content: sysPrompt() },
                { role: 'user', content: '标题：' + title + '\n\n正文：\n' + text.slice(0, 9000) }
            ]
        };

        const res = await PickcatPlus.fetch(cfg.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg.apiKey
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const raw = await res.text().catch(function () { return ''; });
            throw new Error('HTTP ' + res.status + ' · ' + raw.slice(0, 300));
        }

        const data = await res.json();
        const out = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        if (!out.trim()) throw new Error('模型返回了空内容');

        await PickcatPlus.updateCard(cardId, tidy(out));
    } catch (e) {
        const msg = String((e && e.message) || e);
        await PickcatPlus.updateCard(
            cardId,
            '❌ 总结失败：' + msg + '\n\n常见原因：\n· API Key 填错或已失效\n· 账户余额不足（DeepSeek 会返回 402）\n· 接口地址填错（默认 https://api.deepseek.com/chat/completions）\n· 该域名不在插件白名单内'
        );
    } finally {
        busy = false;
    }
}

// 去掉模型偶尔返回的 Markdown 装饰，保持卡片里干净
function tidy(s) {
    return String(s)
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^\s*[-*]\s+/gm, '· ')
        .trim();
}

// 没填 Key 时，提示用户去工坊设置里填（点一下按钮回主面板）
function openSettingsHint() {
    PickcatPlus.log('需要配置 API Key');
}

PickcatPlus.log('AI 总结 已加载，按钮：' + (buttonId || '未注册'));
