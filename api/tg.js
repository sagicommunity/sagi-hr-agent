// Vercel Serverless Function — Telegram-бот найма кандидатов (Sagi Careers).
// Вебхук: ведёт кандидата по диалогу, скринит и кладёт в Пайплайн (Redis hr:candidates), сигналит РОПу.
// Setup: GET /api/tg?action=setup&key=<DASHBOARD_PASSWORD> — ставит вебхук на самого себя.
// Env: CAREERS_BOT_TOKEN (бот кандидатов), ANTHROPIC_API_KEY, KV_*, TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID (уведомления РОПу).

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CAND_KEY = 'hr:candidates';
const BOT = process.env.CAREERS_BOT_TOKEN || '';
const SITE = 'https://hr.sagibonus.com';

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) return null;
  return (await r.json()).result;
}
async function getState(chat) { try { const s = await redis(['GET', 'hr:tg:' + chat]); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
async function setState(chat, st) { try { await redis(['SET', 'hr:tg:' + chat, JSON.stringify(st), 'EX', 172800]); } catch (e) {} }

async function tgSend(chat, text, extra) {
  if (!BOT) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true, ...(extra || {}) }),
    });
  } catch (e) {}
}

function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function waMessage(name) { const n = (name || '').trim().split(/\s+/)[0] || ''; return `Здравствуйте${n ? ', ' + n : ''}! 👋 Меня зовут [ваше имя], я из Sagi. Мы расширяем отдел продаж и заинтересовались вашим опытом. Удобно ответить на пару вопросов?`; }

const SCREEN_SYS = `Ты — HR-скринер Sagi (loyalty-платформа для B2B МСБ). Оцениваешь кандидата на менеджера по ХОЛОДНЫМ продажам (аутрич, звонки, поиск ЛПР, работа с возражениями, закрытие на встречу).
Верни ТОЛЬКО валидный JSON без markdown:
{"score": <0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения>"}`;

async function screen(name, fullText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let out = { score: null, verdict: 'Резерв', summary: '' };
  if (!apiKey || !fullText) return out;
  try {
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: SCREEN_SYS, messages: [{ role: 'user', content: `Кандидат: ${name}\n\nАнкета и ответы:\n${fullText.slice(0, 7000)}` }] }),
    });
    const ad = await ar.json();
    if (ar.ok) { const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'); const m = txt.match(/\{[\s\S]*\}/); if (m) { const o = JSON.parse(m[0]); out = { score: o.score ?? null, verdict: o.verdict || 'Резерв', summary: o.summary || '' }; } }
  } catch (e) {}
  return out;
}

async function notifyROP(rec) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '', chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  const strong = rec.verdict === 'Брать на интервью' || (typeof rec.score === 'number' && rec.score >= 7);
  if (!strong) return;
  const text = `🔥 Сильный кандидат (Telegram-бот) — Sagi\n\n👤 ${rec.name}\n⭐ ${rec.score != null ? rec.score + '/10' : '—'} · ${rec.verdict}\n📞 ${rec.contact}\n\n${rec.summary || ''}\n\nПайплайн: ${SITE}/pipeline.html`;
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }); } catch (e) {}
}

const Q = {
  name: 'Здравствуйте! 👋 Это бот по найму в Sagi (платформа лояльности для бизнеса).\n\nВакансия: *менеджер по продажам* (холодные продажи — звонки, поиск клиентов, закрытие на встречи).\n\nДавайте познакомимся — как вас зовут? (имя и фамилия)',
  phone: 'Приятно познакомиться! 📞 Оставьте ваш номер телефона / WhatsApp для связи.',
  source: 'Спасибо! Откуда вы узнали о вакансии? (HH, Instagram, по рекомендации и т.п.)',
  resume: 'Отлично. Пришлите ваше резюме — *текстом* или *ссылкой* (hh.kz, LinkedIn). Можно кратко: опыт, достижения, чем занимались.',
  q1: 'Спасибо! Теперь пара вопросов по делу.\n\n1️⃣ Есть ли у вас опыт холодных продаж или звонков? Расскажите коротко.',
  q2: '2️⃣ Какой ваш лучший результат в продажах? (план/цифры/достижения)',
  q3: '3️⃣ Когда готовы приступить и какой формат — офис или удалёнка?',
};

