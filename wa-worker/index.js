'use strict';
/**
 * HR WhatsApp worker — «серый» (неофициальный) транспорт через Baileys.
 *
 * Зачем отдельный процесс: HR-приложение живёт на Vercel (serverless), а Baileys
 * держит постоянное WebSocket-соединение, поэтому его нельзя держать внутри функции.
 * Этот маленький сервис крутится постоянно (на VPS, в k8s или на Mac), один раз
 * привязывается как «связанное устройство» к WhatsApp-номеру, а HR-функции
 * вызывают его по HTTP (см. api/_wa.js, env WA_GREY_URL + WA_GREY_SECRET).
 *
 * РИСКИ (это неофициальный протокол): массовые рассылки нарушают правила WhatsApp,
 * номер могут временно ограничить или заблокировать. Поэтому — отдельный рабочий
 * номер (не личный), умеренный темп, и «ответьте стоп» в текстах.
 *
 * ENV:
 *   WA_WORKER_PORT   — порт (по умолчанию 8790)
 *   WA_WORKER_SECRET — общий секрет, тем же значением должен быть WA_GREY_SECRET в Vercel
 *   WA_AUTH_DIR      — папка для сессии (по умолчанию ./auth) — НЕ коммитить, там доступ к переписке
 *
 * Запуск:
 *   npm install
 *   WA_WORKER_SECRET=длинная-строка node index.js
 *   → в консоли появится QR (и на GET /qr), отсканируй его в WhatsApp на телефоне.
 *
 * HTTP:
 *   GET  /status              → { connected, number, hasQr, lastError }
 *   GET  /qr                  → PNG с QR (для привязки номера) или 204, если не нужно
 *   POST /send {to,text}      → отправить сообщение (заголовок x-wa-secret)
 *   POST /logout              → отвязать номер и начать заново
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
fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
const rlog = (...a) => console.log(new Date().toISOString(), ...a);

let sock = null;
let starting = false;
let connected = false;
let meNumber = '';
let qrDataUrl = '';
let lastError = '';
let ready = false;

function digits(s) { return String(s || '').replace(/\D/g, ''); }

async function start() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger, browser: ['Sagi HR', 'Chrome', '1.0.0'] });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr).catch(() => '');
        rlog('QR готов — открой /qr или отсканируй WhatsApp → Связанные устройства');
      }
      if (connection === 'open') {
        connected = true; qrDataUrl = '';
        meNumber = (sock.user && sock.user.id ? String(sock.user.id).split(':')[0].split('@')[0] : '');
        rlog('подключено, номер', meNumber);
      } else if (connection === 'close') {
        connected = false;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        if (code === DisconnectReason.loggedOut) {
          lastError = 'logged out — нужен новый QR (POST /logout или удали папку auth)';
          rlog('номер отвязан. Сканируй QR заново.');
        } else {
          rlog('соединение закрыто, переподключаюсь…', code || '');
          setTimeout(() => { starting = false; start(); }, 3000);
        }
      }
    });
    ready = true;
  } catch (e) {
    lastError = e.message;
    rlog('ошибка запуска:', e.message);
  } finally {
    starting = false;
  }
}

async function sendText(to, text) {
  const d = digits(to);
  if (!d) throw new Error('нет номера');
  if (!sock || !connected) throw new Error('WhatsApp не подключён');
  const jid = d + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: String(text || '') });
  return { ok: true };
}

const app = express();
app.use(express.json({ limit: '200kb' }));

function checkSecret(req) {
  if (!SECRET) return false;
  const got = req.headers['x-wa-secret'] || (req.body && req.body.secret) || '';
  return got && got === SECRET;
}

app.get('/status', (req, res) => res.json({ connected, number: meNumber, hasQr: !!qrDataUrl, ready, lastError }));
app.get('/qr', async (req, res) => {
  if (!qrDataUrl) return res.status(204).end();
  const b64 = qrDataUrl.split(',')[1] || '';
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(b64, 'base64'));
});
app.post('/send', async (req, res) => {
  if (!checkSecret(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const { to, text } = req.body || {};
    const r = await sendText(to, text);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/logout', async (req, res) => {
  if (!checkSecret(req)) return res.status(403).json({ error: 'forbidden' });
  try { if (sock) await sock.logout(); } catch (e) {}
  connected = false; meNumber = ''; qrDataUrl = '';
  setTimeout(() => { starting = false; start(); }, 1500);
  res.json({ ok: true });
});

app.listen(PORT, () => rlog(`HR WA worker слушает на :${PORT} (папка сессии ${AUTH_DIR})`));
start();
