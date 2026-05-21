/**
 * JURNAL Tracker — kichik server va kunlik email yuboruvchi
 *
 * Ishlashi:
 *   1. http://localhost:5555 da UI'ni xizmat qiladi
 *   2. Holatni state.json fayliga saqlaydi (localStorage o'rniga)
 *   3. Har kuni soat SEND_HOUR (default 21:00) da yuldoshevtem@gmail.com ga
 *      bugungi vazifalar haqida hisobot yuboradi
 *   4. Agar kompyuter o'sha vaqtda o'chiq bo'lsa — yoqilganda yuboradi
 *      (kuniga 1 marta cheklov bor)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const nodemailer = require('nodemailer');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = parseInt(process.env.PORT || '5555', 10);
const SEND_HOUR = parseInt(process.env.SEND_HOUR || '21', 10);
const SEND_NOW_MODE = process.argv.includes('--send-now');
const VERIFY_MODE = process.argv.includes('--verify');
const DISABLE_LOCAL_CRON = process.env.DISABLE_LOCAL_CRON === 'true';
const AUTO_PUSH = process.env.AUTO_PUSH !== 'false';
const VERIFY_INTERVAL_MIN = parseInt(process.env.VERIFY_INTERVAL_MIN || '30', 10);

const HTML_FILE = path.join(__dirname, 'index.html');
const DATA_FILE = path.join(__dirname, 'roadmap-data.json');

// Persistent storage path — Railway/Render volume yoki mahalliy
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SENT_FILE = path.join(DATA_DIR, 'last-sent.json');

const ROADMAP = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));

// --- Holat boshqaruvi -------------------------------------------------------
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (e) {
    const fresh = { startDate: todayStr(), done: {} };
    fs.writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  if (AUTO_PUSH && !SEND_NOW_MODE) schedulePush();
}

// state.json ni GitHub repo'ga avtomatik push (debounced 5s)
const { execSync } = require('child_process');
let _pushTimer = null;
function schedulePush() {
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    try {
      execSync('git add state.json', { cwd: __dirname, stdio: 'pipe' });
      const diff = execSync('git diff --cached --name-only', { cwd: __dirname }).toString().trim();
      if (!diff) return;
      execSync(
        'git -c user.email=tracker@local -c user.name="JURNAL Tracker" commit -m "state: auto-update"',
        { cwd: __dirname, stdio: 'pipe' }
      );
      execSync('git push -q', { cwd: __dirname, stdio: 'pipe' });
      console.log('[git] state.json GitHub\'ga sinxronlandi');
    } catch (e) {
      // jim — internet yo'q yoki credential muammosi
    }
  }, 5000);
}

function dayDiff(fromStr) {
  const [y, m, d] = fromStr.split('-').map(Number);
  const from = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - from) / 86400000);
}

function getCurrentDay(state) {
  return Math.min(Math.max(dayDiff(state.startDate) + 1, 1), 21);
}

function getDayInfo(dayNum) {
  for (const phase of ROADMAP) {
    for (const d of phase.days) {
      if (d.day === dayNum) return { ...d, phase: phase.phase, icon: phase.icon };
    }
  }
  return null;
}

// --- Avtomatik DB tekshiruvi -----------------------------------------------
// Bazada iz qoldiradigan vazifalarni haqiqatan tekshiradi (docker exec psql).
// Sof qo'lda test vazifalari bu yerda yo'q — ular "qo'lda tasdiqlash" bo'lib qoladi.
const CHECKS = {
  'd1t0': { label: "Ro'yxatdan o'tgan foydalanuvchi (admin'dan tashqari)",
    sql: "SELECT COUNT(*) FROM users WHERE email <> 'admin@journal.uz'", pass: n => n >= 1 },
  'd1t2': { label: "Email tasdiqlangan foydalanuvchi",
    sql: "SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL AND email <> 'admin@journal.uz'", pass: n => n >= 1 },
  'd2t0': { label: "Yaratilgan maqola",
    sql: "SELECT COUNT(*) FROM articles", pass: n => n >= 1 },
  'd2t1': { label: "Yuklangan fayl",
    sql: "SELECT COUNT(*) FROM article_files", pass: n => n >= 1 },
  'd2t3': { label: "Submit qilingan maqola (DRAFT emas)",
    sql: "SELECT COUNT(*) FROM articles WHERE status <> 'DRAFT'", pass: n => n >= 1 },
  'd3t2': { label: "Taqrizchi taklifi yuborilgan",
    sql: "SELECT COUNT(*) FROM review_invitations", pass: n => n >= 1 },
  'd3t3': { label: "Editor qarori berilgan maqola",
    sql: "SELECT COUNT(*) FROM articles WHERE status IN ('ACCEPTED','REJECTED','REVISION_REQUESTED','IN_PRODUCTION','PUBLISHED')", pass: n => n >= 1 },
  'd4t1': { label: "To'ldirilgan taqriz",
    sql: "SELECT COUNT(*) FROM article_reviews", pass: n => n >= 1 },
  'd5t0': { label: "To'lov so'rovi yaratilgan",
    sql: "SELECT COUNT(*) FROM payments", pass: n => n >= 1 },
  'd5t3': { label: "IN_PRODUCTION yoki PUBLISHED maqola",
    sql: "SELECT COUNT(*) FROM articles WHERE status IN ('IN_PRODUCTION','PUBLISHED')", pass: n => n >= 1 },
  'd6t0': { label: "Yaratilgan jurnal",
    sql: "SELECT COUNT(*) FROM journals", pass: n => n >= 1 },
  'd6t1': { label: "APC tarif sozlangan",
    sql: "SELECT COUNT(*) FROM apc_tariffs", pass: n => n >= 1 },
  'd13t1': { label: "Tahririyat a'zolari kiritilgan",
    sql: "SELECT COUNT(*) FROM editorial_board", pass: n => n >= 1 },
};

// Bazani tekshirib natijani qaytaradi. DB ulanmasa null (eski natija saqlanadi).
function runVerification() {
  const container = process.env.PG_CONTAINER || 'journal-postgres';
  const pgUser = process.env.PG_USER || 'journal';
  const pgDb = process.env.PG_DB || 'journal';
  const results = {};
  for (const [taskId, check] of Object.entries(CHECKS)) {
    try {
      const out = execSync(
        `docker exec ${container} psql -U ${pgUser} -d ${pgDb} -t -A -c "${check.sql}"`,
        { stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString().trim();
      const n = parseInt(out, 10);
      if (Number.isNaN(n)) throw new Error('DB javobi son emas: ' + out);
      results[taskId] = { done: check.pass(n), value: n, label: check.label };
    } catch (e) {
      // DB yoki Docker ishlamayapti — tekshiruvni to'xtatamiz, eski natija qoladi
      return null;
    }
  }
  return results;
}

// Tekshiruvni ishga tushirib state'ni yangilaydi (passed vazifalarni avtomatik belgilaydi).
function applyVerification() {
  const results = runVerification();
  if (!results) return { ok: false };
  const state = loadState();
  state.verified = { results, checkedAt: new Date().toISOString() };
  let auto = 0;
  for (const [taskId, r] of Object.entries(results)) {
    if (r.done && !state.done[taskId]) {
      state.done[taskId] = new Date().toISOString();
      auto++;
    }
  }
  saveState(state);
  const passed = Object.values(results).filter(r => r.done).length;
  console.log(`[verify] DB tekshirildi: ${passed}/${Object.keys(results).length} vazifa bajarilgan` +
    (auto ? ` (${auto} tasi avtomatik belgilandi)` : ''));
  return { ok: true, results };
}

// --- Email yuborish ---------------------------------------------------------
function buildReport(state, dayNum) {
  const day = getDayInfo(dayNum);
  if (!day) return null;
  const done = [], dbFailed = [], manual = [];
  day.tasks.forEach((t, i) => {
    const id = 'd' + dayNum + 't' + i;
    if (state.done[id]) { done.push(t); return; }
    if (CHECKS[id]) dbFailed.push(t);   // tekshirilishi mumkin, lekin DB'da iz yo'q
    else manual.push(t);                 // sof qo'lda test
  });

  // Orqada qolgan vazifalarni hisoblash
  const overdue = [];
  for (let d = 1; d < dayNum; d++) {
    const di = getDayInfo(d);
    if (!di) continue;
    di.tasks.forEach((t, i) => {
      if (!state.done['d' + d + 't' + i]) overdue.push({ task: t, day: d });
    });
  }

  const verifiedAt = state.verified && state.verified.checkedAt;
  return { day, done, dbFailed, manual, undone: [...dbFailed, ...manual], overdue, verifiedAt };
}

function buildEmailHtml(report, dayNum) {
  const { day, done, dbFailed, manual, undone, overdue, verifiedAt } = report;
  const total = day.tasks.length;
  const pct = Math.round((done.length / total) * 100);
  const allDone = undone.length === 0;
  const status = allDone
    ? '🎉 Barcha vazifalar bajarildi! Zo\'r ketyapsiz!'
    : '⚠️ ' + undone.length + ' ta vazifa bajarilmadi';

  const listItems = (arr) => arr.map(t => '<li style="margin:6px 0;">' + escapeHtml(t) + '</li>').join('');

  const verifiedNote = verifiedAt
    ? 'Baza oxirgi marta tekshirildi: ' + new Date(verifiedAt).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })
    : 'Baza tekshiruvi hali ishlamadi (Docker/DB o\'chiq bo\'lishi mumkin)';

  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#222;padding:20px;">
      <div style="background:linear-gradient(135deg,#7c6cf0,#a99cff);padding:28px;border-radius:14px;color:#fff;">
        <div style="font-size:13px;opacity:.9;">${escapeHtml(day.icon)} ${escapeHtml(day.phase)}</div>
        <h1 style="margin:8px 0 4px;font-size:22px;">${dayNum}-kun · ${escapeHtml(day.title)}</h1>
        <div style="font-size:14px;opacity:.95;">${status}</div>
        <div style="background:rgba(255,255,255,.25);height:8px;border-radius:99px;margin-top:14px;overflow:hidden;">
          <div style="background:#fff;height:100%;width:${pct}%;"></div>
        </div>
        <div style="margin-top:8px;font-size:13px;">${done.length} / ${total} vazifa (${pct}%)</div>
      </div>

      ${done.length ? `
      <h3 style="color:#22a06b;margin-top:24px;font-size:16px;">✅ Bajarildi (${done.length})</h3>
      <ul style="line-height:1.5;padding-left:22px;">${listItems(done)}</ul>` : ''}

      ${dbFailed.length ? `
      <h3 style="color:#e74c3c;margin-top:24px;font-size:16px;">❌ Bazada tekshirildi — bajarilmadi (${dbFailed.length})</h3>
      <p style="color:#888;font-size:12px;margin:0 0 6px;">Bu vazifalar bazada iz qoldirishi kerak edi, lekin topilmadi:</p>
      <ul style="line-height:1.5;padding-left:22px;">${listItems(dbFailed)}</ul>` : ''}

      ${manual.length ? `
      <h3 style="color:#c08a1e;margin-top:24px;font-size:16px;">✋ Qo'lda tasdiqlash kerak (${manual.length})</h3>
      <p style="color:#888;font-size:12px;margin:0 0 6px;">Bularni avtomatik tekshirib bo'lmaydi — o'zingiz belgilang:</p>
      <ul style="line-height:1.5;padding-left:22px;">${listItems(manual)}</ul>` : ''}

      ${overdue.length ? `
      <h3 style="color:#888;margin-top:28px;font-size:14px;">⏰ Umumiy orqada qolgan: ${overdue.length} ta</h3>` : ''}

      <hr style="border:none;border-top:1px solid #eee;margin:28px 0 16px;">
      <p style="color:#888;font-size:11px;text-align:center;">
        JURNAL Roadmap Tracker · Avtomatik hisobot<br/>
        🤖 ${verifiedNote}<br/>
        ${new Date().toLocaleString('uz-UZ', { dateStyle: 'full', timeStyle: 'short' })}
      </p>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function sendDailyEmail() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('⚠️ Email yuborilmadi: .env da GMAIL_USER yoki GMAIL_APP_PASSWORD yo\'q');
    return false;
  }

  const state = loadState();
  const dayNum = getCurrentDay(state);
  const report = buildReport(state, dayNum);
  if (!report) {
    console.log('Reja tugagan, email yuborilmadi');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const subject = `📋 ${dayNum}-kun hisobot — ${report.done.length}/${report.day.tasks.length} bajarildi`;
  const to = process.env.REPORT_TO || process.env.GMAIL_USER;

  await transporter.sendMail({
    from: `"JURNAL Tracker" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html: buildEmailHtml(report, dayNum),
  });

  console.log(`[${new Date().toLocaleString()}] ✉️ Email yuborildi → ${to}: ${subject}`);
  return true;
}

// --- Avtomatik jadval -------------------------------------------------------
function loadSent() {
  try { return JSON.parse(fs.readFileSync(SENT_FILE, 'utf-8')); }
  catch (e) { return { lastSentDate: null }; }
}

function markSent() {
  fs.writeFileSync(SENT_FILE, JSON.stringify({
    lastSentDate: todayStr(),
    at: new Date().toISOString(),
  }, null, 2));
}

function shouldSendNow() {
  const now = new Date();
  if (now.getHours() < SEND_HOUR) return false;
  const sent = loadSent();
  return sent.lastSentDate !== todayStr();
}

async function tickScheduler() {
  if (!shouldSendNow()) return;
  try {
    const ok = await sendDailyEmail();
    if (ok) markSent();
  } catch (e) {
    console.error('Email yuborishda xato:', e.message);
  }
}

// --- HTTP server ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  try {
    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(HTML_FILE));
      return;
    }

    if (parsed.pathname === '/api/data' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(fs.readFileSync(DATA_FILE));
      return;
    }

    if (parsed.pathname === '/api/state' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(loadState()));
      return;
    }

    if (parsed.pathname === '/api/state' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          saveState(JSON.parse(body));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (parsed.pathname === '/api/verify' && req.method === 'POST') {
      const r = applyVerification();
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = r.ok ? 200 : 503;
      res.end(JSON.stringify(r.ok ? { ok: true, results: r.results } : { ok: false, error: 'Baza ulanmadi (Docker/DB o\'chiq?)' }));
      return;
    }

    if (parsed.pathname === '/api/send-now' && req.method === 'POST') {
      try {
        const ok = await sendDailyEmail();
        if (ok) markSent();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  } catch (e) {
    res.statusCode = 500;
    res.end('Server error: ' + e.message);
  }
});

// --- CLI mode: --verify (faqat bazani tekshiradi va chiqadi) ---------------
if (VERIFY_MODE) {
  const r = applyVerification();
  process.exit(r.ok ? 0 : 1);
}
// --- CLI mode: --send-now (GitHub Actions ishlatadi) ----------------------
else if (SEND_NOW_MODE) {
  (async () => {
    try {
      const ok = await sendDailyEmail();
      process.exit(ok ? 0 : 1);
    } catch (e) {
      console.error('Email yuborishda xato:', e.message);
      process.exit(2);
    }
  })();
} else {
  server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║          JURNAL Roadmap Tracker                    ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log('');
    console.log('  📋 UI:           http://localhost:' + PORT);
    if (DISABLE_LOCAL_CRON) {
      console.log('  📧 Email:        GitHub Actions orqali yuboriladi');
    } else {
      console.log('  📧 Email vaqti:  har kuni soat ' + SEND_HOUR + ':00');
      console.log('  📨 Email manzil: ' + (process.env.REPORT_TO || process.env.GMAIL_USER || '(.env to\'ldirilmagan)'));
    }
    if (AUTO_PUSH) console.log('  🔄 Auto-sync:    state.json GitHub\'ga avtomatik push');
    console.log('  🤖 DB tekshiruvi: har ' + VERIFY_INTERVAL_MIN + ' daqiqada');
    console.log('');
    console.log('  Yopish: Ctrl+C');
    console.log('');
  });

  if (!DISABLE_LOCAL_CRON) {
    setInterval(tickScheduler, 5 * 60 * 1000);
    tickScheduler();
  }

  // Davriy baza tekshiruvi — bajarilgan vazifalarni avtomatik aniqlaydi
  setInterval(applyVerification, VERIFY_INTERVAL_MIN * 60 * 1000);
  applyVerification();
}