async function finalize(chat, st) {
  await tgSend(chat, 'Спасибо за ответы! ✅ Заявка принята — мы рассмотрим её и свяжемся с вами по указанному контакту. Хорошего дня! 🙌');
  const d = st.data || {};
  const fullText = `Резюме/о себе: ${d.resume || '—'}\n\nОпыт холодных продаж: ${d.q1 || '—'}\nЛучший результат: ${d.q2 || '—'}\nГотовность/формат: ${d.q3 || '—'}`;
  const ev = await screen(d.name || '', fullText);
  const phone = digits(d.phone);
  const rec = {
    id: newId(), name: d.name || 'Из Telegram', contact: d.phone || '', phone,
    source: 'Telegram-бот' + (d.source ? ' (' + d.source + ')' : ''),
    resume: fullText.slice(0, 2000), score: ev.score, verdict: ev.verdict, summary: ev.summary,
    strengths: [], flags: [], stage: 'Новый', waMessage: waMessage(d.name), ts: Date.now(),
  };
  try { await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]); await redis(['LTRIM', CAND_KEY, 0, 1999]); } catch (e) {}
  await notifyROP(rec);
}

export default async function handler(req, res) {
  // ---- setup webhook ----
  if (req.method === 'GET') {
    const action = req.query?.action, key = req.query?.key;
    if (action === 'setup') {
      if ((process.env.DASHBOARD_PASSWORD || '') && key === process.env.DASHBOARD_PASSWORD && BOT) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${BOT}/setWebhook`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: `${SITE}/api/tg`, allowed_updates: ['message'] }),
          });
          const d = await r.json();
          res.status(200).json({ setup: true, telegram: d });
        } catch (e) { res.status(500).json({ error: e.message }); }
        return;
      }
      res.status(403).json({ error: 'Неверный ключ или нет CAREERS_BOT_TOKEN' });
      return;
    }
    res.status(200).send('Sagi careers bot is running');
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
    const msg = body?.message;
    if (!msg || !msg.chat) { res.status(200).json({ ok: true }); return; }
    const chat = msg.chat.id;
    let text = (msg.text || '').trim();
    if (!text && msg.contact && msg.contact.phone_number) text = msg.contact.phone_number;

    if (text === '/start' || text === '/restart') {
      await setState(chat, { step: 'name', data: {} });
      await tgSend(chat, Q.name, { parse_mode: 'Markdown' });
      res.status(200).json({ ok: true }); return;
    }

    let st = await getState(chat);
    if (!st) { await setState(chat, { step: 'name', data: {} }); await tgSend(chat, Q.name, { parse_mode: 'Markdown' }); res.status(200).json({ ok: true }); return; }
    if (!text) { res.status(200).json({ ok: true }); return; }
    st.data = st.data || {};

    const order = ['name', 'phone', 'source', 'resume', 'q1', 'q2', 'q3'];
    const i = order.indexOf(st.step);
    if (st.step === 'done') {
      await tgSend(chat, 'Ваша заявка уже принята ✅ Если хотите заполнить заново — отправьте /start.');
      res.status(200).json({ ok: true }); return;
    }
    // сохраняем ответ на текущий шаг
    st.data[st.step] = text.slice(0, 4000);

    if (st.step === 'q3') {
      st.step = 'done'; await setState(chat, st);
      await finalize(chat, st);
      res.status(200).json({ ok: true }); return;
    }
    const next = order[i + 1];
    st.step = next; await setState(chat, st);
    await tgSend(chat, Q[next], next === 'resume' || next === 'q1' ? { parse_mode: 'Markdown' } : undefined);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true }); // Telegram всегда 200
  }
}
