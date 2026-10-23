'use strict';
/* وحدة تطبيق المشتركين: دخول بالهاتف+الرمز، بطاقة الاشتراك، معلومات القاعة، إشعارات تلقائية */
const { execFile, spawn } = require('child_process'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os'), https = require('https'), httpLocal = require('http');
module.exports = function(c){
  const { can, store, save, send, readBody, sign, verifyToken, throttled, noteFail, clientIp } = c;
  let wp = null; try{ wp = require('web-push'); }catch(e){ console.error('web-push غير مثبت: شغّل npm install'); }
  if(wp && !store.vapid){ store.vapid = wp.generateVAPIDKeys(); save(); }
  if(wp) wp.setVapidDetails('mailto:admin@example.com', store.vapid.publicKey, store.vapid.privateKey);
  store.push = store.push || {}; store.pushLog = store.pushLog || {}; store.gymInfo = store.gymInfo || {}; store.feedback = store.feedback || [];
  store.mcodes = store.mcodes || {}; store.inbox = store.inbox || {}; store.pushOff = store.pushOff || {}; store.profiles = store.profiles || {};

  const QR = require('./vendor/QRCode'), QL = require('./vendor/QRCode/QRErrorCorrectLevel');
  function qrSvg(text){
    const q = new QR(-1, QL.M); q.addData(String(text).slice(0, 500)); q.make();
    const n = q.getModuleCount(), m = 4; let d = '';
    for(let r = 0; r < n; r++) for(let c = 0; c < n; c++) if(q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m) + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  function lan(){ const o = [], port = Number(process.env.PORT) || 3000; let f = {};
    try{ f = os.networkInterfaces(); }catch(e){ f = {}; }      // على أندرويد (Termux) قد يرفض النظام قراءة الواجهات
    for(const k in f) for(const a of f[k]) if(a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) o.push('http://' + a.address + ':' + port);
    if(!o.length){ try{ const t = require('child_process').execSync('ip -4 -o addr show 2>/dev/null || ifconfig 2>/dev/null', { timeout: 2500 }).toString(); for(const m of t.matchAll(/inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)/g)) if(!/^(127\.|169\.254)/.test(m[1])) o.push('http://' + m[1] + ':' + port); }catch(e){} }
    const rank = u => /\/\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(u) ? 0 : /\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(u) ? 2 : 1;   // الواي فاي أولا، وعنوان Tailscale (100.x) أخيرا
    return o.sort((a, b) => rank(a) - rank(b)); }
  const l9 = p => String(p || '').replace(/\D/g, '').slice(-9);
  const defCode = k => String(crypto.createHmac('sha256', store.secret).update('mc' + k).digest().readUInt32BE(0) % 10000).padStart(4, '0');
  const codeOf = k => store.mcodes[k] || defCode(k);
  /* مفتاح المشترك: آخر 9 أرقام من الهاتف، وإن لم يوجد هاتف صالح فمفتاح من الاسم (حتى يظهر كل المشتركين) */
  const sha = x => crypto.createHash('sha1').update(x).digest('hex').slice(0, 12);
  const normName = d => ((d.firstName || '') + '|' + (d.lastName || '')).trim().toLowerCase().replace(/\s+/g, ' ');
  /* هوية المشترك = الهاتف + الاسم (أشخاص مختلفون قد يشتركون في رقم واحد فيظهرون كلهم كما في البرنامج) */
  const idOf = d => (l9(d.phone).length >= 9 ? l9(d.phone) : '') + '|' + normName(d);
  const bornOf = r => { const m = /^m_(\d+)_/.exec(String(r.id)); if(m) return Number(m[1]); const t = r.data && r.data.createdAt ? Date.parse(r.data.createdAt) : NaN; return isNaN(t) ? Infinity : t; };
  /* تاريخ اليوم: تاريخ جهاز البرنامج (الخادم) — نفس التاريخ الذي يستعمله البرنامج الرئيسي */
  const pad2 = x => String(x).padStart(2, '0');
  const todayISO = () => { const n = new Date(); return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate()); };
  const daysLeft = e => { const t = new Date(e + 'T00:00:00'), n = new Date(); n.setHours(0,0,0,0); return Math.round((t - n) / 864e5); };
  function members(){            // آخر اشتراك لكل مشترك (كل المشتركين، بهاتف أو بدونه)
    const g = new Map();
    for(const k in store.items){
      const r = store.items[k];
      if(r.c !== 'members' || r.del || !r.data) continue;
      const d = r.data;
      if(!d.endDate || !(d.firstName || d.lastName || d.phone)) continue;
      const id = idOf(d), born = bornOf(r), o = g.get(id);
      if(!o) g.set(id, { d, born, rec: r });
      else { if(d.endDate > o.d.endDate){ o.d = d; o.rec = r; } if(born < o.born) o.born = born; }
    }
    const prim = new Map();                    // صاحب الرقم الأول (الأقدم) يحتفظ بمفتاح الهاتف نفسه كما كان
    for(const [id, o] of g){ const ph = l9(o.d.phone); if(ph.length < 9) continue; const p = prim.get(ph); if(!p || o.born < p.born || (o.born === p.born && id < p.id)) prim.set(ph, { id, born: o.born }); }
    const m = new Map(), idKey = new Map(), recs = new Map();
    for(const [id, o] of g){
      const ph = l9(o.d.phone);
      const k = (ph.length >= 9 && prim.get(ph).id === id) ? ph : 'n' + sha(ph.length >= 9 ? id : normName(o.d));
      m.set(k, o.d); idKey.set(id, k); recs.set(k, o.rec);
    }
    members.idKey = idKey; members.recs = recs;
    return m;
  }
  function markReminded(k){            // يسجّل «تم التذكير» على آخر اشتراك للمشترك (يتزامن مع البرنامج)
    members(); const best = members.recs.get(k);
    if(best){ best.data = Object.assign({}, best.data, { appNotifiedAt: todayISO() }); best.ts = Date.now(); best.seq = ++store.seq; save(); }
  }
  function keyFromBody(b){            // مفتاح مشترك من طلب: id سجل، أو key، أو phone
    if(b.id){ members(); for(const k in store.items){ const r = store.items[k]; if(r.c === 'members' && !r.del && r.data && r.id === String(b.id)){ const kk = members.idKey.get(idOf(r.data)); if(kk) return kk; } } }
    if(b.key && /^[0-9n][0-9a-f]*$/.test(String(b.key))) return String(b.key);
    const n = l9(b.phone); if(n.length >= 9) return n;
    return '';
  }
  const DEF_PLANS = [
    { id: 's4', label: 'كمال الأجسام 4 حصص في الأسبوع', price: 2000 }, { id: 's5', label: 'كمال الأجسام 5 حصص في الأسبوع', price: 2500 },
    { id: 'cardio', label: 'كمال الأجسام + كارديو', price: 3000 }, { id: 'treadmill', label: 'كمال الأجسام + آلة الجري', price: 3000 },
    { id: 'full', label: 'كمال الأجسام + كارديو + آلة الجري', price: 3500 }];
  const planDocs = () => (store.docs && store.docs.plans && Array.isArray(store.docs.plans.data) && store.docs.plans.data.length) ? store.docs.plans.data : DEF_PLANS;
  function plansList(){
    const L = planDocs();
    return L.map(x => ({ label: String(x.label || ''), price: Number(x.price) || 0 })).filter(x => x.label);
  }
  function planName(d){            // اسم نوع الاشتراك من باقات البرنامج
    const p = planDocs().find(x => x.id === d.subType) || null;
    return p ? String(p.label || '') : '';
  }
  function who(req){
    const t = String(req.headers.authorization || '').replace(/^Bearer /, ''), p = t.split('.');
    if(p.length !== 3 || p[0][0] !== 'm' || Number(p[1]) < Date.now()) return null;
    const a = Buffer.from(sign(p[0], p[1])), b = Buffer.from(t);
    return (a.length === b.length && crypto.timingSafeEqual(a, b)) ? p[0].slice(1) : null;
  }
  /* الرسالة تصل دائما: تُحفظ في صندوق المشترك (تظهر عند فتح تطبيقه) وتُرسل كإشعار إن كان مفعّلا */
  async function deliver(n, payload, rem, audio){
    const box = store.inbox[n] = store.inbox[n] || [];
    const it = { id: crypto.randomBytes(5).toString('hex'), ts: Date.now(), title: payload.title, body: payload.body, read: false };
    if(rem){ it.kind = 'rem'; it.end = rem; }
    if(audio){ if(typeof audio === 'object'){ it.audio = audio.id; it.parts = audio.parts; } else it.audio = audio; }            // تسجيل صوتي مرفق بالتذكير (معرّف ملف في store.media)            // رسالة تذكير بالاشتراك (تُتابَع قراءتها في لوحة التحكم)
    box.push(it);
    if(box.length > 50) box.splice(0, box.length - 50);
    save();
    return { inbox: true, push: await notify(n, payload) };
  }
  const remMsg = (n, d) => (store.inbox[n] || []).slice().reverse().find(x => x.kind === 'rem' && x.end === d.endDate) || null;
  const canRe = (n, d) => { const m = remMsg(n, d); return !!m && !m.read && Date.now() - m.ts >= 864e5; };
  let lastPushErr = '';
  async function notify(n, payload){
    const s = store.push[n]; if(!wp || !s) return false;
    try{ await wp.sendNotification(s, JSON.stringify(payload), { TTL: 86400, urgency: 'high' }); lastPushErr = ''; return true; }
    catch(e){ lastPushErr = (e.statusCode || '') + ' ' + String(e.body || e.message || '').slice(0, 160); console.error('push error:', lastPushErr);
      if(e.statusCode === 404 || e.statusCode === 410){ delete store.push[n]; save(); } return false; }
  }
  const moneyN = v => { const x = Number(v); return isFinite(x) ? x : 0; };
  const payInfo = d => ({ paid: d.amountPaid == null ? null : moneyN(d.amountPaid), remaining: Math.max(0, moneyN(d.remaining)), payKnown: d.amountPaid != null || d.remaining != null });
  /* الملف الشخصي للمشترك: الطول، الوزن، تاريخ ومكان الميلاد، الهدف من التدريب */
  const GOALS = ['gain', 'lose', 'muscle', 'tone', 'strength', 'fit', 'health', 'sport'];
  /* خانات نافذة «معلوماتي الشخصية»: يتحكم فيها المدير من لوحة التحكم (تعديل/إضافة/حذف) */
  const DEF_FIELDS = [
    { id: 'height', label: 'الطول', type: 'number', unit: 'سم', ph: '175', min: 50, max: 250 },
    { id: 'weight', label: 'الوزن', type: 'number', unit: 'كغ', ph: '70', min: 20, max: 400 },
    { id: 'birthDate', label: 'تاريخ الميلاد', type: 'date' },
    { id: 'birthPlace', label: 'مكان الميلاد', type: 'text', ph: 'مثال: سطيف' },
    { id: 'goal', label: 'الغرض من التدرب', type: 'multi', opts: [{ id: 'gain', label: 'زيادة الوزن' }, { id: 'lose', label: 'إنقاص الوزن' }, { id: 'muscle', label: 'بناء العضلات' }, { id: 'tone', label: 'التنشيف' }, { id: 'strength', label: 'زيادة القوة' }, { id: 'fit', label: 'اللياقة البدنية' }] }
  ];
  if(!Array.isArray(store.pfields)){ store.pfields = JSON.parse(JSON.stringify(DEF_FIELDS)); save(); }
  /* ===== أقسام معلومات القاعة (نص + صور + فيديو + صوت) — يتحكم فيها المدير: إضافة / تعديل / حذف / ترتيب ===== */
  const MEDIA_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'media');
  store.media = store.media || {};
  const MTYPES = {
    'image/jpeg': ['image', 'jpg', 25], 'image/png': ['image', 'png', 25], 'image/webp': ['image', 'webp', 25], 'image/gif': ['image', 'gif', 25],
    'video/mp4': ['video', 'mp4', 300], 'video/webm': ['video', 'webm', 300], 'video/quicktime': ['video', 'mov', 300],
    'audio/mpeg': ['audio', 'mp3', 60], 'audio/mp4': ['audio', 'm4a', 60], 'audio/x-m4a': ['audio', 'm4a', 60], 'audio/aac': ['audio', 'aac', 60],
    'audio/webm': ['audio', 'webm', 60], 'audio/ogg': ['audio', 'ogg', 60], 'audio/wav': ['audio', 'wav', 60], 'audio/x-wav': ['audio', 'wav', 60]
  };
  const SEC_ICONS = ['mega', 'clock', 'rules', 'price', 'phone', 'dumb', 'cal', 'info', 'pin', 'chat', 'tag', 'chk', 'warn', 'user', 'bell', 'mail'];
  if(!Array.isArray(store.sections)){          // ترحيل: النصوص القديمة (إعلانات، مواعيد، تعليمات، أسعار، تواصل) تصبح أقسام + قسم البرنامج التدريبي
    const g = store.gymInfo || {}, mk = (id, title, icon, where, text, extra) => Object.assign({ id, title, icon, where, text: String(text || ''), media: [] }, extra || {});
    store.sections = [
      mk('news', 'إعلانات', 'mega', 'home', g.news),
      mk('hours', 'مواعيد العمل', 'clock', 'info', g.hours),
      mk('training', 'البرنامج التدريبي', 'dumb', 'info', ''),
      mk('rules', 'التعليمات والقوانين', 'rules', 'info', g.rules),
      mk('prices', 'الأسعار والباقات', 'price', 'info', g.prices, { plans: true }),
      mk('contact', 'للتواصل', 'phone', 'info', g.contact, { kind: 'contact' })
    ];
    save();
  }
  store.reacts = store.reacts || {};
  store.sections.forEach(x => { delete x.plans; });          // قائمة الباقات التلقائية أُلغيت
  const REACTS = ['❤️', '👍', '🔥', '💪', '👏'];
  function secOut(n){          // الأقسام مع عدّاد التفاعلات وتفاعل هذا المشترك
    return store.sections.map(x => { const r = store.reacts[x.id] || {}, rc = {}; let mine = '';
      for(const k in r){ rc[r[k]] = (rc[r[k]] || 0) + 1; if(k === n) mine = r[k]; }
      return Object.assign({}, x, { rc, mine, reacts: REACTS }); });
  }
  /* ===== الدردشة الجماعية: يتحكم فيها المدير (تفعيل/تعطيل كلي، إشعارات، حذف رسائل، كتم مشترك، مسح) ===== */
  store.chat = store.chat || { on: false, notif: true, seq: 0, msgs: [], muted: {} };
  const CH = store.chat; CH.muted = CH.muted || {};
  const chatAdd = m => { m.seq = ++CH.seq; CH.msgs.push(m); if(CH.msgs.length > 500) CH.msgs.splice(0, CH.msgs.length - 500); save(); };
  const chatPub = (m, n) => ({ id: m.id, seq: m.seq, name: m.name, text: m.text, ts: m.ts, admin: !!m.admin, mine: !!n && m.n === n, del: !!m.del });
  function chatList(since, n){
    let L = CH.msgs.filter(m => m.seq > since);
    if(!since) L = L.filter(m => !m.del).slice(-100); else if(L.length > 300) L = L.slice(-300);
    return L.map(m => chatPub(m, n));
  }
  const chatLast = {}, chatPushLast = {};
  function chatPush(m){            // إشعار لكل مشترك مفعّل الإشعارات (عدا المرسل)، وبحد أقصى مرة كل دقيقة لكل مشترك
    if(!CH.on || !CH.notif) return;
    const title = ((store.gymInfo && store.gymInfo.name) || 'Smart Gym Manager') + ' — الدردشة', body = (m.admin ? '📢 ' : '💬 ') + m.name + ': ' + m.text.slice(0, 120), now = Date.now();
    for(const k of Object.keys(store.push)){
      if(k === m.n || now - (chatPushLast[k] || 0) < 60000) continue;
      chatPushLast[k] = now; notify(k, { title, body }).catch(() => {});
    }
  }
  function cleanSections(arr){
    const out = [], seen = new Set();
    for(const x of (Array.isArray(arr) ? arr : []).slice(0, 40)){
      const title = String((x && x.title) || '').trim().slice(0, 80); if(!title) continue;
      let id = /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(String(x.id || '')) ? String(x.id) : 's' + crypto.randomBytes(4).toString('hex');
      while(seen.has(id)) id = 's' + crypto.randomBytes(4).toString('hex'); seen.add(id);
      const o = { id, title, icon: SEC_ICONS.includes(x.icon) ? x.icon : 'info', where: x.where === 'home' ? 'home' : 'info', text: String(x.text || '').slice(0, 10000), media: [] };
      if(x.react === false) o.react = false;
      if(x.kind === 'contact') o.kind = 'contact';
      for(const m of (Array.isArray(x.media) ? x.media : []).slice(0, 40)){
        const r = m && store.media[String(m.id)]; if(!r || o.media.some(y => y.id === m.id)) continue;
        o.media.push({ id: String(m.id), type: r.type, cap: String(m.cap || '').trim().slice(0, 120) });
      }
      out.push(o);
    }
    return out;
  }
  function gcMedia(){            // يحذف الملفات التي لا يستعملها أي قسم (مع إمهال يوم لما رُفع ولم يُحفظ بعد)
    try{
      const used = new Set(); for(const s of store.sections) for(const m of s.media) used.add(m.id);
      const vv = (store.gymInfo && store.gymInfo.voice) || {}; for(const k of ['soon', 'expired']) if(vv[k]) used.add(vv[k]);
      const tc = ttsCfg(); for(const k of ['soon', 'expired']) for(const p of ['pre', 'post']) if(tc.seq[k][p]) used.add(tc.seq[k][p]);
      for(const pid of Object.keys(store.playlists)){ const pl = store.playlists[pid]; if(Date.now() - (pl.ts || 0) > 60 * 864e5) delete store.playlists[pid]; else for(const x of pl.parts) used.add(x); }
      for(const id of Object.keys(store.media)){
        if(used.has(id) || Date.now() - (store.media[id].ts || 0) < (store.media[id].tts ? 14 * 864e5 : 864e5)) continue;
        try{ fs.unlinkSync(path.join(MEDIA_DIR, id)); }catch(e){}
        delete store.media[id];
      }
      save();
    }catch(e){}
  }
  setTimeout(gcMedia, 60000); setInterval(gcMedia, 6 * 3600 * 1000);
  const infoOut = () => { const c = store.sections.find(x => x.kind === 'contact'); return Object.assign({}, store.gymInfo, { contact: c ? c.text : '', clock: { ts: Date.now(), tz: new Date().getTimezoneOffset() } }); };
  /* تنظيف جدول مواعيد العمل القادم من لوحة الإدارة: 7 أيام (0=الأحد…6=السبت) */
  const cleanSchedule = (s) => {
    const hm = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '')); return m && +m[1] < 24 && +m[2] < 60 ? pad2(+m[1]) + ':' + m[2] : ''; };
    const src = (s && Array.isArray(s.days)) ? s.days : [], days = [];
    for(let i = 0; i < 7; i++){ const d = src[i] || {}, from = hm(d.from) || '08:00', to = hm(d.to) || '22:00', bf = hm(d.bf), bt = hm(d.bt);
      days.push({ on: !!d.on, from, to, brk: !!d.brk && !!bf && !!bt, bf: bf || '13:00', bt: bt || '15:00' }); }
    return { show: !s || s.show !== false, days, note: String((s && s.note) || '').slice(0, 300) };
  };
  function upload(req, res, u){        // رفع ملف خام (بث مباشر إلى القرص): POST /api/m/media?name=...  و Content-Type = نوع الملف
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), t = MTYPES[mime];
    if(!t){ send(req, res, 415, { error: 'bad_type' }); req.resume(); return; }
    const max = t[2] * 1048576, declared = Number(req.headers['content-length']) || 0;
    if(declared > max){ send(req, res, 413, { error: 'too_large', max: t[2] }); req.resume(); return; }
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const id = crypto.randomBytes(12).toString('hex'), f = path.join(MEDIA_DIR, id), tmp = f + '.part', ws = fs.createWriteStream(tmp);
    let size = 0, dead = false;
    const fail = (code, e) => { if(dead) return; dead = true; try{ ws.destroy(); fs.unlinkSync(tmp); }catch(x){} send(req, res, code, { error: e, max: t[2] }); };
    req.on('data', c => { size += c.length; if(size > max){ fail(413, 'too_large'); req.destroy(); } });
    req.on('error', () => fail(400, 'aborted')); req.on('aborted', () => fail(400, 'aborted'));
    ws.on('error', () => fail(500, 'save_failed'));
    ws.on('finish', () => {
      if(dead) return;
      if(!size){ try{ fs.unlinkSync(tmp); }catch(e){} return send(req, res, 400, { error: 'empty' }); }
      fs.renameSync(tmp, f);
      store.media[id] = { type: t[0], mime, ext: t[1], size, ts: Date.now(), name: String(new URL(req.url, 'http://x').searchParams.get('name') || '').slice(0, 120) };
      save(); send(req, res, 200, { ok: 1, id, type: t[0], size });
    });
    req.pipe(ws);
  }
  function serveMedia(req, res, id, nc){      // GET /m/media/<id> مع دعم Range (ضروري لتشغيل الفيديو والصوت على الآيفون)
    const r = store.media[id], f = path.join(MEDIA_DIR, id);
    if(!r || !fs.existsSync(f)){ res.writeHead(404); res.end('not found'); return; }
    const total = fs.statSync(f).size, h = { 'Content-Type': r.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': nc ? 'no-store' : 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let a = 0, b = total - 1, code = 200;
    if(m && (m[1] || m[2])){
      if(m[1]){ a = Number(m[1]); if(m[2]) b = Math.min(b, Number(m[2])); } else { a = Math.max(0, total - Number(m[2])); }
      if(a > b || a >= total){ res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return; }
      code = 206; h['Content-Range'] = 'bytes ' + a + '-' + b + '/' + total;
    }
    h['Content-Length'] = b - a + 1; res.writeHead(code, h);
    if(req.method === 'HEAD'){ res.end(); return; }
    const rs = fs.createReadStream(f, { start: a, end: b }); rs.on('error', () => res.destroy()); res.on('close', () => rs.destroy()); rs.pipe(res);
  }
  const FTYPES = ['text', 'number', 'date', 'choice', 'multi'];
  function cleanFields(arr){
    const out = [], seen = new Set();
    for(const f of (Array.isArray(arr) ? arr : []).slice(0, 30)){
      const label = String((f && f.label) || '').trim().slice(0, 60); if(!label) continue;
      const type = FTYPES.includes(f.type) ? f.type : 'text';
      let id = /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(String(f.id || '')) ? String(f.id) : 'f' + crypto.randomBytes(4).toString('hex');
      while(seen.has(id)) id = 'f' + crypto.randomBytes(4).toString('hex'); seen.add(id);
      const o = { id, label, type };
      if(type === 'number'){
        o.unit = String(f.unit || '').trim().slice(0, 12); o.ph = String(f.ph || '').trim().slice(0, 30);
        const mn = Number(f.min), mx = Number(f.max); if(f.min !== '' && f.min != null && isFinite(mn)) o.min = mn; if(f.max !== '' && f.max != null && isFinite(mx)) o.max = mx;
      } else if(type === 'text'){ o.ph = String(f.ph || '').trim().slice(0, 60); }
      else if(type === 'choice' || type === 'multi'){
        const os = new Set(); o.opts = [];
        for(const x of (Array.isArray(f.opts) ? f.opts : []).slice(0, 30)){
          const l = String((x && x.label) || '').trim().slice(0, 40); if(!l) continue;
          let oid = /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(String(x.id || '')) ? String(x.id) : 'o' + crypto.randomBytes(4).toString('hex');
          while(os.has(oid)) oid = 'o' + crypto.randomBytes(4).toString('hex'); os.add(oid); o.opts.push({ id: oid, label: l });
        }
        if(!o.opts.length) continue;
      }
      out.push(o);
    }
    return out;
  }
  function cleanProfile(b){
    const o = {};
    for(const f of store.pfields){
      const v = b[f.id];
      if(f.type === 'number'){
        const x = Number(String(v == null ? '' : v).replace(',', '.')), lo = f.min != null ? f.min : -1e9, hi = f.max != null ? f.max : 1e9;
        o[f.id] = (String(v == null ? '' : v).trim() !== '' && isFinite(x) && x >= lo && x <= hi) ? Math.round(x * 10) / 10 : null;
      } else if(f.type === 'date'){
        const t = String(v || ''); o[f.id] = /^\d{4}-\d{2}-\d{2}$/.test(t) && t <= todayISO() && t >= '1900-01-01' ? t : '';
      } else if(f.type === 'text'){ o[f.id] = String(v || '').trim().slice(0, 200); }
      else { const ids = f.opts.map(x => x.id), sel = [...new Set(String(v || '').split(',').map(x => x.trim()).filter(x => ids.includes(x)))]; o[f.id] = (f.type === 'choice' ? sel.slice(0, 1) : sel).join(','); }
    }
    o.updatedAt = Date.now(); return o;
  }
  const profEmpty = o => !store.pfields.some(f => o[f.id] !== null && o[f.id] !== undefined && o[f.id] !== '');
  const photoOf = d => (typeof d.photo === 'string' && d.photo.startsWith('data:image/')) ? d.photo : '';
  /* التذكير الصوتي: تسجيلان اختياريان (قبل انتهاء الاشتراك / بعد انتهائه) يُرسلان مع التذكير الكتابي */
  const audioOk = id => { const r = typeof id === 'string' && store.media[id]; return !!r && r.type === 'audio'; };
  const cleanVoice = v => ({ soon: v && audioOk(v.soon) ? v.soon : '', expired: v && audioOk(v.expired) ? v.expired : '' });
  const voiceFor = d => { const v = cleanVoice(store.gymInfo && store.gymInfo.voice); return (daysLeft(d.endDate) < 0 ? v.expired : v.soon) || ''; };
  /* ===== التذكير الصوتي الشخصي: رسالة صوتية تذكر اسم المشترك، تُولَّد تلقائيا (نص ← كلام) وتُخزَّن مؤقتا ===== */
  const WRITTEN = (kind) => 'مرحبا {الاسم الكامل}، هذا تذكير من القاعة الرياضية {القاعة} بخصوص اشتراكك الذي ' + (kind === 'expired' ? 'انتهى' : 'ينتهي') + ' بتاريخ {التاريخ}. مرحبا بكم وشكرا على ثقتكم.';       // نفس نص التذكير الكتابي الافتراضي
  const TTS_DEF = { mode: 'off', soon: WRITTEN('soon'), expired: WRITTEN('expired') };
  const TTS_OLD = ['السلام عليكم {الاسم}، نذكّرك أن اشتراكك في القاعة ينتهي {المدة}. نتمنى لك التوفيق.', 'السلام عليكم {الاسم}، نذكّرك أن اشتراكك في القاعة قد انتهى. ننتظرك لتجديده.'];
  store.playlists = store.playlists || {};
  const cleanTts = t => {
    const o = t && typeof t === 'object' ? t : {}, mode = ['off', 'full', 'seq'].includes(o.mode) ? o.mode : (o.on ? 'full' : 'off');
    const s = (v, d) => { const x = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 400); return (!x || TTS_OLD.includes(x)) ? d : x; };
    const sq = k => { const q = (o.seq && o.seq[k]) || {}; return { pre: audioOk(q.pre) ? q.pre : '', post: audioOk(q.post) ? q.post : '' }; };
    return { mode, soon: s(o.soon, TTS_DEF.soon), expired: s(o.expired, TTS_DEF.expired), seqName: o.seqName === 'first' ? 'first' : 'full', dict: String(o.dict || '').replace(/\r/g, '').slice(0, 4000), seq: { soon: sq('soon'), expired: sq('expired') } };
  };
  const ttsCfg = () => cleanTts(store.gymInfo && store.gymInfo.tts);
  const MONTHS_AR = ['جانفي', 'فيفري', 'مارس', 'أفريل', 'ماي', 'جوان', 'جويلية', 'أوت', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const spokenDate = e => { const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e)); return x ? Number(x[3]) + ' ' + MONTHS_AR[Number(x[2]) - 1] + ' ' + x[1] : String(e); };
  const daysWord = n => n === 1 ? 'يوم واحد' : n === 2 ? 'يومين' : n <= 10 ? n + ' أيام' : n + ' يوما';
  const spokenSpan = dl => dl > 1 ? 'بعد ' + daysWord(dl) : dl === 1 ? 'غدا' : dl === 0 ? 'اليوم' : 'منذ ' + daysWord(-dl);
  const hasArabic = s => /[\u0600-\u06FF]/.test(s);
  const ttsId = (tag, x) => crypto.createHmac('sha256', store.secret).update(tag + '|' + x).digest('hex').slice(0, 24);
  const namesOf = d => { const first = String(d.firstName || '').trim(), full = (first + ' ' + String(d.lastName || '').trim()).trim() || 'العزيز'; return { first: first || full, full }; };
  /* ===== النطق بالعربية دائما: الأسماء المكتوبة بالحروف اللاتينية تُحوَّل إلى حروف عربية قبل التوليد ===== */
  const AR_RAW = 'mohamed,mohammed,mohamad,muhammad,med=محمد;ahmed,ahmad=أحمد;amine,amin=أمين;yacine,yassine,yasin=ياسين;karim=كريم;bilal,bilel,billel,billal=بلال;sofiane,sofian,soufiane,soufian=سفيان;walid,oualid=وليد;rachid=رشيد;nabil=نبيل;samir=سمير;redouane,redwan,ridwan,radouane=رضوان;abdelkader,abdelkadir=عبد القادر;abdelkrim,abdelkarim=عبد الكريم;abderrahmane,abderrahmen,abderrahman=عبد الرحمن;abdelhak=عبد الحق;abdelaziz=عبد العزيز;abdelmalek=عبد المالك;abdallah,abdellah=عبد الله;abdelhamid=عبد الحميد;abdelghani=عبد الغني;abdelwahab=عبد الوهاب;abdelmoumen=عبد المؤمن;abdelhafid=عبد الحفيظ;abdennour,abdenour=عبد النور;abdel,abd=عبد;ali=علي;omar,oumar=عمر;othmane,othman=عثمان;oussama,oussema,osama=أسامة;youssef,yousef,youcef,youssouf=يوسف;ibrahim,brahim=إبراهيم;ismail,smail,ismael=إسماعيل;hamza=حمزة;hakim=حكيم;hicham,hichem,hisham=هشام;houssem,hossam,houssam=حسام;hocine,hossein,hussein,houcine=حسين;hassan,hacene,hasan=حسن;hamid=حميد;farid=فريد;fouad,foued=فؤاد;fares,faris=فارس;zakaria,zakariya,zakaria=زكرياء;zinedine,zineddine=زين الدين;salah,saleh=صلاح;salim,selim=سليم;sami=سامي;said,saïd=سعيد;sidali=سيد علي;slimane,slimen,sliman=سليمان;tarek,tarik,tareq=طارق;toufik,tawfik,toufiq=توفيق;mourad,murad=مراد;mustapha,moustapha,mostefa=مصطفى;mounir,munir=منير;mehdi,mahdi=مهدي;merouane,marwan,marouane=مروان;nacer,nasser,nasr=ناصر;nadir=نادر;nassim,nacim=نسيم;noureddine,nourdine,noureddin=نور الدين;lotfi,lutfi=لطفي;lyes,ilyes,elyes,ilias=إلياس;ayoub,ayyoub=أيوب;anis,anes=أنيس;adel=عادل;aymen,ayman,aimen=أيمن;akram=أكرم;amir,emir=أمير;amer=عامر;badreddine,badreddin=بدر الدين;chaouki=شوقي;chakib=شكيب;djamel,jamel,djamal=جمال;djalal=جلال;djilali,jilali=الجيلالي;yaman,yamen=يمان;yahia,yahya=يحيى;younes,yunus,younès=يونس;wassim,wasim=وسيم;wahid,oued=وحيد;idir=إدير;islam=إسلام;imad,imed=عماد;mouloud=مولود;kamel,kamal=كامل;kader,kadder,kadir=قادر;kaci,kassi=قاسي;khaled,khalid=خالد;khelil,khalil=خليل;riad,riyad=رياض;rabah=رباح;rafik=رفيق;ramzi=رمزي;sabri=صبري;sadek,sadik=صادق;seif,sif,seyf=سيف;saad=سعد;sid=سيد;mahmoud=محمود;mokhtar,mukhtar=مختار;messaoud,massoud=مسعود;mansour=منصور;bachir,bashir=بشير;belkacem=بلقاسم;benali=بن علي;ben=بن;bou,abou=بو;oulad=أولاد;el,al=ال;hadj,hadji=الحاج;madjid,majid=ماجد;mohand=محند;hamou=حمو;aissa,aïssa=عيسى;moussa,musa=موسى;ishak,ishaq=إسحاق;daoud,daoued=داود;sofiane;nadjib,najib=نجيب;nazim=ناظم;nawfel,nawel=نوفل;oussama;fateh,fatah=فاتح;fethi,fathi=فتحي;faycal,fayçal,faisal=فيصل;fodil,fudil=فضيل;ghani=غني;hilal=هلال;houari=هواري;kheireddine,khayreddine=خير الدين;mebarek,mubarak=مبارك;miloud=ميلود;nadjim,najim=نجيم;salaheddine=صلاح الدين;sidahmed=سيد أحمد;sifeddine=سيف الدين;taki,takieddine=تقي الدين;tayeb,taieb=الطيب;yazid=يزيد;younesse=يونس;zouhir,zouheir=زهير;fatima,fatma=فاطمة;khadija,khadidja,khadidjah=خديجة;aicha,aisha,aïcha=عائشة;meriem,maryam,mariam=مريم;amel=أمل;amira=أميرة;asma=أسماء;nadia=نادية;samia=سامية;sara,sarah=سارة;sabrina=صابرينة;imane,iman=إيمان;lamia=لمياء;leila,laila,lila=ليلى;lina=لينا;manel,manal=منال;nour,nor=نور;rania=رانيا;rym,rim=ريم;selma,salma=سلمى;soumia,soumaya=سمية;wafa=وفاء;yasmine,yasmin=ياسمين;zineb=زينب;hanane=حنان;houda=هدى;karima=كريمة;malika=مليكة;nawal,nawel=نوال;nesrine=نسرين;djamila=جميلة;hadjer,hajer=هاجر;ikram=إكرام;kenza=كنزة;lydia=ليدية;mouna=منى;rahma=رحمة;sihem=سهام;sonia=سونيا;wiam=وئام;gym=جيم;fitness=فيتنس;club=كلوب;sport,sports=سبورت;sam=سام;smart=سمارت;manager=مانجر;center,centre=سنتر;power=باور;body=بودي;fit=فيت;top=توب;king=كينغ;team=تيم;life=لايف;pro=برو;zone=زون;house=هاوس;star=ستار;elite=إيليت;gold=غولد;iron=آيرن;muscle=ماسل;lion=ليون;titan=تيتان;olympia=أولمبيا;hercules=هرقل';
  const AR_MAP = new Map(); for(const g of AR_RAW.split(';')){ const [ks, v] = g.split('='); if(!v) continue; for(const k of ks.split(',')) AR_MAP.set(k.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), v); }
  const latKey = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  let dictCache = { s: null, m: null };
  const customDict = () => { const s = ttsCfg().dict; if(dictCache.s === s) return dictCache.m; const mp = new Map(); for(const line of s.split('\n')){ const i = line.indexOf('='); if(i < 1) continue; const k = latKey(line.slice(0, i)), v = line.slice(i + 1).trim(); if(k && v) mp.set(k, v); } dictCache = { s, m: mp }; return mp; };
  const TR1 = { b: 'ب', d: 'د', f: 'ف', l: 'ل', m: 'م', n: 'ن', p: 'ب', r: 'ر', t: 'ت', v: 'ف', z: 'ز', h: 'ه', j: 'ج', k: 'ك', q: 'ق', s: 'س', w: 'و', x: 'كس', a: 'ا', i: 'ي', o: 'و', u: 'و', y: 'ي' };
  const TR2 = { ou: 'و', ch: 'ش', sh: 'ش', kh: 'خ', gh: 'غ', dj: 'ج', ph: 'ف', th: 'ث', ai: 'اي', ei: 'اي', ee: 'ي' };
  function translitWord(w){            // تحويل صوتي تقريبي للأسماء غير الموجودة في القاموس (يمكن تصحيحها من «قاموس النطق»)
    let o = '', i = 0;
    while(i < w.length){
      const c = w[i], n = w[i + 1] || '', two = c + n;
      if(TR2[two]){ o += TR2[two]; i += 2; continue; }
      if(c === n && 'aeiouy'.indexOf(c) < 0){ i++; continue; }
      if(c === 'e'){ o += i === 0 ? 'إ' : ''; i++; continue; }
      if(c === 'c'){ o += 'eiy'.includes(n) && n ? 'س' : 'ك'; i++; continue; }
      if(c === 'g'){ o += 'eiy'.includes(n) && n ? 'ج' : 'ق'; i++; continue; }
      o += TR1[c] || ''; i++;
    }
    return o.replace(/(.)\1+/g, '$1');
  }
  function arabize(text){            // كل مقطع لاتيني يصبح عربيا: قاموسك أولا، ثم القاموس المدمج، ثم التحويل الصوتي
    const cu = customDict(), look = k => cu.get(k) || AR_MAP.get(k) || '';
    return String(text).replace(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\-]*(?:[ \t]+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\-]*)*/g, run => {
      const whole = look(latKey(run)); if(whole) return whole;
      return run.split(/\s+/).map(tok => look(latKey(tok)) || tok.split(/['’\-]/).filter(Boolean).map(pt => look(latKey(pt)) || translitWord(latKey(pt))).join(' ')).join(' ');
    });
  }
  function ttsPlan(d, kind, tpl){            // النص المنطوق (عربي دائما) + معرّف ثابت (HMAC) يتغير فقط إذا تغير النص المنطوق
    const gy = String((store.gymInfo && store.gymInfo.name) || 'القاعة').trim(), nm = namesOf(d);
    const txt = arabize(String(tpl != null ? tpl : ttsCfg()[kind]).replace(/\{المدة\}/g, spokenSpan(daysLeft(d.endDate))).replace(/\{التاريخ\}/g, spokenDate(d.endDate)).replace(/\{الاسم الكامل\}/g, nm.full).replace(/\{الاسم\}/g, nm.first).replace(/\{القاعة\}/g, gy));
    const segs = [{ t: txt, l: 'ar' }];
    return { id: ttsId('tts1', JSON.stringify(segs)), segs, said: txt };
  }
  /* الدمج بالتتابع: تسجيلك قبل الاسم ← نطق الاسم آليا (بالعربية) ← تسجيلك بعد الاسم (تُشغَّل المقاطع تباعا) */
  function seqPlan(d, kind, o){
    const c = ttsCfg(), s = o || Object.assign({ seqName: c.seqName }, c.seq[kind]); if(!s.pre && !s.post) return null;
    const nm = namesOf(d), n = arabize(s.seqName === 'first' ? nm.first : nm.full), segs = [{ t: n, l: 'ar' }], name = { id: ttsId('tts1', JSON.stringify(segs)), segs };
    const parts = [s.pre, name.id, s.post].filter(Boolean);
    return { id: ttsId('seq1', parts.join(',')), parts, name, kind, said: n };
  }
  function gttsGet(text, lang){
    return new Promise((ok, bad) => {
      const rq = https.get('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + lang + '&q=' + encodeURIComponent(text), { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Referer': 'https://translate.google.com/' } }, r => {
        if(r.statusCode !== 200){ r.resume(); return bad(new Error('tts http ' + r.statusCode)); }
        const ch = []; r.on('data', x => ch.push(x)); r.on('error', bad);
        r.on('end', () => { const b = Buffer.concat(ch); b.length > 300 ? ok(b) : bad(new Error('tts empty')); });
      });
      rq.on('timeout', () => rq.destroy(new Error('tts timeout'))); rq.on('error', bad);
    });
  }
  function chunkText(s, max){            // الخدمة تقبل ~200 حرفا لكل طلب: نقسم عند علامة أو فراغ
    const out = []; let rest = String(s).trim();
    while(rest.length > max){ let i = Math.max(rest.lastIndexOf('،', max), rest.lastIndexOf('.', max), rest.lastIndexOf(' ', max)); if(i < 40) i = max; out.push(rest.slice(0, i + 1).trim()); rest = rest.slice(i + 1).trim(); }
    if(rest) out.push(rest); return out.filter(Boolean);
  }
  async function ttsSynth(segs){
    const bufs = [];
    for(const s of segs) for(const c of chunkText(s.t, 180)){
      if(!/[\p{L}\p{N}]/u.test(c)) continue;
      let b = null, err = null; for(let a = 0; a < 2 && !b; a++){ try{ b = await gttsGet(c, s.l); }catch(e){ err = e; } }
      if(!b) throw err || new Error('tts failed'); bufs.push(b);
    }
    if(!bufs.length) throw new Error('tts nothing to say'); return Buffer.concat(bufs);       // ملفات MP3 تُدمج بالتسلسل مباشرة
  }
  const ttsBusy = new Map();
  function ttsEnsure(plan){            // يضمن وجود الملف الصوتي (يولّده إن لزم) ← true/false
    const f = path.join(MEDIA_DIR, plan.id);
    if(store.media[plan.id] && fs.existsSync(f)) return Promise.resolve(true);
    if(ttsBusy.has(plan.id)) return ttsBusy.get(plan.id);
    const pr = (async () => {
      try{ const buf = await ttsSynth(plan.segs); fs.mkdirSync(MEDIA_DIR, { recursive: true }); fs.writeFileSync(f + '.part', buf); fs.renameSync(f + '.part', f);
        store.media[plan.id] = { type: 'audio', mime: 'audio/mpeg', ext: 'mp3', size: buf.length, ts: Date.now(), tts: 1, name: 'tts' }; save(); return true; }
      catch(e){ console.error('tts error:', e && e.message); return false; }
      finally{ ttsBusy.delete(plan.id); }
    })();
    ttsBusy.set(plan.id, pr); return pr;
  }
  async function seqEnsure(sp){            // يولّد نطق الاسم ويحفظ قائمة التشغيل ← true/false
    if(!(await ttsEnsure(sp.name))) return false;
    if(!store.playlists[sp.id]){ store.playlists[sp.id] = { parts: sp.parts, ts: Date.now() }; save(); }
    return true;
  }
  const ttsLinks = () => {            // رابط كل مشترك (للبرنامج الرئيسي): مسار نسبي لكل من «قبل الانتهاء» و«بعد الانتهاء»
    const c = ttsCfg(), o = {}; if(c.mode === 'off') return o;
    for(const [k, d] of members()){
      const f = kind => { if(c.mode === 'full') return '/m/media/' + ttsPlan(d, kind).id; const sp = seqPlan(d, kind); return sp ? '/m/p/' + sp.id : ''; };
      o[idOf(d)] = [f('soon'), f('expired')];
    }
    return o;
  };
  function ttsFind(id){ for(const [k, d] of members()) for(const kind of ['soon', 'expired']){ const pl = ttsPlan(d, kind); if(pl.id === id) return { plan: pl, kind }; } return null; }
  function seqFind(id){ for(const [k, d] of members()) for(const kind of ['soon', 'expired']){ const sp = seqPlan(d, kind); if(sp && sp.id === id) return sp; } return null; }
  async function voiceForP(d){            // الصوت الشخصي إن كان مفعّلا ونجح توليده، وإلا التسجيل العادي ← معرّف ملف، أو { id, parts } للدمج بالتتابع
    const c = ttsCfg(), kind = daysLeft(d.endDate) < 0 ? 'expired' : 'soon';
    if(c.mode === 'full'){ const pl = ttsPlan(d, kind); if(await ttsEnsure(pl)) return pl.id; }
    else if(c.mode === 'seq'){ const sp = seqPlan(d, kind); if(sp && await seqEnsure(sp)) return { id: sp.id, parts: sp.parts }; }
    return voiceFor(d);
  }
  const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function playerPage(parts){            // صفحة استماع تشغّل المقاطع تباعا (رابط واتساب)
    const gy = escH((store.gymInfo && store.gymInfo.name) || 'Smart Gym Manager');
    return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + gy + '</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0e0e10;color:#f5f5f5;font-family:system-ui,Segoe UI,Tahoma,sans-serif}main{width:min(92vw,420px);text-align:center;padding:26px;border-radius:20px;background:#18181b;border:1px solid #2c2c31}.ic{font-size:46px}h1{margin:8px 0 4px;font-size:22px;color:#f5c518}p{margin:0 0 18px;color:#a1a1aa}audio{width:100%}</style></head><body><main><div class="ic">🎧</div><h1>' + gy + '</h1><p>رسالة صوتية من القاعة — اضغط للاستماع</p><audio id="a" controls preload="auto"></audio></main><script>var P=' + JSON.stringify(parts.map(x => '/m/media/' + x)).replace(/</g, '\\u003c') + ',i=0,a=document.getElementById("a");a.src=P[0];a.addEventListener("ended",function(){i++;if(i<P.length){a.src=P[i];a.play();}else{i=0;a.src=P[0];}});</script></body></html>';
  }
  function remindBody(d){            // نص رسالة التذكير (ينتهي / انتهى حسب الحالة)
    const gy = (store.gymInfo && store.gymInfo.name) || 'Smart Gym Manager', dt = d.endDate.split('-').reverse().join('/');
    return 'مرحبا ' + (d.firstName + ' ' + (d.lastName || '')).trim() + '، هذا تذكير من القاعة الرياضية ' + gy + ' بخصوص اشتراكك الذي ' + (daysLeft(d.endDate) < 0 ? 'انتهى' : 'ينتهي') + ' بتاريخ ' + dt + '. مرحبا بكم وشكرا على ثقتكم 💪♥️';
  }
  let booted = true;            // أول فحص بعد تشغيل الخادم: يرسل فورا ما فاته أثناء الإغلاق
  async function tick(){
    const boot = booted; booted = false;            // تذكير مرة واحدة عند بقاء 3 أيام وعند انتهاء الاشتراك، في نفس ساعة اشتراك العضو
    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    const name = store.gymInfo.name || 'Smart Gym Manager';
    for(const [n, d] of members()){
      const dl = daysLeft(d.endDate); const exp = dl < 0 && dl >= -7;     // اشتراك انتهى: رسالة واحدة
      if(dl !== 3 && !exp) continue;            // فقط عند بقاء 3 أيام وعند انتهاء الاشتراك
      const ca = d.createdAt ? new Date(d.createdAt) : null, due = (ca && !isNaN(ca)) ? ca.getHours() * 60 + ca.getMinutes() : 9 * 60;   // وقت الاشتراك (أو 09:00 إن لم يُسجَّل)
      if(!boot && dl >= -1 && nowMin < due) continue;       // لا ترسل قبل ساعة الاشتراك
      const k = n + '|' + d.endDate + '|' + (exp ? 'exp' : dl); if(store.pushLog[k]) continue;
      if(dl === 3 || exp){                       // رسالة التذكير الكاملة قبل 3 أيام
        store.pushLog[k] = 1; save();
        await deliver(n, { title: name, body: remindBody(d) }, d.endDate, await voiceForP(d)); markReminded(n);
        continue;
      }
      const body = dl === 0 ? 'ينتهي اشتراكك اليوم' : dl === 1 ? 'ينتهي اشتراكك غدا' : 'بقيت 3 أيام على نهاية اشتراكك';
      store.pushLog[k] = 1; save();
      await deliver(n, { title: name, body: body + ' — لا تنس التجديد 💪' });
    }
  }
  setInterval(tick, 60 * 1000); setTimeout(tick, 20000);

  /* تفعيل الرابط العام (Tailscale Funnel) من صفحة الإدارة مباشرة */
  const IS_WIN = process.platform === 'win32';
  /* على أندرويد (Termux) يعمل tailscaled بوضع userspace ويُتحكَّم به عبر مقبس (socket) */
  const TS_SOCK = process.env.TS_SOCKET || '';
  function findTs(){
    if(IS_WIN){ const c = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean).map(p => path.join(p, 'Tailscale', 'tailscale.exe')); return c.find(p => fs.existsSync(p)) || null; }
    for(const d of String(process.env.PATH || '').split(':')){ if(!d) continue; const f = path.join(d, 'tailscale'); try{ if(fs.statSync(f).isFile()) return f; }catch(e){} }
    return null;
  }
  const tsArgs = a => TS_SOCK ? ['--socket=' + TS_SOCK].concat(a) : a;
  const runTs = (ts, args, cb) => execFile(ts, tsArgs(args), { timeout: 45000, windowsHide: true }, (err, so, se) => cb(err, ((so || '') + '\n' + (se || '')).trim()));
  const LOGIN_RE = /https:\/\/login\.tailscale\.com\/\S+/;
  let upProc = null, upLink = null;
  /* تسجيل الدخول إلى Tailscale (أندرويد): يشغّل «tailscale up» في الخلفية ويعيد رابط الدخول ليفتحه المستخدم مرة واحدة */
  function tsUp(ts, cb){
    if(upProc && upLink) return cb({ link: upLink });
    let out = '', done = false;
    const end = r => { if(!done){ done = true; cb(r); } };
    try{
      upProc = spawn(ts, tsArgs(['up', '--hostname=samgym']), { stdio: ['ignore', 'pipe', 'pipe'] });
    }catch(e){ return end({ error: String(e.message) }); }
    const on = d => { out += d; const m = out.match(LOGIN_RE); if(m){ upLink = m[0]; end({ link: upLink }); } };
    upProc.stdout.on('data', on); upProc.stderr.on('data', on);
    upProc.on('close', () => { upProc = null; upLink = null; end({ ok: 1 }); });
    upProc.on('error', e => { upProc = null; end({ error: String(e.message) }); });
    setTimeout(() => end({ ok: 1 }), 15000);
  }
  function tsState(ts, cb){
    runTs(ts, ['status', '--json'], (err, out) => {
      try{ const j = JSON.parse(out.slice(out.indexOf('{'))); return cb(null, j); }catch(e){ cb(err || e); }
    });
  }
  /* تطبيق أندرويد (APK): برنامج tsfunnel المرافق يدير Tailscale Funnel ويُتحكَّم به عبر HTTP محلي (TS_HELPER=http://127.0.0.1:3001) */
  const HELPER = process.env.TS_HELPER || '';
  function helperCall(method, pth, cb){
    const u = new URL(HELPER + pth);
    const rq = httpLocal.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, timeout: 5000 }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try{ cb(null, JSON.parse(b)); }catch(e){ cb(e); } });
    });
    rq.on('error', e => cb(e)); rq.on('timeout', () => { rq.destroy(); cb(new Error('timeout')); }); rq.end();
  }
  function helperFunnel(cb, opt){
    const t0 = Date.now(), maxMs = (opt && opt.quick) ? 1500 : 30000;
    const poll = () => helperCall('GET', '/status', (err, st) => {
      if(err || !st){ if(Date.now() - t0 < maxMs) return setTimeout(poll, 1500); return cb({ error: 'no_daemon', android: true }); }
      if(st.state === 'ready' && st.url){
        if((store.gymInfo || {}).url !== st.url){ store.gymInfo = Object.assign({}, store.gymInfo, { url: st.url }); save(); }
        return cb({ ok: 1, url: st.url });
      }
      if(st.state === 'login' && st.link) return cb({ error: 'login', link: st.link });
      if(st.state === 'funnel_error') return cb(st.link ? { error: 'enable', link: st.link } : { error: 'failed', text: st.text || 'تعذر تفعيل Funnel' });
      if(Date.now() - t0 < maxMs) return setTimeout(poll, 1500);
      cb({ error: 'failed', text: 'جارٍ تشغيل Tailscale… أعد المحاولة بعد لحظات (تأكد من اتصال الهاتف بالإنترنت).' });
    });
    if(opt && opt.retry) helperCall('POST', '/retry', () => setTimeout(poll, 800)); else poll();
  }
  function enableFunnel(cb, opt){
    if(HELPER) return helperFunnel(cb, { retry: !!(opt && opt.login), quick: !(opt && opt.login) });
    const ts = findTs(), port = String(Number(process.env.PORT) || 3000);
    if(!ts) return cb({ error: 'no_tailscale', android: !IS_WIN });
    const finish = (err, text) => {
      const link = (text.match(LOGIN_RE) || [])[0];
      if(/not enabled|visit:/i.test(text) && link) return cb({ error: 'enable', link });
      runTs(ts, ['status', '--json'], (e2, out) => {
        let url = null; try{ const j = JSON.parse(out.slice(out.indexOf('{'))), n = String((j.Self && j.Self.DNSName) || '').replace(/\.$/, ''); if(n) url = 'https://' + n; }catch(e){}
        if(!url) return cb({ error: 'failed', text: text || (err ? String(err.message) : '') });
        store.gymInfo = Object.assign({}, store.gymInfo, { url }); save(); cb({ ok: 1, url });
      });
    };
    const go = () => runTs(ts, ['funnel', '--bg', port], (err, text) => {
      if(IS_WIN && err && /access denied|permission|administrator|operator|elevat/i.test(text + String(err.message))){
        const cmd = "Start-Process -FilePath '" + ts + "' -ArgumentList 'funnel','--bg','" + port + "' -Verb RunAs -Wait -WindowStyle Hidden";
        return execFile('powershell', ['-NoProfile', '-Command', cmd], { timeout: 60000, windowsHide: true }, () => finish(null, ''));
      }
      finish(err, text);
    });
    if(IS_WIN) return go();
    // أندرويد: تأكد أن tailscaled يعمل ومسجَّل الدخول قبل تفعيل Funnel
    tsState(ts, (err, st) => {
      if(err || !st) return cb({ error: 'no_daemon', android: true });
      if(st.BackendState === 'Running') return go();
      if(!(opt && opt.login)) return cb({ error: 'login_needed' });
      tsUp(ts, r => {
        if(r.link) return cb({ error: 'login', link: r.link });
        if(r.error) return cb({ error: 'failed', text: r.error });
        go();
      });
    });
  }

  // الرابط العام تلقائيا عند تشغيل البرنامج (مرة واحدة) إن كان Tailscale مثبتا ولا يوجد رابط https
  [8000, 45000, 120000, 300000].forEach(delay => setTimeout(() => {
    try{
      if(!HELPER && !findTs()) return;
      if(/^https:/.test((store.gymInfo && store.gymInfo.url) || '')) return;
      enableFunnel(r => { if(r && r.url) console.log('الرابط العام: ' + r.url); });
    }catch(e){}
  }, delay));

  const PUB = path.join(__dirname, 'public', 'm'), CARDS = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'cards');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/manifest+json', '.png': 'image/png' };
  const PAGES = { '/m': 'index.html', '/m/': 'index.html', '/m/sw.js': 'sw.js', '/m/manifest.json': 'manifest.json', '/m/icon.png': 'icon.png', '/gym-admin': 'admin.html' };
  async function handle(req, res, p){
    if(req.method === 'GET' && p === '/m/manifest.json'){      // اسم التطبيق عند التثبيت = اسم القاعة
      try{ const mf = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.json'), 'utf8')), nm = String((store.gymInfo && store.gymInfo.name) || '').trim() || 'Smart Gym Manager';
        mf.name = nm; mf.short_name = nm.slice(0, 12); if(store.gymLogo){ const v = '?v=' + (store.logoV || 1); mf.icons = mf.icons.map(i => Object.assign({}, i, { src: i.src + v })); } res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(mf)); }
      catch(e){ res.writeHead(404); res.end(); }
      return true;
    }
    if(req.method === 'GET' && p === '/m/icon.png' && store.gymLogo){     // شعار القاعة (يستبدل الأيقونة الافتراضية)
      try{ const m = /^data:image\/png;base64,(.+)$/s.exec(store.gymLogo); if(m){ res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); res.end(Buffer.from(m[1], 'base64')); return true; } }catch(e){}
    }
    const pm0 = req.method === 'GET' && /^\/m\/p\/([0-9a-f]{24})$/.exec(p);       // صفحة تشغيل المقاطع بالتتابع
    if(pm0){
      let parts = store.playlists[pm0[1]] && store.playlists[pm0[1]].parts;
      if(!parts){ const sp = ttsCfg().mode === 'seq' ? seqFind(pm0[1]) : null;
        if(sp){ if(await seqEnsure(sp)) parts = sp.parts; else { const fb = cleanVoice(store.gymInfo && store.gymInfo.voice)[sp.kind]; parts = fb ? [fb] : sp.parts.filter(x => x !== sp.name.id); } } }
      parts = (parts || []).filter(x => store.media[x] && fs.existsSync(path.join(MEDIA_DIR, x)));
      if(!parts.length){ res.writeHead(404); res.end('not found'); return true; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(playerPage(parts)); return true;
    }
    const mm0 = (req.method === 'GET' || req.method === 'HEAD') && /^\/m\/media\/([0-9a-f]{24})$/.exec(p);       // صور/فيديو/صوت الأقسام — رابط عشوائي غير قابل للتخمين
    if(mm0){
      let id = mm0[1], nc = false;
      if(!(store.media[id] && fs.existsSync(path.join(MEDIA_DIR, id)))){            // رابط تسجيل شخصي لم يُولَّد بعد: يُولَّد عند أول فتح، وعند الفشل يُقدَّم التسجيل العادي
        const f = ttsCfg().mode === 'full' ? ttsFind(id) : null;
        if(f && !(await ttsEnsure(f.plan))){ const fb = cleanVoice(store.gymInfo && store.gymInfo.voice)[f.kind]; if(fb){ id = fb; nc = true; } }
      }
      serveMedia(req, res, id, nc); return true;
    }
    const cm = req.method === 'GET' && /^\/m\/card\/([0-9a-f]{24})(\.png)?$/.exec(p);   // بطاقة المشترك (صورة) — رابط عشوائي غير قابل للتخمين
    if(cm){
      const f = path.join(CARDS, cm[1] + '.png');
      if(!fs.existsSync(f)){ res.writeHead(404); res.end('not found'); return true; }
      if(cm[2]){ res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); res.end(fs.readFileSync(f)); return true; }
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || ''), pr = req.headers['x-forwarded-proto'] || (/\.ts\.net$/.test(host.split(':')[0]) ? 'https' : 'http');
      const img = pr + '://' + host + '/m/card/' + cm[1] + '.png', nm = String((store.gymInfo && store.gymInfo.name) || '').trim() || 'Smart Gym Manager';
      const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + nm.replace(/[<&>"]/g, '') + ' — بطاقة المشترك</title>'
        + '<meta property="og:type" content="website"><meta property="og:title" content="' + nm.replace(/[<&>"]/g, '') + ' — بطاقة المشترك"><meta property="og:description" content="احفظ البطاقة واعرض الـ QR عند الحاجة."><meta property="og:image" content="' + img + '"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="800"><meta property="og:image:height" content="1270">'
        + '<style>body{margin:0;background:#0c0f13;display:grid;place-items:center;min-height:100vh;font-family:sans-serif}img{max-width:100%;max-height:100vh;display:block}a{color:#ff7a1a;margin:14px}</style></head><body><div style="text-align:center"><img src="' + img + '" alt=""><a href="' + img + '" download="card.png">تحميل البطاقة</a></div></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }); res.end(html); return true;
    }
    if(req.method === 'GET' && PAGES[p]){
      try{ const f = PAGES[p]; res.writeHead(200, { 'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); res.end(fs.readFileSync(path.join(PUB, f))); }
      catch(e){ res.writeHead(404); res.end(); }
      return true;
    }
    if(!p.startsWith('/api/m/')) return false;
    if(p === '/api/m/login' && req.method === 'POST'){
      const b = await readBody(req), key = clientIp(req) + '|m' + (b.key || l9(b.phone));
      let n = keyFromBody(b);
      if(!b.key && l9(b.phone).length >= 9){ const mm = members(), c = String(b.code || '').trim(); for(const [k, d] of mm){ if(l9(d.phone) === l9(b.phone) && codeOf(k) === c){ n = k; break; } } }
      if(throttled(key)) return send(req, res, 429, { error: 'too_many' }), true;
      if(!n || !members().has(n) || String(b.code || '').trim() !== codeOf(n)){ noteFail(key); return send(req, res, 401, { error: 'bad_credentials' }), true; }
      return send(req, res, 200, { token: sign('m' + n, Date.now() + 90 * 864e5) }), true;
    }
    if(p === '/api/m/public' && req.method === 'GET') return send(req, res, 200, { name: (store.gymInfo && store.gymInfo.name) || 'Smart Gym Manager', today: todayISO() }), true;
    const n = who(req);
    if(n){
      const d = members().get(n);
      if(!d) return send(req, res, 401, { error: 'unauthorized' }), true;
      if(p === '/api/m/me') return send(req, res, 200, { key: n, name: d.firstName + ' ' + (d.lastName || ''), startDate: d.startDate, endDate: d.endDate, plan: planName(d), plans: plansList(), photo: photoOf(d), pay: payInfo(d), phoneTail: l9(d.phone).slice(-4), daysLeft: daysLeft(d.endDate), today: todayISO(), feedback: store.fbOn !== false, info: infoOut(), sections: secOut(n), chat: { on: !!CH.on }, vapid: store.vapid && store.vapid.publicKey, push: !!store.push[n], pushOff: !!store.pushOff[n], profile: store.profiles[n] || null, pfields: store.pfields, inbox: (store.inbox[n] || []).slice(-20).reverse(), unread: (store.inbox[n] || []).filter(x => !x.read).length }), true;
      if(p === '/api/m/feedback' && req.method === 'POST'){        // رأي المشترك
        if(store.fbOn === false) return send(req, res, 403, { error: 'disabled' }), true;
        const b = await readBody(req), text = String(b.text || '').trim().slice(0, 1000), rating = Math.max(0, Math.min(5, Math.round(Number(b.rating) || 0)));
        if(!text && !rating) return send(req, res, 400, { error: 'empty' }), true;
        if(store.feedback.filter(f => f.n === n && f.ts > Date.now() - 864e5).length >= 2) return send(req, res, 429, { error: 'too_many' }), true;
        store.feedback.push({ id: crypto.randomBytes(6).toString('hex'), n, name: (d.firstName + ' ' + (d.lastName || '')).trim(), phone: d.phone, text, rating, ts: Date.now(), read: false });
        if(store.feedback.length > 2000) store.feedback.splice(0, store.feedback.length - 2000);
        save(); return send(req, res, 200, { ok: 1 }), true;
      }
      if(p === '/api/m/code' && req.method === 'POST'){            // المشترك يغيّر رمز دخوله
        const b = await readBody(req), c = String(b.code || '').trim();
        if(!/^\d{4}$/.test(c)) return send(req, res, 400, { error: 'bad_code' }), true;
        store.mcodes[n] = c; save(); return send(req, res, 200, { ok: 1 }), true;
      }
      if(p === '/api/m/profile' && req.method === 'POST'){            // المشترك يسجّل معلوماته الشخصية
        const b = await readBody(req), o = cleanProfile(b || {});
        if(profEmpty(o)){ delete store.profiles[n]; save(); return send(req, res, 200, { ok: 1, profile: null }), true; }
        store.profiles[n] = o; save(); return send(req, res, 200, { ok: 1, profile: o }), true;
      }
      if(p === '/api/m/chat'){
        if(!CH.on) return send(req, res, 200, { on: false }), true;
        if(req.method === 'GET'){ const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0; return send(req, res, 200, { on: true, seq: CH.seq, muted: !!CH.muted[n], msgs: chatList(since, n) }), true; }
        if(req.method === 'POST'){
          if(CH.muted[n]) return send(req, res, 403, { error: 'muted' }), true;
          const b = await readBody(req), text = String(b.text || '').trim().slice(0, 500), cid = /^[A-Za-z0-9_-]{4,40}$/.test(String(b.cid || '')) ? String(b.cid) : '';
          if(!text) return send(req, res, 400, { error: 'empty' }), true;
          if(cid){ const ex = CH.msgs.find(x => x.n === n && x.cid === cid); if(ex) return send(req, res, 200, { ok: 1, msg: chatPub(ex, n) }), true; }   // رسالة أُرسلت من قبل (طابور بلا اتصال): لا تتكرر
          if(Date.now() - (chatLast[n] || 0) < 1200) return send(req, res, 429, { error: 'too_fast' }), true;
          chatLast[n] = Date.now();
          const m = { id: crypto.randomBytes(6).toString('hex'), n, name: (d.firstName + ' ' + (d.lastName || '')).trim(), text, ts: Date.now() };
          if(cid) m.cid = cid;
          chatAdd(m); chatPush(m); return send(req, res, 200, { ok: 1, msg: chatPub(m, n) }), true;
        }
        if(req.method === 'DELETE'){            // المشترك يحذف رسالته فقط
          const id = new URL(req.url, 'http://x').searchParams.get('id'), m = CH.msgs.find(x => x.id === id && x.n === n && !x.del);
          if(m){ m.del = true; m.text = ''; m.seq = ++CH.seq; save(); }
          return send(req, res, 200, { ok: 1 }), true;
        }
      }
      if(p === '/api/m/react' && req.method === 'POST'){            // تفاعل المشترك مع منشور (قسم): تفاعل واحد لكل مشترك، وإعادة الضغط تلغيه
        const b = await readBody(req), sec = store.sections.find(x => x.id === String(b.sec || ''));
        if(!sec || sec.react === false) return send(req, res, 404, { error: 'not_found' }), true;
        const r = store.reacts[sec.id] = store.reacts[sec.id] || {}, e = String(b.emoji || '');
        if(!e || !REACTS.includes(e) || r[n] === e) delete r[n]; else r[n] = e;
        save(); return send(req, res, 200, { ok: 1, sections: secOut(n) }), true;
      }
      if(p === '/api/m/push' && req.method === 'POST'){ const b = await readBody(req); if(b.off){ delete store.push[n]; store.pushOff[n] = 1; save(); } else if(b.sub && b.sub.endpoint){ store.push[n] = b.sub; delete store.pushOff[n]; save(); } return send(req, res, 200, { ok: 1 }), true; }
      if(p === '/api/m/inbox' && req.method === 'POST'){ (store.inbox[n] || []).forEach(x => { if(!x.read){ x.read = true; x.readAt = Date.now(); } }); save(); return send(req, res, 200, { ok: 1 }), true; }
      if(p === '/api/m/test' && req.method === 'POST'){ const ok = await notify(n, { title: store.gymInfo.name || 'Smart Gym Manager', body: 'تم تفعيل الإشعارات ✅' }); return send(req, res, 200, { ok, err: ok ? '' : lastPushErr }), true; }
    }
    const u = verifyToken(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if(u && can(u, 'settings') && p === '/api/m/name' && req.method === 'PUT'){   // تغيير اسم البرنامج من الإعدادات
      const b = await readBody(req); store.gymInfo = Object.assign({}, store.gymInfo, { name: String(b.name || '').trim().slice(0, 60) }); save();
      try{ process.emit('samgym-name', store.gymInfo.name); }catch(e){}      // يلتقطها main.js: يعيد تسمية الملف والاختصار
      return send(req, res, 200, { ok: 1 }), true;
    }
    if(u && (can(u, 'settings') || can(u, 'members_app')) && p === '/api/m/logo'){                         // رفع/حذف شعار القاعة
      if(req.method === 'PUT'){
        const b = await readBody(req), s = String(b.logo || '');
        if(!/^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(s) || s.length > 3e6) return send(req, res, 400, { error: 'bad_image' }), true;
        store.gymLogo = s; store.logoV = Date.now(); save(); return send(req, res, 200, { ok: 1, v: store.logoV }), true;
      }
      if(req.method === 'DELETE'){ delete store.gymLogo; store.logoV = Date.now(); save(); return send(req, res, 200, { ok: 1 }), true; }
    }
    if(u && (can(u, 'settings') || can(u, 'members_app')) && p === '/api/m/pfields' && req.method === 'PUT'){          // تعديل خانات المعلومات الشخصية
      const b = await readBody(req), fl = cleanFields(b.fields);
      store.pfields = fl; save(); return send(req, res, 200, { ok: 1, pfields: fl }), true;
    }
    if(u && (can(u, 'send_reminders') || can(u, 'members_app') || can(u, 'members')) && p === '/api/m/card' && req.method === 'POST'){     // رفع بطاقة المشترك لتُرسل كرابط بمعاينة صورة في واتساب
      const b = await readBody(req), m = /^data:image\/png;base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.png || ''));
      if(!m || m[1].length > 4e6) return send(req, res, 400, { error: 'bad_image' }), true;
      try{
        fs.mkdirSync(CARDS, { recursive: true });
        const id = crypto.randomBytes(12).toString('hex');
        fs.writeFileSync(path.join(CARDS, id + '.png'), Buffer.from(m[1], 'base64'));
        const old = Date.now() - 60 * 864e5; fs.readdirSync(CARDS).forEach(f => { try{ const fp = path.join(CARDS, f); if(fs.statSync(fp).mtimeMs < old) fs.unlinkSync(fp); }catch(e){} });
        return send(req, res, 200, { ok: 1, id }), true;
      }catch(e){ return send(req, res, 500, { error: 'save_failed' }), true; }
    }
    if(u && (can(u, 'send_reminders') || can(u, 'members_app')) && p === '/api/m/voice' && req.method === 'GET'){          // روابط التسجيل الصوتي لرسالة واتساب
      const v = cleanVoice(store.gymInfo && store.gymInfo.voice), base = String((store.gymInfo && store.gymInfo.url) || '').trim().replace(/\/+$/, '');
      const tt = ttsCfg();
      return send(req, res, 200, { base: /^https:\/\//i.test(base) ? base : '', soon: v.soon, expired: v.expired, tts: tt.mode !== 'off', links: ttsLinks() }), true;
    }
    if(u && can(u, 'members_app') && p === '/api/m/voice-test' && req.method === 'POST'){          // تجربة الصوت الشخصي باسم من اختيارك
      const b = await readBody(req), kind = b.kind === 'expired' ? 'expired' : 'soon', nm = String(b.name || '').trim().slice(0, 60) || 'يمان';
      const t = new Date(); t.setDate(t.getDate() + (kind === 'expired' ? -2 : 3));
      const dd = { firstName: nm, lastName: '', endDate: t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) };
      if(b.mode === 'seq'){
        const sp = seqPlan(dd, kind, { pre: audioOk(b.pre) ? b.pre : '', post: audioOk(b.post) ? b.post : '', seqName: 'full' });
        if(!sp) return send(req, res, 400, { error: 'no_recordings' }), true;
        return (await ttsEnsure(sp.name)) ? send(req, res, 200, { ok: 1, parts: sp.parts, said: sp.said }) : send(req, res, 502, { error: 'tts_failed' }), true;
      }
      const pl = ttsPlan(dd, kind, b.tpl ? String(b.tpl).replace(/\s+/g, ' ').trim().slice(0, 400) : null);
      return (await ttsEnsure(pl)) ? send(req, res, 200, { ok: 1, parts: [pl.id], said: pl.said }) : send(req, res, 502, { error: 'tts_failed' }), true;
    }
    if(u && (can(u, 'send_reminders') || can(u, 'members_app')) && p === '/api/m/remind' && req.method === 'POST'){          // تذكير يدوي عبر التطبيق
      const b = await readBody(req), k = keyFromBody(b), d = k ? members().get(k) : null;
      if(!d) return send(req, res, 404, { error: 'not_found' }), true;
      if((d.appNotifiedAt || remMsg(k, d)) && !canRe(k, d)) return send(req, res, 200, { ok: 1, already: 1 }), true;            // لا تذكير ثان إلا إن لم تُقرأ الرسالة بعد يوم كامل
      const r = await deliver(k, { title: (store.gymInfo && store.gymInfo.name) || 'Smart Gym Manager', body: remindBody(d) }, d.endDate, await voiceForP(d));
      markReminded(k);
      return send(req, res, 200, { ok: 1, push: r.push ? 1 : 0, reason: r.push ? '' : 'inbox_only' }), true;
    }
    if(u && can(u, 'members_app') && p === '/api/m/funnel' && req.method === 'POST'){
      const r = await new Promise(ok => enableFunnel(ok, { login: true })); return send(req, res, 200, r), true;
    }
    if(u && can(u, 'members_app')){
      if(p === '/api/m/admin') return send(req, res, 200, { today: todayISO(), pfields: store.pfields, fbOn: store.fbOn !== false, fbUnread: store.feedback.filter(f => !f.read).length, info: store.gymInfo, sections: secOut(''), logo: !!store.gymLogo, lan: lan(), list: [...members()].map(([k, d]) => ({ key: k, name: (d.firstName + ' ' + (d.lastName || '')).trim(), phone: l9(d.phone).length >= 9 ? d.phone : '', rawPhone: d.phone || '', endDate: d.endDate, startDate: d.startDate, plan: planName(d), daysLeft: daysLeft(d.endDate), code: codeOf(k), push: !!store.push[k], reminded: !!d.appNotifiedAt || !!remMsg(k, d), seen: !!(remMsg(k, d) && remMsg(k, d).read), canRe: canRe(k, d), remTs: (remMsg(k, d) && remMsg(k, d).ts) || 0, seenAt: (remMsg(k, d) && remMsg(k, d).readAt) || 0, pay: payInfo(d), prof: store.profiles[k] || null, hasPhoto: !!photoOf(d), pv: photoOf(d).length + ':' + photoOf(d).slice(-24) })).sort((a, b) => a.daysLeft - b.daysLeft) }), true;
      if(p === '/api/m/feedback' && req.method === 'GET') return send(req, res, 200, { on: store.fbOn !== false, list: store.feedback.slice().reverse() }), true;
      if(p === '/api/m/feedback' && req.method === 'PUT'){
        const b = await readBody(req);
        if(b.on !== undefined) store.fbOn = !!b.on;
        if(b.readAll) store.feedback.forEach(f => f.read = true);
        save(); return send(req, res, 200, { ok: 1, on: store.fbOn !== false }), true;
      }
      if(p === '/api/m/chat/admin'){
        if(req.method === 'GET') return send(req, res, 200, { on: !!CH.on, notif: !!CH.notif, seq: CH.seq, muted: CH.muted, msgs: CH.msgs.filter(m => !m.del).slice(-200).map(m => Object.assign(chatPub(m, ''), { n: m.n })) }), true;
        if(req.method === 'POST'){            // المدير ينشر في الدردشة
          const b = await readBody(req), text = String(b.text || '').trim().slice(0, 500);
          if(!text) return send(req, res, 400, { error: 'empty' }), true;
          const m = { id: crypto.randomBytes(6).toString('hex'), n: 'admin', name: 'الإدارة', text, ts: Date.now(), admin: true };
          chatAdd(m); chatPush(m); return send(req, res, 200, { ok: 1 }), true;
        }
        if(req.method === 'DELETE'){
          const q = new URL(req.url, 'http://x').searchParams;
          if(q.get('all')) CH.msgs.forEach(m => { if(!m.del){ m.del = true; m.text = ''; m.seq = ++CH.seq; } });
          else { const m = CH.msgs.find(x => x.id === q.get('id') && !x.del); if(m){ m.del = true; m.text = ''; m.seq = ++CH.seq; } }
          save(); return send(req, res, 200, { ok: 1 }), true;
        }
      }
      if(p === '/api/m/chat/settings' && req.method === 'PUT'){
        const b = await readBody(req); if(b.on !== undefined) CH.on = !!b.on; if(b.notif !== undefined) CH.notif = !!b.notif;
        save(); return send(req, res, 200, { ok: 1, on: CH.on, notif: CH.notif }), true;
      }
      if(p === '/api/m/chat/mute' && req.method === 'POST'){            // كتم مشترك (لا يستطيع الكتابة) أو إلغاء الكتم
        const b = await readBody(req), k = String(b.n || '');
        if(!k || k === 'admin') return send(req, res, 400, { error: 'invalid' }), true;
        if(b.mute){ const last = CH.msgs.slice().reverse().find(x => x.n === k); CH.muted[k] = (last && last.name) || String(b.name || k).slice(0, 60); } else delete CH.muted[k];
        save(); return send(req, res, 200, { ok: 1, muted: CH.muted }), true;
      }
      if(p === '/api/m/feedback/reply' && req.method === 'POST'){        // رد المدير على ملاحظة مشترك: يصله في «الرسائل» ويُرسل كإشعار
        const b = await readBody(req), f = store.feedback.find(x => x.id === String(b.id || '')), text = String(b.text || '').trim().slice(0, 1000);
        if(!f || !text) return send(req, res, 400, { error: 'invalid' }), true;
        f.reply = text; f.replyTs = Date.now(); f.read = true;
        const nm = (store.gymInfo && store.gymInfo.name) || 'Smart Gym Manager';
        const r = await deliver(f.n, { title: nm + ' — ردّ على ملاحظتك', body: 'ردّ القاعة على ملاحظتك: ' + text + (f.text ? '\n\n↩ ملاحظتك: ' + f.text.slice(0, 120) : '') });
        return send(req, res, 200, { ok: 1, reply: f.reply, replyTs: f.replyTs, push: r.push ? 1 : 0 }), true;
      }
      if(p === '/api/m/feedback' && req.method === 'DELETE'){
        const id = new URL(req.url, 'http://x').searchParams.get('id'); store.feedback = store.feedback.filter(f => f.id !== id); save();
        return send(req, res, 200, { ok: 1 }), true;
      }
      if(p === '/api/m/photo' && req.method === 'GET'){            // صورة المشترك لصفحة الإدارة
        const k = new URL(req.url, 'http://x').searchParams.get('key') || '', d = members().get(k), ph = d ? photoOf(d) : '';
        const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(ph);
        if(!m){ res.writeHead(404); res.end(); return true; }
        res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=300' }); res.end(Buffer.from(m[2], 'base64')); return true;
      }
      if(p === '/api/m/qr'){
        const t = new URL(req.url, 'http://x').searchParams.get('text') || '';
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); res.end(qrSvg(t)); return true;
      }
      if(p === '/api/m/info' && req.method === 'PUT'){
        const b = await readBody(req), o = Object.assign({}, store.gymInfo);
        for(const k of ['name', 'maps', 'url']) if(b[k] !== undefined) o[k] = String(b[k] || '').slice(0, 5000);
        for(const k of ['tagline', 'address', 'phone', 'whatsapp', 'instagram', 'facebook', 'tiktok']) if(b[k] !== undefined) o[k] = String(b[k] || '').trim().slice(0, k === 'address' || k === 'tagline' ? 200 : 300);
        if(b.theme !== undefined){ const th = {}, H = /^#[0-9a-f]{6}$/i; if(b.theme && typeof b.theme === 'object') for(const k of ['bg', 'sf', 'sf2', 'ln', 'tx', 'mut', 'ac', 'ac2', 'acx']) if(H.test(String(b.theme[k] || ''))) th[k] = String(b.theme[k]); o.theme = Object.keys(th).length ? th : null; }
        if(b.schedule !== undefined) o.schedule = b.schedule ? cleanSchedule(b.schedule) : null;
        if(b.voice !== undefined) o.voice = cleanVoice(b.voice);
        if(b.tts !== undefined) o.tts = cleanTts(b.tts);
        store.gymInfo = o; save(); return send(req, res, 200, { ok: 1 }), true;
      }
      if(p === '/api/m/sections' && req.method === 'PUT'){            // حفظ الأقسام (إضافة / حذف / ترتيب / نصوص / ملفات)
        const b = await readBody(req); store.sections = cleanSections(b.sections); for(const k of Object.keys(store.reacts)) if(!store.sections.some(x => x.id === k)) delete store.reacts[k]; save(); gcMedia();
        return send(req, res, 200, { ok: 1, sections: secOut('') }), true;
      }
      if(p === '/api/m/media' && req.method === 'POST'){ upload(req, res); return true;
      }
    }
    return send(req, res, 401, { error: 'unauthorized' }), true;
  }
  return { handle };
};
