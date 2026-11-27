// Sky & Sea Tycoon: static game files + a small feedback API.
//   POST /api/feedback   player sends a message (checked, filtered, rate limited, stored in D1)
//   POST /api/ping       "I'm playing" every 90 s from an open game: a random device id only (no name, no save)
//   GET  /admin          developer page: document links, players online, messages. Sign in with ADMIN_KEY (a secret in
//                        Cloudflare) on the page itself: the key is never put in the link. A signed cookie keeps you in for
//                        7 days; 5 wrong tries in 15 minutes from one network locks sign-in for 15 minutes.
//   GET  /admin/join     ask to become an admin: pick a name and your own password; the developer approves it on /admin
//                        and gives you a number (01, 02 ...). Only a slow salted hash of the password is stored
//                        (PBKDF2, mixed with a secret derived from ADMIN_KEY), never the password itself.
// Everything else is served from the static assets (the game).
const CATS = ["bug", "idea", "balance", "other"];
const MAX_LEN = 1000, PER_HOUR = 5;
// rude words (Thai and English) are masked before saving; the list is short on purpose and can grow
// Thai has no spaces between words, so only words that never appear inside ordinary words are listed
// (short ones like "สัด" would also hit "สัดส่วน"); English words are matched as whole words
const BAD_TH = ["ควย", "เหี้ย", "เย็ด", "ไอ้สัตว์", "อีดอก", "ส้นตีน", "สัส"];
const BAD_EN = /\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|asshole\w*)\b/gi;
const mask = t => BAD_TH.reduce((s, w) => s.split(w).join("*".repeat([...w].length)), t).replace(BAD_EN, w => "*".repeat(w.length));
const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

