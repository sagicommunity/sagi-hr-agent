'use strict';
/**
 * HR WhatsApp worker — «серый» (неофициальный) транспорт через Baileys.
 *
 * Безопасность номера (Sagi, 2026-09-10) — здесь это главное:
 *   - сообщения уходят НЕ массово, а из очереди по одному раз в 2 минуты (настраивается);
 *   - есть стоп-лист — если человек ответил «стоп», ему больше не пишем;
 *   - можно поставить очередь на паузу.
 * Само сообщение HR-приложение формирует как вопрос (см. api/_wa.js), чтобы человек отвечал,
 * а не просто получал рассылку — это и полезнее, и снижает риск ограничения номера.
 *
 * ENV:
 *   WA_WORKER_PORT      — порт (по умолчанию 8790)
 *   WA_WORKER_SECRET    — секрет (тем же значением WA_GREY_SECRET в Vercel)
 *   WA_AUTH_DIR         — папка сессии (по умолчанию ./auth)
 *   WA_MIN_INTERVAL_MS  — пауза между сообщениями (по умолчанию 120000 = 2 минуты)
 *   WA_DAILY_CAP        — максимум сообщений в сутки (по умолчанию 0 = без лимита)
 *
 * HTTP (все изменяющие — с заголовком x-wa-secret):
 *   GET  /                 — страница привязки (QR, обновляется сама)
 *   GET  /status           — { connected, number, queue:{pending,sentToday,sentTotal}, paused, minIntervalMs }
 *   GET  /qr               — PNG с QR
 *   POST /enqueue {to,text}            — поставить в очередь
 *   POST /enqueue {items:[{to,text}]}  — поставить пачкой
 *   GET  /queue            — очередь и статистика
 *   POST /pause /resume    — пауза/продолжить
 *   GET  /stoplist         — список отписавшихся
 *   POST /send {to,text}   — отправить немедленно (только для тестов)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const PORT = parseInt(process.env.WA_WORKER_PORT || '8790', 10);
const SECRET = process.env.WA_WORKER_SECRET || '';
// 2026-09-22: подпись номера, когда их несколько (см. WA_GREY_URL_2/_3 в Vercel) — только для
// удобства в логах/алертах, на работу самого воркера не влияет.
const ACCOUNT_ID = process.env.WA_ACCOUNT_ID || '1';
const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, 'auth');
const DATA_DIR = process.env.WA_DATA_DIR || __dirname;
const MIN_INTERVAL_MS = Math.max(60000, parseInt(process.env.WA_MIN_INTERVAL_MS || '120000', 10) || 120000);
const DAILY_CAP = Math.max(0, parseInt(process.env.WA_DAILY_CAP || '0', 10) || 0);
// Рабочее окно отправки (Sagi, 2026-09-10): ночью не пишем. Время по Алматы (UTC+5, без DST).
// По умолчанию 07:30–22:00; меняется через WA_SEND_START / WA_SEND_END (формат HH:MM).
const SEND_START = /^\d{1,2}:\d{2}$/.test(process.env.WA_SEND_START || '') ? process.env.WA_SEND_START : '07:30';
const SEND_END = /^\d{1,2}:\d{2}$/.test(process.env.WA_SEND_END || '') ? process.env.WA_SEND_END : '22:00';
function mins(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
function almatyNow() { return new Date(Date.now() + 5 * 3600 * 1000); }
function almatyHHMM() { const d = almatyNow(); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
function inSendWindow() {
  const cur = mins(almatyHHMM()), a = mins(SEND_START), b = mins(SEND_END);
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const STOP_FILE = path.join(DATA_DIR, 'stoplist.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const REPLIES_FILE = path.join(DATA_DIR, 'replies.jsonl');
const SENDS_FILE = path.join(DATA_DIR, 'sends.jsonl');

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
const rlog = (...a) => console.log(new Date().toISOString(), ...a);

function load(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; } }
function save(file, val) { try { fs.writeFileSync(file, JSON.stringify(val)); } catch (e) {} }

let queue = load(QUEUE_FILE, []);          // [{ id, to, text, addedAt }]
let stoplist = new Set(load(STOP_FILE, [])); // ['7700...']
let stats = load(STATS_FILE, { sentTotal: 0, sentToday: 0, day: '' }); // day = YYYY-MM-DD (Алматы)
let paused = false;

let sock = null;
let starting = false;
let connected = false;
let meNumber = '';
let qrDataUrl = '';
let lastError = '';
let lastSentAt = 0;
let sending = false;

// ── Алерт в Telegram при обрыве связи (Sagi, 2026-09-15) ──────────────────
// Раньше про обрыв узнавали только зайдя в статус вручную — реальный случай: номер лежал
// отключённым (logged out) больше 2 суток, накопилось 525 сообщений в очереди, никто не заметил,
// потому что ничего никуда не сигналило. Теперь шлём алерт в Telegram сразу при отключении, потом
// повторяем раз в час, пока не переподключится (чтобы точно не пропустили, а не только один раз
// в моменте), и отдельно шлём «снова подключён» с длительностью простоя, когда починили.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const PUBLIC_URL = (process.env.WA_PUBLIC_URL || '').replace(/\/+$/, ''); // например https://wa-hr.sagibonus.com — для ссылки на страницу QR в алерте
let downSince = 0;
let lastDownAlertAt = 0;
const DOWN_ALERT_REPEAT_MS = 60 * 60 * 1000; // повторный алерт не чаще раза в час
const DOWN_ALERT_MIN_DELAY_MS = 10 * 60 * 1000; // первый повтор — не раньше чем через 10 минут простоя (не считая мгновенного алерта на logged out)

async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) { rlog('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — алерт не отправлен:', text.replace(/\n/g, ' | ')); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (e) { rlog('ошибка отправки Telegram-алерта:', e.message); }
}
function reconnectHint() {
  return PUBLIC_URL
    ? `Открой ${PUBLIC_URL}/ и отсканируй новый QR в WhatsApp этого номера (Настройки → Связанные устройства).`
    : `Открой страницу привязки воркера (адрес — там же, где настраивали WA_GREY_URL) и отсканируй новый QR.`;
}
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60), mm = m % 60;
  return h + ' ч' + (mm ? ' ' + mm + ' мин' : '');
}

const digits = (s) => String(s || '').replace(/\D/g, '');
const todayAlmaty = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
function persistQueue() { save(QUEUE_FILE, queue); }
function persistStop() { save(STOP_FILE, [...stoplist]); }
function persistStats() { save(STATS_FILE, stats); }
function logSend(obj) { try { fs.appendFileSync(SENDS_FILE, JSON.stringify(obj) + '\n'); } catch (e) {} }
function readLog(limit) {
  try {
    const lines = fs.readFileSync(SENDS_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
  } catch (e) { return []; }
}
function rollDay() { const d = todayAlmaty(); if (stats.day !== d) { stats.day = d; stats.sentToday = 0; persistStats(); } }

// ── Baileys ──────────────────────────────────────────────
async function start() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger, browser: ['Sagi HR', 'Chrome', '1.0.0'] });
    sock.ev.on('creds.update', saveCreds);

    // Входящие: фиксируем ответы и ловим «стоп».
    sock.ev.on('messages.upsert', async (ev) => {
      try {
        if (!ev || ev.type !== 'notify') return;
        for (const m of (ev.messages || [])) {
          if (!m.message || m.key.fromMe) continue;
          const from = digits((m.key.remoteJid || '').split('@')[0]);
          const txt = (m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text) || '').trim();
          if (!from || !txt) continue;
          try { fs.appendFileSync(REPLIES_FILE, JSON.stringify({ at: new Date().toISOString(), from, text: txt.slice(0, 500) }) + '\n'); } catch (e) {}
          if (/^\s*(стоп|stop|отпис|unsubscribe|не пишите|не надо)\b/i.test(txt)) {
            stoplist.add(from); persistStop(); rlog('отписка:', from);
          }
        }
      } catch (e) {}
    });

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) { qrDataUrl = await QRCode.toDataURL(qr).catch(() => ''); rlog('QR готов — открой /'); }
      if (connection === 'open') {
        connected = true; qrDataUrl = '';
        meNumber = (sock.user && sock.user.id ? String(sock.user.id).split(':')[0].split('@')[0] : '');
        rlog('подключено, номер', meNumber);
        if (downSince) {
          const dur = fmtDur(Date.now() - downSince);
          tgSend(`✅ HR WhatsApp №${ACCOUNT_ID} (${meNumber}) снова подключён.\nБыл отключён: ${dur}.\nВ очереди: ${queue.length} сообщений — рассылка продолжится.`);
          downSince = 0; lastDownAlertAt = 0;
        }
      } else if (connection === 'close') {
        connected = false;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        if (!downSince) downSince = Date.now();
        if (code === DisconnectReason.loggedOut) {
          lastError = 'logged out — нужен новый QR';
          rlog('номер отвязан. Сканируй QR заново.');
          tgSend(`⚠️ HR WhatsApp №${ACCOUNT_ID} отключился — номер отвязан, нужен новый QR.\nВ очереди: ${queue.length} сообщений ждут отправки.\n${reconnectHint()}`);
          lastDownAlertAt = Date.now();
          // 2026-09-22 (Sagi): раньше здесь просто останавливались, и qrDataUrl больше никогда
          // не обновлялся — при следующем вызове start() useMultiFileAuthState() читал те же уже
          // недействительные creds.json, Baileys пытался переподключиться со старой (удалённой на
          // телефоне) сессией и снова падал с тем же logged out, по кругу, без нового QR. Сагi это
          // и словил: «почему я не могу загрузить QR». Теперь при реальном логауте чистим папку
          // сессии и перезапускаемся — Baileys увидит пустое состояние и сразу сгенерирует свежий
          // QR сам, без захода в кластер руками.
          try {
            for (const f of fs.readdirSync(AUTH_DIR)) { try { fs.unlinkSync(path.join(AUTH_DIR, f)); } catch (e2) {} }
            rlog('сессия очищена — жду новый QR');
          } catch (e) { rlog('не удалось очистить сессию:', e.message); }
          setTimeout(() => { starting = false; start(); }, 2000);
        } else {
          rlog('соединение закрыто, переподключаюсь…', code || '');
          setTimeout(() => { starting = false; start(); }, 3000);
        }
      }
    });
  } catch (e) {
    lastError = e.message;
    rlog('ошибка запуска:', e.message);
  } finally {
    starting = false;
  }
}

async function sendNow(to, text) {
  const d = digits(to);
  if (!d) throw new Error('нет номера');
  if (!sock || !connected) throw new Error('WhatsApp не подключён');
  await sock.sendMessage(d + '@s.whatsapp.net', { text: String(text || '') });
  lastSentAt = Date.now();
  rollDay(); stats.sentTotal++; stats.sentToday++; persistStats();
  // 2026-09-22: раньше в лог не писали сам текст сообщения — журнал (/log) показывал только
  // кому/когда/успешно, этого хватало для табличного вида. Для общей переписки в одном экране
  // (/threads, единый чат по всем номерам — просьба Sagi) нужен и текст исходящего тоже.
  logSend({ at: new Date().toISOString(), to: d, ok: true, text: String(text || '') });
  return { ok: true, to: d };
}

// ── Очередь: одно сообщение раз в MIN_INTERVAL_MS, стоп-лист, дневной лимит ──
async function tick() {
  if (sending || paused || !connected) return;
  if (!queue.length) return;
  if (!inSendWindow()) return; // ночью/вне окна не пишем — просто ждём
  if (Date.now() - lastSentAt < MIN_INTERVAL_MS) return;
  rollDay();
  if (DAILY_CAP && stats.sentToday >= DAILY_CAP) return;

  sending = true;
  try {
    const item = queue.shift();
    persistQueue();
    const d = digits(item.to);
    if (!d) { return; }
    if (stoplist.has(d)) { rlog('пропуск (в стоп-листе):', d); return; }
    try {
      await sendNow(d, item.text);
      rlog('отправлено', d, '| в очереди осталось', queue.length);
    } catch (e) {
      // не потеряли сообщение — вернули в начало очереди
      queue.unshift(item); persistQueue();
      logSend({ at: new Date().toISOString(), to: item.to, ok: false, err: e.message, text: String(item.text || '') });
      rlog('ошибка отправки, вернул в очередь:', e.message);
    }
  } finally {
    sending = false;
  }
}
setInterval(() => tick().catch(() => {}), 10000);

// Повторный алерт, пока не переподключится — на случай, если самый первый (при logged out) не
// заметили или соединение отвалилось не по «logged out», а просто перестало восстанавливаться.
setInterval(() => {
  if (connected || !downSince) return;
  const elapsed = Date.now() - downSince;
  if (elapsed < DOWN_ALERT_MIN_DELAY_MS) return;
  if (Date.now() - lastDownAlertAt < DOWN_ALERT_REPEAT_MS) return;
  tgSend(`⚠️ HR WhatsApp №${ACCOUNT_ID} всё ещё отключён (${fmtDur(elapsed)}).\nВ очереди: ${queue.length} сообщений ждут отправки.\n${reconnectHint()}`);
  lastDownAlertAt = Date.now();
}, 5 * 60 * 1000);

// ── HTTP ─────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '500kb' }));
function checkSecret(req) {
  if (!SECRET) return false;
  const got = req.headers['x-wa-secret'] || (req.body && req.body.secret) || '';
  return !!got && got === SECRET;
}

app.get('/status', (req, res) => res.json({
  connected, number: meNumber, hasQr: !!qrDataUrl, ready: true, lastError, paused,
  minIntervalMs: MIN_INTERVAL_MS, dailyCap: DAILY_CAP,
  sendWindow: { start: SEND_START, end: SEND_END, open: inSendWindow(), now: almatyHHMM() },
  queue: { pending: queue.length, sentToday: stats.sentToday, sentTotal: stats.sentTotal, stopped: stoplist.size },
}));

app.get('/health', (req, res) => res.json({ ok: true, connected, number: meNumber }));

app.get('/', (req, res) => {
  if (process.env.WA_DISABLE_QR_PAGE === '1') {
    // В проде страницу привязки наружу не отдаём: QR появляется только при отсутствии сессии,
    // а отсканировавший чужой телефон привязал бы СВОЙ номер к нашему воркеру.
    const q = req.query.secret || req.headers['x-wa-secret'] || '';
    if (!SECRET || q !== SECRET) return res.status(403).send('forbidden');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Sagi HR WhatsApp — привязка</title>
<style>body{background:#111;color:#eee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px}
img{width:340px;height:340px;background:#fff;padding:12px;border-radius:12px}
.ok{color:#19e39a;font-size:20px}.mut{color:#888;font-size:13px;max-width:520px;margin:12px auto}</style></head><body>
<h2>Sagi HR WhatsApp</h2>
<div id="box"><img id="q" src="/qr?t=${Date.now()}"></div>
<div class="mut">WhatsApp на телефоне HR-номера → <b>Настройки → Связанные устройства → Связать устройство</b> → наведи на код. Код обновляется сам.</div>
<script>setInterval(async()=>{try{const s=await (await fetch('/status?t='+Date.now())).json();
if(s.connected){document.getElementById('box').innerHTML='<div class="ok">✅ Номер подключён'+(s.number?(' · '+s.number):'')+'</div>';return;}
document.getElementById('q').src='/qr?t='+Date.now();}catch(e){}},2500);</script></body></html>`);
});

app.get('/qr', async (req, res) => {
  if (process.env.WA_DISABLE_QR_PAGE === '1') {
    const q = req.query.secret || req.headers['x-wa-secret'] || '';
    if (!SECRET || q !== SECRET) return res.status(403).end();
  }
  if (!qrDataUrl) return res.status(204).end();
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(qrDataUrl.split(',')[1] || '', 'base64'));
});

app.post('/enqueue', (req, res) => {
  if (!checkSecret(req)) return res.status(403).json({ error: 'forbidden' });
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : (body.to ? [{ to: body.to, text: body.text }] : []);
  let added = 0;
  for (const it of items) {
    const d = digits(it && it.to);
    if (!d || !it.text) continue;
    queue.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), to: d, text: String(it.text), addedAt: Date.now() });
    added++;
  }
  persistQueue();
  res.json({ ok: true, added, pending: queue.length });
});

app.get('/queue', (req, res) => res.json({ pending: queue.length, paused, minIntervalMs: MIN_INTERVAL_MS, sentToday: stats.sentToday, sentTotal: stats.sentTotal, stopped: stoplist.size, sendWindow: { start: SEND_START, end: SEND_END, open: inSendWindow(), now: almatyHHMM() }, items: queue.slice(0, 20) }));
// Журнал последних отправок: кому, когда, успешно/ошибка. Для админки (через прокси HR).
app.get('/log', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query?.limit, 10) || 100));
  res.json({ connected, number: meNumber, lastError, sentToday: stats.sentToday, sentTotal: stats.sentTotal, pending: queue.length, paused, items: readLog(limit) });
});
// 2026-09-22 (Sagi): «вообще вся переписка должна быть в одном экране» — раньше /log отдавал
// только исходящие (кому/когда/успех), входящие ответы копились отдельно в replies.jsonl и нигде
// наружу не показывались. Здесь склеиваем и то и другое в переписку по каждому контакту
// (сортировка по времени внутри треда), чтобы дашборд мог отрисовать обычный чат. Требует секрет —
// это уже настоящая переписка кандидатов, а не просто статистика, как в открытых /status и /log.
app.get('/threads', (req, res) => {
  if (!checkSecret(req)) return res.status(403).json({ error: 'forbidden' });
  const limit = Math.min(2000, Math.max(1, parseInt(req.query?.limit, 10) || 500));
  const outItems = readLog(limit)
    .filter((x) => x && x.to)
    .map((x) => ({ dir: 'out', at: x.at, text: x.text || '', contact: x.to, ok: x.ok !== false }));
  let inItems = [];
  try {
    inItems = fs.readFileSync(REPLIES_FILE, 'utf8').split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
      .map((x) => ({ dir: 'in', at: x.at, text: x.text || '', contact: x.from }));
  } catch (e) {}
  const byContact = new Map();
  for (const m of [...outItems, ...inItems]) {
    if (!m.contact) continue;
    if (!byContact.has(m.contact)) byContact.set(m.contact, []);
    byContact.get(m.contact).push(m);
  }
  const threads = [...byContact.entries()].map(([contact, messages]) => {
    messages.sort((a, b) => new Date(a.at) - new Date(b.at));
    return { contact, stopped: stoplist.has(contact), messages, lastAt: messages.length ? messages[messages.length - 1].at : '' };
  }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  res.json({ account: ACCOUNT_ID, threads });
});
app.post('/pause', (req, res) => { if (!checkSecret(req)) return res.status(403).json({ error: 'forbidden' }); paused = true; res.json({ ok: true, paused }); });
app.post('/resume', (req, res) => { if (!checkSecret(req)) return res.status(403).json({ error: 'forbidden' }); paused = false; res.json({ ok: true, paused }); });
app.get('/stoplist', (req, res) => res.json({ count: stoplist.size, items: [...stoplist] }));
app.post('/stop', (req, res) => { if (!checkSecret(req)) return res.status(403).json({ error: 'forbidden' }); const d = digits(req.body && req.body.to); if (d) { stoplist.add(d); persistStop(); } res.json({ ok: true, count: stoplist.size }); });

// Немедленная отправка — ТОЛЬКО для тестов, в обычной работе не используется.
app.post('/send', async (req, res) => {
  if (!checkSecret(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await sendNow(req.body && req.body.to, req.body && req.body.text)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => rlog(`HR WA worker слушает на :${PORT} (сессия ${AUTH_DIR}, пауза между сообщениями ${MIN_INTERVAL_MS} мс)`));
start();
