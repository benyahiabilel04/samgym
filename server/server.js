'use strict';
/* Smart Gym Manager server — zero dependencies (Node 18+).
   Stores everything in one JSON file (DATA_DIR/store.json) with daily backups.
   Serves the app (public/index.html) and a small API: login, users, sync. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BODY = 80 * 1024 * 1024;        // photos are base64 inside members
const PAGE_BYTES = 4 * 1024 * 1024;       // max size of one sync response page
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ---------------- storage ---------------- */
function fresh(){ return { secret: crypto.randomBytes(32).toString('hex'), seq: 0, users: [], items: {}, docs: {} }; }
function load(){
  if(!fs.existsSync(FILE)) return fresh();
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch(e){
    const bad = FILE + '.corrupt-' + Date.now();
    fs.copyFileSync(FILE, bad);
    console.error('store.json unreadable, copied to', bad);
    throw e;                              // never silently start empty over real data
  }
}
const store = load();
let saveTimer = null, dirty = false;
function writeStore(){
  try{
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, FILE);
  }catch(e){ dirty = true; console.error('save failed (will retry):', e.message); setTimeout(()=>{ if(dirty){ dirty = false; writeStore(); } }, 5000); }
}
function save(){
  dirty = true;
  if(saveTimer) return;
  saveTimer = setTimeout(()=>{
    saveTimer = null; if(!dirty) return; dirty = false;
    writeStore();
  }, 300);
}
function dailyBackup(){
  try{
    if(!fs.existsSync(FILE)) return;
    const d = new Date().toISOString().slice(0,10);
    const dest = path.join(BACKUP_DIR, 'store-' + d + '.json');
    if(!fs.existsSync(dest)) fs.copyFileSync(FILE, dest);
    const files = fs.readdirSync(BACKUP_DIR).filter(f=>/^store-.*\.json$/.test(f)).sort();
    while(files.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }catch(e){ console.error('backup failed', e.message); }
}
dailyBackup(); setInterval(dailyBackup, 6 * 3600 * 1000);
function flushNow(){ if(dirty){ dirty = false; clearTimeout(saveTimer); saveTimer = null; writeStore(); } }
process.on('SIGTERM', ()=>{ flushNow(); process.exit(0); });
process.on('SIGINT', ()=>{ flushNow(); process.exit(0); });

/* ---------------- auth ---------------- */
const ROLES = ['owner', 'reception'];
function hashPw(pw, salt){ return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function makeUser(username, password, role){
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomBytes(6).toString('hex'), username, role, salt, hash: hashPw(password, salt), active: true, createdAt: Date.now() };
}
function checkPw(u, pw){
  const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sign(uid, exp){
  const p = uid + '.' + exp;
  return p + '.' + crypto.createHmac('sha256', store.secret).update(p).digest('base64url');
}
function verifyToken(tok){
  const parts = String(tok || '').split('.');
  if(parts.length !== 3) return null;
  const good = sign(parts[0], parts[1]);
  const a = Buffer.from(good), b = Buffer.from(String(tok));
  if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if(Number(parts[1]) < Date.now()) return null;
  const u = store.users.find(x=>x.id === parts[0]);
  return (u && u.active) ? u : null;
}
function newToken(u){ return sign(u.id, Date.now() + 30 * 24 * 3600 * 1000); }
/* Per-user permissions (owner always has all). Enforced by the server where the data allows it:
   add_members, renew_members, edit_members, delete_members, send_reminders, expenses, diet.
   view_finance is enforced in the UI only (totals are computed from members in the browser). */
const PERMS = ['add_members', 'renew_members', 'edit_members', 'delete_members', 'send_reminders', 'view_finance', 'expenses', 'diet',
  'settings', 'export_data', 'import_data', 'backups', 'plans', 'security', 'members_app'];
const DEFAULT_RECEPTION = ['add_members', 'renew_members', 'send_reminders'];
/* migration: before these permissions existed, every reception user could add / renew / send reminders.
   Keep that behaviour for existing accounts (the owner can now switch each one off). */
(function migratePerms(){
  let changed = false;
  for(const u of store.users){
    if(u.role !== 'reception') continue;
    u.perms = u.perms || {};
    for(const k of DEFAULT_RECEPTION) if(u.perms[k] === undefined){ u.perms[k] = true; changed = true; }
  }
  if(changed) setTimeout(()=>{ try{ writeStore(); }catch(e){} }, 0);
})();
/* the three basic permissions are ON by default for reception accounts (until the owner switches them off) */
function defaultOn(role, k){ return role !== 'owner' && DEFAULT_RECEPTION.includes(k); }
function cleanPerms(p, role){ const o = {}; for(const k of PERMS) o[k] = (p && p[k] !== undefined) ? !!p[k] : defaultOn(role, k); return o; }
function can(u, perm){
  if(u.role === 'owner') return true;
  const v = u.perms ? u.perms[perm] : undefined;
  return v === undefined ? defaultOn(u.role, perm) : !!v;
}
function effPerms(u){ const o = {}; for(const k of PERMS) o[k] = can(u, k); return o; }
function publicUser(u){ return { id: u.id, username: u.username, role: u.role, active: u.active, perms: effPerms(u), rawPerms: cleanPerms(u.perms, u.role) }; }
const fails = new Map();
function throttled(key){ const f = fails.get(key); return f && f.until > Date.now(); }
function noteFail(key){ const f = fails.get(key) || { n: 0, until: 0 }; f.n++; if(f.n >= 8){ f.until = Date.now() + 10 * 60 * 1000; f.n = 0; } fails.set(key, f); }

/* ---------------- permissions ---------------- */
const COLL = {
  members:  { read: u=>true,                  write: u=>true,                  del: u=>can(u, 'delete_members') },
  expenses: { read: u=>can(u, 'expenses'),    write: u=>can(u, 'expenses'),    del: u=>can(u, 'expenses') },
  diet:     { read: u=>true,                  write: u=>can(u, 'diet'),        del: u=>can(u, 'diet') }
};
const DOCS = { plans: { read: u=>true, write: u=>can(u, 'plans') } };

/* ---- what permission does a member write need? (server-side, so it cannot be bypassed from the browser) ----
   - brand-new record that is a renewal of an existing member (renewOf + same name/phone) -> renew_members
   - any other brand-new record                                                           -> add_members
   - existing record: only reminder flag changed -> send_reminders; only renewal flag changed -> renew_members;
     any other field changed (name, phone, plan, dates, amounts, photo...)               -> edit_members */
const FLAG_PERM = { notifiedAt: 'send_reminders', appNotifiedAt: 'app_remind', renewed: 'renew_members', renewedAt: 'renew_members' };
function membersById(){
  const m = new Map();
  for(const k in store.items){ const r = store.items[k]; if(r.c === 'members' && !r.del && r.data) m.set(r.id, r.data); }
  return m;
}
function memberNeeds(prev, next, byId){
  next = next || {};
  if(!prev){
    const src = next.renewOf ? byId.get(String(next.renewOf)) : null;
    if(src && src.firstName === next.firstName && src.lastName === next.lastName && src.phone === next.phone) return ['renew_members'];
    return ['add_members'];
  }
  const need = new Set();
  for(const k of new Set([...Object.keys(prev), ...Object.keys(next)])){
    if(k === 'renewOf') continue;
    if(JSON.stringify(prev[k]) === JSON.stringify(next[k])) continue;
    need.add(FLAG_PERM[k] || 'edit_members');
  }
  return [...need];
}

/* ---------------- sync ---------------- */
function doSync(user, body){
  const role = user.role, since = Number(body.since) || 0, init = !!body.init;
  const rejected = [], force = [];
  const incoming = Array.isArray(body.items) ? body.items : [];
  const byId = membersById();                                   // snapshot before this batch is applied
  const reCreated = new Set(incoming.filter(x=>x && x.c === 'members' && !x.del && typeof x.id === 'string').map(x=>x.id));
  for(const it of incoming){
    if(!it || typeof it.c !== 'string' || typeof it.g !== 'string' || typeof it.id !== 'string') continue;
    const rule = COLL[it.c];
    if(!rule || it.g.length > 30 || it.id.length > 100) continue;
    const key = it.c + '|' + it.g + '|' + it.id;
    const del = !!it.del;
    if(!rule.write(user)){ rejected.push(key); continue; }
    if(del && !rule.del(user)){
      // moving a member to another month = delete in old month + create in new month: allowed with edit_members
      const isMove = it.c === 'members' && reCreated.has(it.id) && can(user, 'edit_members');
      if(!isMove){ rejected.push(key); continue; }
    }
    if(it.c === 'members' && !del){
      const needs = memberNeeds(byId.get(it.id) || null, it.data, byId);
      if(needs.some(p=>!(p === 'app_remind' ? (can(user, 'send_reminders') || can(user, 'members_app')) : can(user, p)))){ rejected.push(key); continue; }
    }
    const ts = Number(it.ts) || Date.now();
    const cur = store.items[key];
    if(init ? cur : (cur && ts <= cur.ts)){ if(cur) force.push(cur); continue; }
    store.items[key] = { c: it.c, g: it.g, id: it.id, ts, del, data: del ? null : it.data, seq: ++store.seq };
  }
  const docsOut = {};
  for(const name of Object.keys(body.docs || {})){
    const rule = DOCS[name], d = body.docs[name];
    if(!rule || !d) continue;
    if(!rule.write(user)){ rejected.push('doc|' + name); continue; }
    const ts = Number(d.ts) || Date.now(), cur = store.docs[name];
    if(init ? cur : (cur && ts <= cur.ts)) continue;
    store.docs[name] = { ts, data: d.data, seq: ++store.seq };
  }
  save();

  // build one page of changes after `since`
  const all = [];
  for(const k in store.items){ const r = store.items[k]; if(r.seq > since && COLL[r.c].read(user)) all.push(r); }
  all.sort((a, b)=>a.seq - b.seq);
  const out = [], seen = new Set();
  let bytes = 0, more = false, lastSeq = since;
  for(const r of all){
    const sz = r.data ? JSON.stringify(r.data).length : 50;
    if(out.length && bytes + sz > PAGE_BYTES){ more = true; break; }
    out.push(r); seen.add(r.c + '|' + r.g + '|' + r.id); bytes += sz; lastSeq = r.seq;
  }
  for(const r of force){ const k = r.c + '|' + r.g + '|' + r.id; if(!seen.has(k) && COLL[r.c].read(user)) out.push(r); }
  if(!more) for(const name in store.docs){ const d = store.docs[name]; if(d.seq > since && DOCS[name].read(user)) docsOut[name] = { ts: d.ts, data: d.data }; }
  return { now: Date.now(), cursor: more ? lastSeq : store.seq, more, items: out, docs: docsOut, rejected, role, user: publicUser(user) };
}

/* ---------------- http ---------------- */
function send(req, res, code, obj){
  const body = Buffer.from(JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if(body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')){
    h['Content-Encoding'] = 'gzip';
    res.writeHead(code, h); res.end(zlib.gzipSync(body)); return;
  }
  res.writeHead(code, h); res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject)=>{
    let size = 0; const chunks = [];
    req.on('data', c=>{ size += c.length; if(size > MAX_BODY){ reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', ()=>{ try{ resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }catch(e){ reject(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', reject);
  });
}
function clientIp(req){ return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function validName(s){ return typeof s === 'string' && /^[\p{L}\p{N}_.\-]{3,32}$/u.test(s); }
function validPw(s){ return typeof s === 'string' && s.length >= 6 && s.length <= 100; }
function nameTaken(name, exceptId){ return store.users.some(x=>x.id !== exceptId && x.username.toLowerCase() === String(name).toLowerCase()); }
function ownerCount(excludeId){ return store.users.filter(u=>u.role === 'owner' && u.active && u.id !== excludeId).length; }

const INDEX = path.join(__dirname, 'public', 'index.html');
let indexCache = null, indexGzip = null, indexMtime = 0;
function serveIndex(req, res){
  try{
    const st = fs.statSync(INDEX);
    if(!indexCache || st.mtimeMs !== indexMtime){ indexCache = fs.readFileSync(INDEX); indexGzip = zlib.gzipSync(indexCache); indexMtime = st.mtimeMs; }
    const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if(/\bgzip\b/.test(req.headers['accept-encoding'] || '')){ h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); res.end(indexGzip); }
    else { res.writeHead(200, h); res.end(indexCache); }
  }catch(e){ res.writeHead(500); res.end('index.html missing'); }
}

const members = require('./members')({ can, store, save, send, readBody, sign, verifyToken, throttled, noteFail, clientIp });
const server = http.createServer(async (req, res)=>{
  try{
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if(await members.handle(req, res, p)) return;
    if(req.method === 'GET' && p === '/admin.webmanifest'){       // تطبيق الإدارة القابل للتثبيت على الهاتف (PWA)
      const nm = String((store.gymInfo && store.gymInfo.name) || '').trim() || 'Smart Gym Manager';
      const mf = { id: '/admin', name: nm + ' — الإدارة', short_name: 'الإدارة', description: 'تطبيق إدارة القاعة للمدير والموظفين', start_url: '/?pwa=1', scope: '/', display: 'standalone', orientation: 'portrait', dir: 'rtl', lang: 'ar', background_color: '#0e0e0e', theme_color: '#0e0e0e',
        icons: [{ src: '/m/icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/m/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] };
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify(mf));
    }
    if(req.method === 'GET' && p === '/admin-sw.js'){
      try{ const b = fs.readFileSync(path.join(__dirname, 'public', 'admin-sw.js')); res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); return res.end(b); }
      catch(e){ res.writeHead(404); return res.end(); }
    }
    if(!p.startsWith('/api/')){
      if(p === '/healthz'){ res.writeHead(200); return res.end('ok'); }
      if(req.method === 'GET') return serveIndex(req, res);
      res.writeHead(405); return res.end();
    }
    if(p === '/api/ping') return send(req, res, 200, { ok: 1, app: 'samgym', build: 'v4', dir: __dirname, needsSetup: store.users.length === 0 });

    if(p === '/api/setup' && req.method === 'POST'){
      if(store.users.length) return send(req, res, 403, { error: 'already_setup' });
      const b = await readBody(req);
      if(!validName(b.username) || !validPw(b.password)) return send(req, res, 400, { error: 'invalid' });
      const u = makeUser(b.username, b.password, 'owner'); store.users.push(u); save();
      return send(req, res, 200, { token: newToken(u), user: publicUser(u) });
    }
    if(p === '/api/login' && req.method === 'POST'){
      const b = await readBody(req);
      const key = clientIp(req) + '|' + String(b.username || '').toLowerCase();
      if(throttled(key)) return send(req, res, 429, { error: 'too_many' });
      const u = store.users.find(x=>x.username.toLowerCase() === String(b.username || '').toLowerCase());
      if(!u || !u.active || !checkPw(u, b.password || '')){ noteFail(key); return send(req, res, 401, { error: 'bad_credentials' }); }
      fails.delete(key);
      return send(req, res, 200, { token: newToken(u), user: publicUser(u) });
    }

    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const user = verifyToken(auth);
    if(!user) return send(req, res, 401, { error: 'unauthorized' });

    if(p === '/api/me' && req.method === 'PUT'){            // any user may rename themselves
      const b = await readBody(req);
      if(!validName(b.username)) return send(req, res, 400, { error: 'invalid' });
      if(nameTaken(b.username, user.id)) return send(req, res, 409, { error: 'exists' });
      user.username = b.username; save();
      return send(req, res, 200, { user: publicUser(user) });
    }
    if(p === '/api/me') return send(req, res, 200, { user: publicUser(user) });

    if(p === '/api/sync' && req.method === 'POST') return send(req, res, 200, doSync(user, await readBody(req)));

    if(p === '/api/users'){
      if(user.role !== 'owner') return send(req, res, 403, { error: 'forbidden' });
      if(req.method === 'GET') return send(req, res, 200, { users: store.users.map(publicUser) });
      if(req.method === 'POST'){
        const b = await readBody(req);
        if(!validName(b.username) || !validPw(b.password) || !ROLES.includes(b.role)) return send(req, res, 400, { error: 'invalid' });
        if(store.users.some(x=>x.username.toLowerCase() === b.username.toLowerCase())) return send(req, res, 409, { error: 'exists' });
        const u = makeUser(b.username, b.password, b.role); u.perms = cleanPerms(b.perms, b.role); store.users.push(u); save();
        return send(req, res, 200, { user: publicUser(u) });
      }
    }
    const m = p.match(/^\/api\/users\/([0-9a-f]+)$/);
    if(m && req.method === 'PUT'){
      if(user.role !== 'owner') return send(req, res, 403, { error: 'forbidden' });
      const u = store.users.find(x=>x.id === m[1]);
      if(!u) return send(req, res, 404, { error: 'not_found' });
      const b = await readBody(req);
      if(b.username !== undefined){
        if(!validName(b.username)) return send(req, res, 400, { error: 'invalid' });
        if(nameTaken(b.username, u.id)) return send(req, res, 409, { error: 'exists' });
        u.username = b.username;
      }
      if(b.perms !== undefined) u.perms = cleanPerms(b.perms, u.role);
      if(b.password !== undefined){
        if(!validPw(b.password)) return send(req, res, 400, { error: 'invalid' });
        u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(b.password, u.salt);
      }
      const newRole = b.role !== undefined ? b.role : u.role;
      const newActive = b.active !== undefined ? !!b.active : u.active;
      if(!ROLES.includes(newRole)) return send(req, res, 400, { error: 'invalid' });
      if(u.role === 'owner' && u.active && (newRole !== 'owner' || !newActive) && ownerCount(u.id) === 0) return send(req, res, 400, { error: 'last_owner' });
      u.role = newRole; u.active = newActive; save();
      return send(req, res, 200, { user: publicUser(u) });
    }
    if(m && req.method === 'DELETE'){
      if(user.role !== 'owner') return send(req, res, 403, { error: 'forbidden' });
      const u = store.users.find(x=>x.id === m[1]);
      if(!u) return send(req, res, 404, { error: 'not_found' });
      if(u.id === user.id) return send(req, res, 400, { error: 'self' });
      if(u.role === 'owner' && u.active && ownerCount(u.id) === 0) return send(req, res, 400, { error: 'last_owner' });
      store.users = store.users.filter(x=>x.id !== u.id); save();
      return send(req, res, 200, { ok: true });
    }
    send(req, res, 404, { error: 'not_found' });
  }catch(e){
    send(req, res, e.code === 413 ? 413 : (e.code === 400 ? 400 : 500), { error: e.message });
    if(!e.code) console.error(e);
  }
});
server.listen(PORT, '0.0.0.0', ()=>console.log('Smart Gym Manager server on port ' + PORT + ' — data in ' + DATA_DIR));