async function ensure(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, cat TEXT, msg TEXT NOT NULL, ver TEXT, day INTEGER, dev TEXT, iph TEXT, done INTEGER DEFAULT 0)");
  await db.exec("CREATE TABLE IF NOT EXISTS adminfail (iph TEXT NOT NULL, t INTEGER NOT NULL)");
  await db.exec("CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, t INTEGER NOT NULL, ok INTEGER, last INTEGER, iph TEXT)");
  await db.exec("CREATE TABLE IF NOT EXISTS presence (id TEXT NOT NULL, stage TEXT NOT NULL, t INTEGER NOT NULL, first INTEGER NOT NULL, ver TEXT, lang TEXT, dev TEXT, PRIMARY KEY (id, stage))");
  // document links on the admin page; kept in the database (not in this public code), added and edited on the page
  await db.exec("CREATE TABLE IF NOT EXISTS doclinks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, note TEXT, url TEXT, pos INTEGER DEFAULT 0)");
  if (!(await db.prepare("SELECT COUNT(*) AS n FROM doclinks").first()).n)
    await db.batch(DOC_SLOTS.map(([t, n], i) => db.prepare("INSERT INTO doclinks (title,note,url,pos) VALUES (?,?,'',?)").bind(t, n, i)));
}
const DOC_SLOTS = [["📘 เอกสารระบบผู้เล่น", "ระบบในเกมที่ผู้เล่นเห็น"], ["🛠️ เอกสารระบบแอดมิน", "หน้าแอดมิน เซิร์ฟเวอร์ การอัปเดต"], ["🏷️ เอกสารเวอร์ชัน", "ระบบทดสอบ · ระบบจริง"]];
const okUrl = u => /^https:\/\/[^\s<>"']{4,500}$/.test(u);
// players online: one row per device (random id made by the game), updated every 90 s while the game is open and visible
const ONLINE_MS = 7 * 60e3;
async function postPing(req, env) {
  if (!env.DB) return json({ok: false}, 503);
  let b; try { b = await req.json() } catch (e) { return json({ok: false}, 400) }
  const id = String(b.id || "");
  if (!/^[a-z0-9]{12,32}$/.test(id)) return json({ok: false}, 400);
  await ensure(env.DB);
  const now = Date.now(), stage = env.STAGE === "test" ? "test" : "live";
  await env.DB.prepare("INSERT INTO presence (id,stage,t,first,ver,lang,dev) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id,stage) DO UPDATE SET t=excluded.t, ver=excluded.ver, lang=excluded.lang, dev=excluded.dev")
    .bind(id, stage, now, now, String(b.ver || "").slice(0, 12), b.lang === "en" ? "en" : "th", String(b.dev || "").slice(0, 20)).run();
  return json({ok: true});
}
// numbers for the admin page; "today" is the Bangkok calendar day
async function presenceStats(db) {
  const now = Date.now(), bkk = 7 * 3600e3, day0 = Math.floor((now + bkk) / 864e5) * 864e5 - bkk;
  const q = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const one = async stage => ({
    online: (await q("SELECT COUNT(*) AS n FROM presence WHERE stage=? AND t>?", stage, now - ONLINE_MS)).n,
    today: (await q("SELECT COUNT(*) AS n FROM presence WHERE stage=? AND t>=?", stage, day0)).n,
    newToday: (await q("SELECT COUNT(*) AS n FROM presence WHERE stage=? AND first>=?", stage, day0)).n,
    week: (await q("SELECT COUNT(*) AS n FROM presence WHERE stage=? AND t>=?", stage, now - 7 * 864e5)).n,
    all: (await q("SELECT COUNT(*) AS n FROM presence WHERE stage=?", stage)).n,
    en: (await q("SELECT COUNT(*) AS n FROM presence WHERE stage=? AND t>? AND lang='en'", stage, now - ONLINE_MS)).n
  });
  return {live: await one("live"), test: await one("test")};
}
async function ipHash(ip) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("skysea:" + ip));
  return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function postFeedback(req, env) {
  if (!env.DB) return json({ok: false, error: "ยังไม่ได้ตั้งฐานข้อมูล"}, 503);
  let b; try { b = await req.json() } catch (e) { return json({ok: false, error: "ข้อมูลไม่ถูกต้อง"}, 400) }
  let msg = String(b.msg || "").replace(/\s+/g, " ").trim();
  if (b.hp) return json({ok: true});                       // honeypot field filled by bots: pretend it worked
  if (msg.length < 5) return json({ok: false, error: "ข้อความสั้นเกินไป"}, 400);
  if (msg.length > MAX_LEN) msg = msg.slice(0, MAX_LEN);
  if ((msg.match(/https?:\/\//g) || []).length > 2) return json({ok: false, error: "มีลิงก์มากเกินไป"}, 400);
  const cat = CATS.includes(b.cat) ? b.cat : "other";
  await ensure(env.DB);
  const iph = await ipHash(req.headers.get("cf-connecting-ip") || "x"), now = Date.now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE iph=? AND t>?").bind(iph, now - 3600e3).first();
  if (recent && recent.n >= PER_HOUR) return json({ok: false, error: "ส่งบ่อยเกินไป ลองใหม่ในอีกสักครู่"}, 429);
  const dup = await env.DB.prepare("SELECT id FROM feedback WHERE iph=? AND msg=? LIMIT 1").bind(iph, mask(msg)).first();
  if (dup) return json({ok: true, dup: true});
  await env.DB.prepare("INSERT INTO feedback (t,cat,msg,ver,day,dev,iph) VALUES (?,?,?,?,?,?,?)")
    .bind(now, cat, mask(msg), String(b.ver || "").slice(0, 12), Number.isFinite(+b.day) ? Math.round(+b.day) : null, String(b.dev || "").slice(0, 40), iph).run();
  return json({ok: true});
}

// ---- admin sign-in: key typed on the page, then a signed cookie (HMAC of the expiry with ADMIN_KEY) ----
const SESSION_DAYS = 7, FAIL_MAX = 5, FAIL_MS = 15 * 60e3;
const html = (body, status = 200, extra = {}) => new Response(body, {status, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...extra}});
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
const sameStr = (a, b) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0 };
const cookieOf = (req, n) => { const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + n + "=([^;]+)")); return m ? m[1] : "" };
// the web's own formula: PBKDF2 (100,000 rounds) of the password with a random salt and a secret pepper made from ADMIN_KEY.
// The database only ever holds the result, which cannot be turned back into the password.
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
async function pwHash(env, pw, salt) {
  const pepper = await hmac(env.ADMIN_KEY, "pepper:skysea-admins");
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper + ":" + pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000}, k, 256));
}
const adminNo = id => String(id).padStart(2, "0");
// who: "dev" (ADMIN_KEY) or an approved admin's id. Revoking an admin ends their sessions at once (checked every request).
async function signedIn(req, env) {
  const [exp, who, sig] = cookieOf(req, "adm").split(".");
  if (!exp || !who || !sig || +exp < Date.now()) return null;
  if (!sameStr(sig, await hmac(env.ADMIN_KEY, "adm:" + exp + ":" + who + ":" + (env.STAGE || "live")))) return null;
  if (who === "dev") return {dev: true, name: "ผู้พัฒนา"};
  if (!env.DB) return null;
  const a = await env.DB.prepare("SELECT id,name,status FROM admins WHERE id=?").bind(+who).first();
  return a && a.status === "active" ? {dev: false, id: a.id, name: a.name} : null;
}
function loginPage(msg, status = 200) {
  return html(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>เข้าสู่ระบบแอดมิน · Sky &amp; Sea Tycoon</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#0f1825;color:#e5ecf5;display:grid;place-items:center;min-height:100vh}form{background:#16233a;border:1px solid #28394f;border-radius:16px;padding:22px;width:min(340px,calc(100vw - 32px));display:flex;flex-direction:column;gap:12px}
input{background:#0f1825;color:#e5ecf5;border:1px solid #28394f;border-radius:10px;padding:10px 12px;font-size:16px}button{background:#ee9b45;color:#1a1206;border:0;border-radius:10px;padding:10px;font-weight:700;font-size:16px}.e{color:#f27268;font-size:14px}.s{color:#8d9cb1;font-size:12px}</style></head>
<body><form method="post" action="/admin/login"><h2 style="margin:0">🛠️ ระบบแอดมิน</h2>${msg ? `<div class="e">${esc(msg)}</div>` : ""}
<input name="who" placeholder="เลขแอดมิน (เช่น 01) หรือชื่อ · ผู้พัฒนาเว้นว่าง" autocomplete="username" maxlength="30">
<input type="password" name="key" placeholder="รหัส" autocomplete="current-password" required autofocus><button>เข้าสู่ระบบ</button>
<div class="s">อยู่ในระบบได้ ${SESSION_DAYS} วันในเบราว์เซอร์นี้ · ใส่ผิด ${FAIL_MAX} ครั้งจะล็อก 15 นาที</div>
<a href="/admin/join" style="color:#ee9b45;font-size:14px">ขอเป็นแอดมิน ›</a></form></body></html>`, status);
}
async function adminLogin(req, env, url) {
  if (!env.ADMIN_KEY) return loginPage("ยังไม่ได้ตั้ง ADMIN_KEY ใน Cloudflare", 503);
  if (!env.DB) return new Response("ยังไม่ได้ตั้งฐานข้อมูล D1", {status: 503, headers: {"content-type": "text/plain; charset=utf-8"}});
  if (req.method !== "POST") return Response.redirect(url.origin + "/admin", 303);
  const org = req.headers.get("origin"); if (org && org !== url.origin) return new Response("forbidden", {status: 403});
  await ensure(env.DB);
  const iph = await ipHash(req.headers.get("cf-connecting-ip") || "x"), now = Date.now();
  await env.DB.prepare("DELETE FROM adminfail WHERE t<?").bind(now - FAIL_MS).run();
  const fails = (await env.DB.prepare("SELECT COUNT(*) AS n FROM adminfail WHERE iph=? AND t>?").bind(iph, now - FAIL_MS).first()).n;
  if (fails >= FAIL_MAX) return loginPage("ใส่รหัสผิดหลายครั้ง ระบบล็อกไว้ 15 นาที ลองใหม่ภายหลัง", 429);
  const f = await req.formData(), key = String(f.get("key") || ""), whoIn = String(f.get("who") || "").trim();
  let who = null;
  if (!whoIn && sameStr(key, env.ADMIN_KEY)) who = "dev";
  else if (whoIn) {
    const a = /^\d{1,4}$/.test(whoIn) ? await env.DB.prepare("SELECT * FROM admins WHERE id=? AND status='active'").bind(+whoIn).first()
                                       : await env.DB.prepare("SELECT * FROM admins WHERE name=? AND status='active'").bind(whoIn).first();
    if (a && sameStr(await pwHash(env, key, a.salt), a.hash)) { who = String(a.id); await env.DB.prepare("UPDATE admins SET last=? WHERE id=?").bind(now, a.id).run() }
  }
  if (!who) {
    await env.DB.prepare("INSERT INTO adminfail (iph,t) VALUES (?,?)").bind(iph, now).run();
    return loginPage(`เลขแอดมินหรือรหัสไม่ถูกต้อง (เหลืออีก ${Math.max(0, FAIL_MAX - fails - 1)} ครั้งก่อนล็อก)`, 401);
  }
  await env.DB.prepare("DELETE FROM adminfail WHERE iph=?").bind(iph).run();
  const exp = now + SESSION_DAYS * 864e5, sig = await hmac(env.ADMIN_KEY, "adm:" + exp + ":" + who + ":" + (env.STAGE || "live"));
  return new Response(null, {status: 303, headers: {location: "/admin", "cache-control": "no-store",
    "set-cookie": `adm=${exp}.${who}.${sig}; Path=/admin; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`}});
}
// ask to become an admin: own name + own password; waits for the developer's approval
const JOIN_PER_DAY = 3, PENDING_MAX = 20;
function joinPage(msg, ok, status = 200) {
  return html(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ขอเป็นแอดมิน · Sky &amp; Sea Tycoon</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#0f1825;color:#e5ecf5;display:grid;place-items:center;min-height:100vh}form,.box{background:#16233a;border:1px solid #28394f;border-radius:16px;padding:22px;width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:12px}
input{background:#0f1825;color:#e5ecf5;border:1px solid #28394f;border-radius:10px;padding:10px 12px;font-size:16px}button{background:#ee9b45;color:#1a1206;border:0;border-radius:10px;padding:10px;font-weight:700;font-size:16px}.e{color:#f27268;font-size:14px}.g{color:#4dc48a}.s{color:#8d9cb1;font-size:12px}a{color:#ee9b45}</style></head><body>
${ok ? `<div class="box"><h2 style="margin:0">✅ ส่งคำขอแล้ว</h2><div class="g">${esc(ok)}</div><div class="s">ผู้พัฒนาจะอนุมัติแล้วบอกเลขแอดมินให้ ใช้เลขนั้นกับรหัสที่ตั้งไว้เข้าสู่ระบบ</div><a href="/admin">ไปหน้าเข้าสู่ระบบ ›</a></div>`
: `<form method="post" action="/admin/join"><h2 style="margin:0">🙋 ขอเป็นแอดมิน</h2>${msg ? `<div class="e">${esc(msg)}</div>` : ""}
<input name="name" placeholder="ชื่อของคุณ" maxlength="30" required autocomplete="username">
<input type="password" name="pw" placeholder="ตั้งรหัสเอง (อย่างน้อย 10 ตัว)" minlength="10" maxlength="100" required autocomplete="new-password">
<input type="password" name="pw2" placeholder="ใส่รหัสอีกครั้ง" minlength="10" maxlength="100" required autocomplete="new-password"><button>ส่งคำขอ</button>
<div class="s">เว็บแปลงรหัสเป็นรหัสคอมพิวเตอร์ด้วยสูตรของเว็บก่อนเก็บ ไม่มีใครเห็นรหัสจริง รวมถึงผู้พัฒนา · ถ้าลืมรหัสต้องขอใหม่</div><a href="/admin" style="font-size:14px">‹ กลับ</a></form>`}</body></html>`, status);
}
async function adminJoin(req, env, url) {
  if (!env.ADMIN_KEY || !env.DB) return joinPage("ระบบยังไม่พร้อม", null, 503);
  if (req.method !== "POST") return joinPage("");
  const org = req.headers.get("origin"); if (org && org !== url.origin) return new Response("forbidden", {status: 403});
  await ensure(env.DB);
  const f = await req.formData(), name = String(f.get("name") || "").replace(/\s+/g, " ").trim(), pw = String(f.get("pw") || ""), pw2 = String(f.get("pw2") || "");
  if (name.length < 2 || name.length > 30 || /^\d+$/.test(name) || /[<>"']/.test(name)) return joinPage("ชื่อต้องยาว 2–30 ตัว ไม่ใช่ตัวเลขล้วน และไม่มีเครื่องหมาย < > \" '", null, 400);
  if (pw.length < 10 || pw.length > 100) return joinPage("รหัสต้องยาว 10–100 ตัว", null, 400);
  if (pw !== pw2) return joinPage("รหัสสองช่องไม่ตรงกัน", null, 400);
  if (sameStr(pw, env.ADMIN_KEY)) return joinPage("ใช้รหัสนี้ไม่ได้ ตั้งรหัสอื่น", null, 400);
  const iph = await ipHash(req.headers.get("cf-connecting-ip") || "x"), now = Date.now();
  const mine = (await env.DB.prepare("SELECT COUNT(*) AS n FROM admins WHERE iph=? AND t>?").bind(iph, now - 864e5).first()).n;
  if (mine >= JOIN_PER_DAY) return joinPage("ส่งคำขอบ่อยเกินไป ลองใหม่พรุ่งนี้", null, 429);
  if ((await env.DB.prepare("SELECT COUNT(*) AS n FROM admins WHERE status='pending'").first()).n >= PENDING_MAX) return joinPage("มีคำขอรออยู่มากแล้ว ลองใหม่ภายหลัง", null, 429);
  if (await env.DB.prepare("SELECT id FROM admins WHERE name=? AND status!='revoked'").bind(name).first()) return joinPage("ชื่อนี้มีคนใช้แล้ว", null, 400);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare("INSERT INTO admins (name,salt,hash,status,t,iph) VALUES (?,?,?,'pending',?,?)").bind(name, salt, await pwHash(env, pw, salt), now, iph).run();
  return joinPage("", `คำขอของ ${name} ถึงผู้พัฒนาแล้ว`);
}
async function admin(req, env, url) {
  if (!env.ADMIN_KEY) return loginPage("ยังไม่ได้ตั้ง ADMIN_KEY ใน Cloudflare", 503);
  if (url.searchParams.has("key")) return Response.redirect(url.origin + "/admin", 303);   // old links with the key: drop it, never use it
  const me = await signedIn(req, env); if (!me) return loginPage("", 401);
  if (req.method === "POST") { const org = req.headers.get("origin"); if (org && org !== url.origin) return new Response("forbidden", {status: 403}) }
  if (url.pathname === "/admin/logout") return new Response(null, {status: 303, headers: {location: "/admin", "set-cookie": "adm=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict"}});
  if (!env.DB) return new Response("ยังไม่ได้ตั้งฐานข้อมูล D1", {status: 503, headers: {"content-type": "text/plain; charset=utf-8"}});
  await ensure(env.DB);
  if (req.method === "POST") {
    const f = await req.formData(), id = +f.get("id"), act = f.get("act");
    if (act === "done") await env.DB.prepare("UPDATE feedback SET done=1-done WHERE id=?").bind(id).run();
    if (act === "del") await env.DB.prepare("DELETE FROM feedback WHERE id=?").bind(id).run();
    const lu = String(f.get("url") || "").trim(), lt = String(f.get("title") || "").trim().slice(0, 60), ln = String(f.get("note") || "").trim().slice(0, 80);
    if (act === "linkset" && (lu === "" || okUrl(lu))) await env.DB.prepare("UPDATE doclinks SET url=? WHERE id=?").bind(lu, id).run();
    if (act === "linkadd" && lt && (lu === "" || okUrl(lu))) await env.DB.prepare("INSERT INTO doclinks (title,note,url,pos) VALUES (?,?,?,(SELECT COALESCE(MAX(pos),0)+1 FROM doclinks))").bind(lt, ln, lu).run();
    if (act === "linkdel") await env.DB.prepare("DELETE FROM doclinks WHERE id=?").bind(id).run();
    if (me.dev && act === "adm_ok") await env.DB.prepare("UPDATE admins SET status='active', ok=? WHERE id=? AND status='pending'").bind(Date.now(), id).run();
    if (me.dev && act === "adm_no") await env.DB.prepare("DELETE FROM admins WHERE id=? AND status='pending'").bind(id).run();
    if (me.dev && act === "adm_off") await env.DB.prepare("UPDATE admins SET status='revoked' WHERE id=? AND status='active'").bind(id).run();
    if (me.dev && act === "adm_del") await env.DB.prepare("DELETE FROM admins WHERE id=? AND status='revoked'").bind(id).run();
    const c0 = url.searchParams.get("cat"); return Response.redirect(url.origin + "/admin" + (c0 && CATS.includes(c0) ? "?cat=" + c0 : ""), 303);
  }
  const cat = url.searchParams.get("cat");
  const rows = (cat && CATS.includes(cat) ? await env.DB.prepare("SELECT * FROM feedback WHERE cat=? ORDER BY done, t DESC LIMIT 300").bind(cat).all() : await env.DB.prepare("SELECT * FROM feedback ORDER BY done, t DESC LIMIT 300").all()).results || [];
  const cnt = (await env.DB.prepare("SELECT cat, COUNT(*) AS n, SUM(done) AS d FROM feedback GROUP BY cat").all()).results || [];
  const N = {bug: "🐞 บัค", idea: "💡 ไอเดีย", balance: "⚖️ ความสมดุล", other: "💬 อื่น ๆ"};
  const P = await presenceStats(env.DB);
  const L = (await env.DB.prepare("SELECT * FROM doclinks ORDER BY pos, id").all()).results || [];
  const A = me.dev ? (await env.DB.prepare("SELECT id,name,status,t,ok,last FROM admins ORDER BY status='pending' DESC, status='active' DESC, id").all()).results || [] : [];
  const when = t => t ? new Date(t).toLocaleString("th-TH", {timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short"}) : "–";
  const back = `/admin${cat && CATS.includes(cat) ? "?cat=" + cat : ""}`;
  const doc = d => `<div class="dc">${d.url ? `<a class="go" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(d.title)}</b><span class="s">${esc(d.note)}</span><span class="op">เปิด ›</span></a>` : `<b>${esc(d.title)}</b><span class="s">${esc(d.note)}</span>`}
<details${d.url ? "" : " open"}><summary class="s">${d.url ? "แก้ลิงก์" : "ยังไม่ได้ใส่ลิงก์"}</summary><form method="post" action="${back}"><input type="hidden" name="id" value="${d.id}"><input name="url" type="url" placeholder="https://…" value="${esc(d.url)}"><button name="act" value="linkset">บันทึก</button><button name="act" value="linkdel" onclick="return confirm('ลบช่องเอกสารนี้?')">🗑️</button></form></details></div>`;
  const stat = (e, l, v, sub) => `<div class="st"><span>${e} ${l}</span><b>${v}</b><span class="s">${sub}</span></div>`;
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ระบบแอดมิน · Sky &amp; Sea Tycoon</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#0f1825;color:#e5ecf5}main{max-width:900px;margin:auto;padding:16px}a{color:#ee9b45}h1{margin:6px 0 14px;text-align:center}h2{margin:22px 0 8px;font-size:19px}
.f{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.f a{padding:6px 10px;border:1px solid #28394f;border-radius:8px;text-decoration:none}
.c,.dc,.st{background:#16233a;border:1px solid #28394f;border-radius:14px;padding:12px;margin:8px 0}.c.d{opacity:.5}.m{white-space:pre-wrap;margin:6px 0 8px;line-height:1.5}.s{font-size:12px;color:#8d9cb1}
button{background:#28394f;color:#e5ecf5;border:0;border-radius:8px;padding:6px 10px;margin-right:6px}input{background:#0f1825;color:#e5ecf5;border:1px solid #28394f;border-radius:8px;padding:6px 8px;min-width:0;flex:1}
.docs{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.dc{margin:0;display:flex;flex-direction:column;gap:6px;min-height:110px}.dc .go{display:flex;flex-direction:column;gap:4px;text-decoration:none;color:inherit;flex:1}.dc .op{color:#ee9b45;font-weight:700;margin-top:auto}
.dc form,.add form{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}.dc form input,.add form input{flex:1 1 100%}.dc summary{cursor:pointer}.dc.add{border-style:dashed;min-height:0}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.st{margin:0;display:flex;flex-direction:column;gap:4px}.st b{font-size:30px}
.fb{background:#121d30;border:1px solid #28394f;border-radius:16px;padding:12px}
@media (max-width:560px){.stats{grid-template-columns:1fr}}</style></head>
<body><main><h1>🛠️ ระบบแอดมิน</h1><div style="text-align:right;margin-top:-8px" class="s">เข้าระบบเป็น <b>${esc(me.dev ? "ผู้พัฒนา" : "แอดมิน " + adminNo(me.id) + " · " + me.name)}</b> · <a href="/admin/logout">ออกจากระบบ</a></div>
<h2>📄 เอกสาร</h2><div class="docs">${L.map(doc).join("")}
<details class="dc add"><summary><b>＋ เพิ่มเอกสาร</b></summary><form method="post" action="${back}"><input name="title" placeholder="ชื่อเอกสาร" required maxlength="60"><input name="note" placeholder="คำอธิบายสั้น ๆ" maxlength="80"><input name="url" type="url" placeholder="https://… (ใส่ทีหลังได้)"><button name="act" value="linkadd">เพิ่ม</button></form></details></div>
<h2>👥 ผู้เล่น (เว็บจริง)</h2><div class="stats">
${stat("🟢", "กำลังออนไลน์อยู่", P.live.online + " คน", `ภาษาอังกฤษ ${P.live.en} คน · ในช่วง 7 นาทีล่าสุด`)}
${stat("📅", "ผู้เล่น / วัน", P.live.today + " คน", `วันนี้ · คนใหม่ ${P.live.newToday} คน`)}
${stat("🗓️", "ผู้เล่น / สัปดาห์", P.live.week + " คน", `7 วันล่าสุด · ทั้งหมด ${P.live.all} เครื่อง`)}</div>
<div class="s" style="margin-top:6px">🧪 เว็บทดสอบ: ออนไลน์ ${P.test.online} · วันนี้ ${P.test.today} · ทั้งหมด ${P.test.all} · นับเป็นเครื่อง (คนเดียวเล่นสองเครื่องนับ 2) · กดรีเฟรชหน้านี้เพื่ออัปเดต</div>
${me.dev ? `<h2>👤 จัดการแอดมิน</h2><div class="fb">${A.length ? A.map(a => `<div class="c ${a.status === "revoked" ? "d" : ""}"><b>${a.status === "pending" ? "🙋 ขอเป็นแอดมิน" : "แอดมิน " + adminNo(a.id)} · ${esc(a.name)}</b>
<div class="s">${a.status === "pending" ? "ส่งคำขอ " + when(a.t) : a.status === "active" ? "อนุมัติ " + when(a.ok) + " · เข้าล่าสุด " + when(a.last) : "ยกเลิกแล้ว"}</div>
<form method="post" action="${back}" style="margin-top:6px"><input type="hidden" name="id" value="${a.id}">${a.status === "pending" ? `<button name="act" value="adm_ok">✅ อนุมัติ (ได้เลข ${adminNo(a.id)})</button><button name="act" value="adm_no" onclick="return confirm('ปฏิเสธคำขอนี้?')">✕ ปฏิเสธ</button>` : a.status === "active" ? `<button name="act" value="adm_off" onclick="return confirm('ยกเลิกสิทธิ์แอดมิน ${adminNo(a.id)}?')">⛔ ยกเลิกสิทธิ์</button>` : `<button name="act" value="adm_del">🗑️ ลบออกจากรายการ</button>`}</form></div>`).join("") : `<div class="s">ยังไม่มีแอดมินคนอื่น · ส่งลิงก์ ${esc(url.origin)}/admin/join ให้คนที่จะเป็นแอดมิน เขาตั้งรหัสเองแล้วคำขอจะมาขึ้นที่นี่</div>`}</div>` : ""}
<h2>💬 ความคิดเห็น</h2><div class="fb"><div class="s">${cnt.map(c => `${N[c.cat] || c.cat}: ${c.n} (อ่านแล้ว ${c.d || 0})`).join(" · ") || "ยังไม่มีความเห็น"}</div>
<div class="f"><a href="/admin">ทั้งหมด</a>${CATS.map(c => `<a href="/admin?cat=${c}">${N[c]}</a>`).join("")}</div>
${rows.map(r => `<div class="c ${r.done ? "d" : ""}"><div class="s">#${r.id} · ${N[r.cat] || esc(r.cat)} · ${new Date(r.t).toLocaleString("th-TH", {timeZone: "Asia/Bangkok"})} · v${esc(r.ver)} · วันที่ ${esc(r.day)} · ${esc(r.dev)}</div><div class="m">${esc(r.msg)}</div>
<form method="post" action="${back}"><input type="hidden" name="id" value="${r.id}"><button name="act" value="done">${r.done ? "↩️ ยังไม่อ่าน" : "✅ อ่านแล้ว"}</button><button name="act" value="del" onclick="return confirm('ลบความเห็นนี้?')">🗑️ ลบ</button></form></div>`).join("") || `<div class="s" style="padding:10px 0">ยังไม่มีความเห็นในหมวดนี้</div>`}</div>
</main></body></html>`;
  return new Response(html, {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex"}});
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/feedback" && req.method === "POST") return await postFeedback(req, env);
      if (url.pathname === "/api/ping" && req.method === "POST") return await postPing(req, env);
      if (url.pathname === "/admin/login") return await adminLogin(req, env, url);
      if (url.pathname === "/admin/join") return await adminJoin(req, env, url);
      if (url.pathname === "/admin" || url.pathname === "/admin/logout") return await admin(req, env, url);
    } catch (e) { return json({ok: false, error: "เซิร์ฟเวอร์ขัดข้อง"}, 500) }
    // test server (STAGE=test): keep it out of search engines
    if (env.STAGE === "test") {
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", {headers: {"content-type": "text/plain"}});
      const r = await env.ASSETS.fetch(req), h = new Headers(r.headers); h.set("x-robots-tag", "noindex, nofollow");
      return new Response(r.body, {status: r.status, statusText: r.statusText, headers: h});
    }
    return env.ASSETS.fetch(req);
  }
};
