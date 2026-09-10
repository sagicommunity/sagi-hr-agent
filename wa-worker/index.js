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
const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, 'auth');
const DATA_DIR = process.env.WA_DATA_DIR || __dirname;
const MIN_INTERVAL_MS = Math.max(60000, parseInt(process.env.WA_MIN_INTERVAL_MS || '120000', 10) || 120000);
const DAILY_CAP = Math.max(0, parseInt(process.env.WA_DAILY_CAP || '0', 10) || 0);

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const STOP_FILE = path.join(DATA_DIR, 'stoplist.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const REPLIES_FILE = path.join(DATA_DIR, 'replies.jsonl');

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

const digits = (s) => String(s || '').replace(/\D/g, '');
const todayAlmaty = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
function persistQueue() { save(QUEUE_FILE, queue); }
function persistStop() { save(STOP_FILE, [...stoplist]); }
function persistStats() { save(STATS_FILE, stats); }
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
      } else if (connection === 'close') {
        connected = false;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        if (code === DisconnectReason.loggedOut) {
          lastError = 'logged out — нужен новый QR';
          rlog('номер отвязан. Сканируй QR заново.');
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
  return { ok: true, to: d };
}

// ── Очередь: одно сообщение раз в MIN_INTERVAL_MS, стоп-лист, дневной лимит ──
async function tick() {
  if (sending || paused || !connected) return;
  if (!queue.length) return;
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
      rlog('ошибка отправки, вернул в очередь:', e.message);
    }
  } finally {
    sending = false;
  }
}
setInterval(() => tick().catch(() => {}), 10000);

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
  queue: { pending: queue.length, sentToday: stats.sentToday, sentTotal: stats.sentTotal, stopped: stoplist.size },
}));

app.get('/', (req, res) => {
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

app.get('/queue', (req, res) => res.json({ pending: queue.length, paused, minIntervalMs: MIN_INTERVAL_MS, sentToday: stats.sentToday, sentTotal: stats.sentTotal, stopped: stoplist.size, items: queue.slice(0, 20) }));
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
