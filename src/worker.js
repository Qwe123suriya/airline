// Sky & Sea Tycoon: static game files + a small feedback API.
//   POST /api/feedback   player sends a message (checked, filtered, rate limited, stored in D1)
//   POST /api/ping       "I'm playing" every 90 s from an open game: a random device id only (no name, no save)
//   GET  /admin          developer page: players online + messages (needs ADMIN_KEY, set as a secret in Cloudflare)
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
  await db.exec("CREATE TABLE IF NOT EXISTS presence (id TEXT NOT NULL, stage TEXT NOT NULL, t INTEGER NOT NULL, first INTEGER NOT NULL, ver TEXT, lang TEXT, dev TEXT, PRIMARY KEY (id, stage))");
}
// players online: one row per device (random id made by the game), updated every 90 s while the game is open and visible
const ONLINE_MS = 3 * 60e3;
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

async function admin(req, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("ต้องใส่รหัสผู้ดูแล: /admin?key=...", {status: 401, headers: {"content-type": "text/plain; charset=utf-8"}});
  if (!env.DB) return new Response("ยังไม่ได้ตั้งฐานข้อมูล D1", {status: 503, headers: {"content-type": "text/plain; charset=utf-8"}});
  await ensure(env.DB);
  if (req.method === "POST") {
    const f = await req.formData(), id = +f.get("id"), act = f.get("act");
    if (act === "done") await env.DB.prepare("UPDATE feedback SET done=1-done WHERE id=?").bind(id).run();
    if (act === "del") await env.DB.prepare("DELETE FROM feedback WHERE id=?").bind(id).run();
    return Response.redirect(url.origin + "/admin?key=" + encodeURIComponent(key) + (url.searchParams.get("cat") ? "&cat=" + url.searchParams.get("cat") : ""), 303);
  }
  const cat = url.searchParams.get("cat");
  const rows = (cat && CATS.includes(cat) ? await env.DB.prepare("SELECT * FROM feedback WHERE cat=? ORDER BY done, t DESC LIMIT 300").bind(cat).all() : await env.DB.prepare("SELECT * FROM feedback ORDER BY done, t DESC LIMIT 300").all()).results || [];
  const cnt = (await env.DB.prepare("SELECT cat, COUNT(*) AS n, SUM(done) AS d FROM feedback GROUP BY cat").all()).results || [];
  const N = {bug: "🐞 บัค", idea: "💡 ไอเดีย", balance: "⚖️ ความสมดุล", other: "💬 อื่น ๆ"}, k = encodeURIComponent(key);
  const P = await presenceStats(env.DB);
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ความเห็นผู้เล่น · Sky &amp; Sea Tycoon</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#0f1825;color:#e5ecf5}main{max-width:820px;margin:auto;padding:16px}a{color:#ee9b45}.f{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.f a{padding:6px 10px;border:1px solid #28394f;border-radius:8px;text-decoration:none}.c{background:#16233a;border:1px solid #28394f;border-radius:12px;padding:12px;margin:8px 0}.c.d{opacity:.5}.m{white-space:pre-wrap;margin:6px 0 8px;line-height:1.5}.s{font-size:12px;color:#8d9cb1}button{background:#28394f;color:#e5ecf5;border:0;border-radius:8px;padding:6px 10px;margin-right:6px}</style></head>
<body><main><h1>👥 ผู้เล่น</h1>
<div class="c"><div style="font-size:28px;font-weight:700">🟢 ออนไลน์ตอนนี้ ${P.live.online} คน</div>
<div class="s">ภาษาอังกฤษ ${P.live.en} คน · นับคนที่เปิดเกมอยู่ในช่วง 3 นาทีล่าสุด (กดรีเฟรชหน้านี้เพื่ออัปเดต)</div>
<div style="margin-top:8px">วันนี้ ${P.live.today} คน (คนใหม่ ${P.live.newToday}) · 7 วันล่าสุด ${P.live.week} คน · ทั้งหมด ${P.live.all} เครื่อง</div>
<div class="s" style="margin-top:6px">🧪 เว็บทดสอบ: ออนไลน์ ${P.test.online} · วันนี้ ${P.test.today} · ทั้งหมด ${P.test.all} · นับเป็นเครื่อง (คนเดียวเล่นสองเครื่องนับ 2)</div></div>
<h1>💬 ความเห็นผู้เล่น</h1><div class="s">${cnt.map(c => `${N[c.cat] || c.cat}: ${c.n} (อ่านแล้ว ${c.d || 0})`).join(" · ") || "ยังไม่มีความเห็น"}</div>
<div class="f"><a href="/admin?key=${k}">ทั้งหมด</a>${CATS.map(c => `<a href="/admin?key=${k}&cat=${c}">${N[c]}</a>`).join("")}</div>
${rows.map(r => `<div class="c ${r.done ? "d" : ""}"><div class="s">#${r.id} · ${N[r.cat] || esc(r.cat)} · ${new Date(r.t).toLocaleString("th-TH", {timeZone: "Asia/Bangkok"})} · v${esc(r.ver)} · วันที่ ${esc(r.day)} · ${esc(r.dev)}</div><div class="m">${esc(r.msg)}</div>
<form method="post" action="/admin?key=${k}${cat ? "&cat=" + cat : ""}"><input type="hidden" name="id" value="${r.id}"><button name="act" value="done">${r.done ? "↩️ ยังไม่อ่าน" : "✅ อ่านแล้ว"}</button><button name="act" value="del" onclick="return confirm('ลบความเห็นนี้?')">🗑️ ลบ</button></form></div>`).join("")}
</main></body></html>`;
  return new Response(html, {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex"}});
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/feedback" && req.method === "POST") return await postFeedback(req, env);
      if (url.pathname === "/api/ping" && req.method === "POST") return await postPing(req, env);
      if (url.pathname === "/admin") return await admin(req, env, url);
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
