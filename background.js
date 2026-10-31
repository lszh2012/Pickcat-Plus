/* ==========================================================================
   PICKCAT Plus · 网络出口（background service worker）
   职责：替创意工坊插件发 HTTP 请求。
   为什么要有它：
     1) content script 的 fetch 会带上页面 origin，跨域被 CORS 挡；
        service worker 有 host_permissions，可以不受 CORS 限制。
     2) 沙盒页面被 CSP 设成 connect-src 'none'，插件自己根本连不上网，
        想联网只能走这条唯一出口 —— 这是浏览器强制的，不是我们说了算。

   出口规则（写死，改这里才算数）：
     · 只允许 https
     · 只允许 GET / POST / PUT / PATCH / DELETE
     · 一律不带 Cookie（credentials: 'omit'）
     · 30 秒超时
     · 响应体上限 512KB，超了直接掐断
     · 只回传 status / 少量响应头 / 响应文本
   ========================================================================== */

const NET_TIMEOUT = 30000;
const NET_MAX_BYTES = 512 * 1024;
const NET_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function fail(msg) {
    return { ok: false, error: String(msg || '网络请求失败') };
}

async function handleNet(req) {
    let u;
    try {
        u = new URL(String(req.url || ''));
    } catch (e) {
        return fail('非法 URL');
    }
    if (u.protocol !== 'https:') return fail('只允许 https 请求');

    const method = String(req.method || 'GET').toUpperCase();
    if (NET_METHODS.indexOf(method) === -1) return fail('不允许的请求方法：' + method);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT);
    try {
        const res = await fetch(u.toString(), {
            method: method,
            headers: (req.headers && typeof req.headers === 'object') ? req.headers : {},
            body: (method === 'GET' || method === 'DELETE') ? undefined : req.body,
            credentials: 'omit',      // 绝不带上任何 Cookie
            cache: 'no-store',
            redirect: 'follow',
            signal: ctrl.signal
        });

        const reader = res.body ? res.body.getReader() : null;
        let text = '';
        if (reader) {
            const decoder = new TextDecoder('utf-8');
            let total = 0;
            for (;;) {
                const step = await reader.read();
                if (step.done) break;
                total += step.value.length;
                if (total > NET_MAX_BYTES) {
                    try { reader.cancel(); } catch (e) { /* ignore */ }
                    return fail('响应超过 512KB，已中断');
                }
                text += decoder.decode(step.value, { stream: true });
            }
            text += decoder.decode();
        } else {
            text = await res.text();
            if (text.length > NET_MAX_BYTES) return fail('响应超过 512KB，已中断');
        }

        return {
            ok: true,
            status: res.status,
            statusText: res.statusText || '',
            url: res.url || u.toString(),
            headers: {
                'content-type': res.headers.get('content-type') || '',
                'x-request-id': res.headers.get('x-request-id') || '',
                'retry-after': res.headers.get('retry-after') || ''
            },
            body: text
        };
    } catch (e) {
        if (e && e.name === 'AbortError') return fail('请求超时（30 秒）');
        return fail((e && e.message) || '网络错误');
    } finally {
        clearTimeout(timer);
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'pickcat-net') return false;
    // 只接受来自本扩展页面的请求
    if (sender && sender.id && sender.id !== chrome.runtime.id) return false;
    handleNet(msg.payload || {}).then(sendResponse, (e) => sendResponse(fail(e && e.message)));
    return true;   // 异步回包
});
