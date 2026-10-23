const CACHE = 'samgym-shell-v21', MC = 'samgym-media-v1', SHELL = ['/m', '/m/icon.png', '/m/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== MC).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('push', e => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(x){ d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'SAM GYM', { body: d.body || '', icon: '/m/icon.png', badge: '/m/icon.png', lang: 'ar', dir: 'rtl', tag: 'samgym-msg', renotify: true }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(L => {
    for(const c of L){ if(c.url.indexOf('/m') > -1 && 'focus' in c) return c.focus(); }
    return clients.openWindow('/m');
  }));
});
/* رد جزئي (Range) من ملف محفوظ كاملا: ضروري لتشغيل الصوت والفيديو بلا اتصال */
async function fromCache(r, hit){
  const rg = r.headers.get('range'), m = rg && /^bytes=(\d*)-(\d*)$/.exec(rg);
  if(!m || !(m[1] || m[2])) return hit;
  const b = await hit.blob(), t = b.size;
  let a, z;
  if(m[1]){ a = +m[1]; z = m[2] ? Math.min(+m[2], t - 1) : t - 1; } else { a = Math.max(0, t - (+m[2])); z = t - 1; }
  if(a > z || a >= t) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + t } });
  return new Response(b.slice(a, z + 1), { status: 206, headers: { 'Content-Type': hit.headers.get('Content-Type') || b.type, 'Content-Range': 'bytes ' + a + '-' + z + '/' + t, 'Content-Length': String(z - a + 1), 'Accept-Ranges': 'bytes' } });
}
/* الواجهة تعمل بلا خادم: شبكة أولا (مهلة قصيرة) ثم آخر نسخة محفوظة. الصور والصوت والفيديو: من المخزن أولا (روابطها ثابتة لا تتغير) */
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if(r.method !== 'GET' || u.origin !== location.origin) return;
  const p = u.pathname;
  if(/^\/m\/media\/[0-9a-f]{24}$/.test(p)){
    e.respondWith((async () => {
      const mc = await caches.open(MC), hit = await mc.match(r.url);
      if(hit) return fromCache(r, hit);
      const res = await fetch(r);
      if(res.status === 200 && !r.headers.has('range') && /^image\//.test(res.headers.get('content-type') || '') && !/no-store/.test(res.headers.get('cache-control') || '')) mc.put(r.url, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }
  if(!(p === '/m' || p === '/m/' || p === '/m/icon.png' || p === '/m/manifest.json')) return;
  const key = p === '/m/' ? '/m' : p;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try{
      const res = await Promise.race([fetch(r), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3500))]);
      if(res && res.ok){ c.put(key, res.clone()); return res; }
      /* الخادم مغلق: النفق يرجع 502/503/504 — نعرض آخر نسخة محفوظة بدل صفحة الخطأ */
      if(res && res.status >= 500){ const old = await c.match(key); if(old) return old; }
      return res;
    }catch(err){
      const hit = await c.match(key); if(hit) return hit;
      throw err;
    }
  })());
});
