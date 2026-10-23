/* تطبيق الإدارة (PWA): الواجهة الرئيسية فقط. شبكة أولا ثم آخر نسخة محفوظة إن كان الخادم مغلقا. لا نلمس /api ولا /m */
const C = 'samgym-admin-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.add('/').catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if(r.method !== 'GET' || u.origin !== location.origin || !(u.pathname === '/' || u.pathname === '/index.html')) return;
  e.respondWith((async () => {
    const c = await caches.open(C);
    try{
      const res = await Promise.race([fetch(r), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
      if(res && res.ok){ c.put('/', res.clone()); return res; }
      if(res && res.status >= 500){ const old = await c.match('/'); if(old) return old; }
      return res;
    }catch(err){ const hit = await c.match('/'); if(hit) return hit; throw err; }
  })());
});
