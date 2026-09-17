/* 我的快乐日记 · Service Worker
   作用：把整个应用缓存到手机本地，实现「安装后 24 小时离线可用」，
   并满足 Android Chrome「安装为应用（隐藏地址栏）」的必要条件。

   本版关键策略（v16）：
   1. 页面导航改为【缓存优先】——永远秒开手机里的本地副本，
      沙箱休眠、断网、服务器重启都不影响打开；
   2. 识别平台「工作空间已停止」提示页（它是 HTTP 200 的"假成功"），
      绝不显示、绝不写入缓存，也不会让它污染安装；
   3. 沙箱醒着时，后台悄悄更新本地缓存，用户无感升级；
   4. 所有同源请求附带版本号查询参数（swv），绕过平台边缘缓存，
      保证拿到的永远是最新真实文件；
   5. 跨域请求（行情 JSONP、Gitee 云同步）直连网络，
      与沙箱是否休眠完全无关。 */
const CACHE = 'happy-diary-v19';
const SWV = '19';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './icon-180.png'
];
/* 平台沙箱休眠提示页的特征指纹 */
const STOP_RE = /工作空间已停止|SandboxId|TraceId|错误码|返回 Dashboard/;

/* 给 URL 附加版本号参数，穿透平台边缘缓存 */
function withV(u) {
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'swv=' + SWV;
}

/* 判断一个响应是否为"沙箱休眠提示页"（仅对 HTML 检查正文） */
async function isStoppedPage(res) {
  try {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html')) return false;
    const text = await res.clone().text();
    return STOP_RE.test(text);
  } catch (_) {
    return false;
  }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* 逐个抓取并校验：若沙箱正在休眠（拿到停止页），
       主动中止本次安装——旧 SW 继续服役，本地缓存不受污染。 */
    for (const a of ASSETS) {
      const res = await fetch(withV(a), { cache: 'no-store' });
      if (!res || !res.ok) throw new Error('资源抓取失败: ' + a);
      if (await isStoppedPage(res)) throw new Error('沙箱休眠中，放弃安装以保护旧缓存');
      await cache.put(a, res);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    /* 删除旧版本的缓存，避免占用与脏数据 */
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)));
    /* 立即接管所有已打开的页面 */
    await self.clients.claim();
    /* 强制所有已打开页面重新导航到刚缓存好的最新版本。
       注意：install 阶段已保证缓存的是真实应用（非停止页），此处刷新安全。
       activate 仅在 SW 版本切换时触发一次，不会死循环。 */
    const cls = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    cls.forEach(c => {
      try { if (c.url && c.navigate) c.navigate(c.url); } catch (_) {}
    });
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  /* 跨域请求（行情 JSONP、Gitee API 等）：直连网络，与沙箱状态无关 */
  if (url.origin !== self.location.origin) return;

  /* sw.js 本身永远走网络，绝不缓存，确保每次都能检测到新版本 */
  if (/sw\.js$/.test(url.pathname)) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  /* 同源资源（页面导航 + 静态文件）：缓存优先 + 安全的后台刷新 */
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true }) ||
                   (req.mode === 'navigate' ? await caches.match('./index.html') : null);

    /* 后台刷新：带版本参数穿透边缘缓存；
       拿到真实新内容才更新缓存；停止页/失败一律静默丢弃 */
    const refresh = (async () => {
      try {
        const res = await fetch(withV(req.url));
        if (res && res.ok && !(await isStoppedPage(res))) {
          const c = await caches.open(CACHE);
          await c.put(req, res.clone());
          return res;
        }
      } catch (_) {}
      return null;
    })();

    if (cached) {
      e.waitUntil(refresh);   /* 秒开本地副本，后台悄悄尝试更新 */
      return cached;
    }

    /* 本地还没有缓存（首次安装前的极端情况）：只能等网络 */
    const res = await refresh;
    if (res) return res;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>我的快乐日记</title><body style="font-family:sans-serif;padding:3em 2em;text-align:center;color:#8a4a6b">' +
      '<h2>😴 云端小屋正在休息</h2><p>本地还没有缓存副本，请等云端醒来后打开一次即可永久离线使用。</p></body>',
      { headers: { 'content-type': 'text/html;charset=utf-8' } }
    );
  })());
});
