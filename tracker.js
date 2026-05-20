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

// --- Email yuborish ---------------------------------------------------------
function buildReport(state, dayNum) {
  const day = getDayInfo(dayNum);
  if (!day) return null;
  const done = [], undone = [];
  day.tasks.forEach((t, i) => {
    if (state.done['d' + dayNum + 't' + i]) done.push(t);
    else undone.push(t);
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

  return { day, done, undone, overdue };
}

function buildEmailHtml(report, dayNum) {
  const { day, done, undone, overdue } = report;
  const total = day.tasks.length;
  const pct = Math.round((done.length / total) * 100);
  const allDone = undone.length === 0;
  const status = allDone
    ? '🎉 Barcha vazifalar bajarildi! Zo\'r ketyapsiz!'
    : '⚠️ ' + undone.length + ' ta vazifa bajarilmadi';

  const listItems = (arr) => arr.map(t => '<li style="margin:6px 0;">' + escapeHtml(t) + '</li>').join('');

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

      ${undone.length ? `
      <h3 style="color:#e74c3c;margin-top:24px;font-size:16px;">❌ Bajarilmadi (${undone.length})</h3>
      <ul style="line-height:1.5;padding-left:22px;">${listItems(undone)}</ul>
      <p style="background:#fff3cd;padding:12px 14px;border-radius:8px;color:#7a5c00;font-size:13px;margin-top:14px;">
        💡 Ertaga bularni "Orqada qolgan" bo'limida ko'rasiz — yopib qo'ying!
      </p>` : ''}

      ${overdue.length ? `
      <h3 style="color:#888;margin-top:28px;font-size:14px;">⏰ Umumiy orqada qolgan: ${overdue.length} ta</h3>
      <div style="background:#fafafa;padding:12px;border-radius:8px;color:#666;font-size:12px;">
        Oldingi kunlardan bajarilmagan vazifalar mavjud. Tracker'da ko'ring:
        <a href="http://localhost:${PORT}" style="color:#7c6cf0;">http://localhost:${PORT}</a>
      </div>` : ''}

      <hr style="border:none;border-top:1px solid #eee;margin:28px 0 16px;">
      <p style="color:#888;font-size:11px;text-align:center;">
        JURNAL Roadmap Tracker · Avtomatik hisobot<br/>
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

server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║          JURNAL Roadmap Tracker                    ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  📋 UI:           http://localhost:' + PORT);
  console.log('  📧 Email vaqti:  har kuni soat ' + SEND_HOUR + ':00');
  console.log('  📨 Email manzil: ' + (process.env.REPORT_TO || process.env.GMAIL_USER || '(.env to\'ldirilmagan)'));
  console.log('');
  console.log('  Yopish: Ctrl+C');
  console.log('');
});

// Har 5 daqiqada email vaqtini tekshirish
setInterval(tickScheduler, 5 * 60 * 1000);
tickScheduler();
