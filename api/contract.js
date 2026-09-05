// Vercel Serverless Function — договор ГПХ стажёра (см. onboarding.html/api/onboarding.js).
// 2026-09-05, по указанию Sagi: договор нужно (1) дать изучить прямо в чек-листе адаптации,
// (2) дать заполнить поля ФИО/адрес/ИИН/документ/телефон (БЕЗ банковских реквизитов),
// (3) хранить подписанный экземпляр в «личном деле» стажёра. Реализовано как отдельный
// Redis HASH (hr:contract, field=id стажёра, тот же id, что в hr:onboarding), чтобы
// api/onboarding.js мог на лету проверять «подписан или нет» для пункта чек-листа common6.
// POST { action, ... }
// actions:
//   get   { id }                       -> { ok, item }  (item.signed=false, если не подписан)
//   save  { id, role, fields }         -> { ok, item }  (подписание — необратимо, данные Сторона больше не меняет)
//   list  { password }  (DASHBOARD_PASSWORD) -> { ok, items:[...] } — для Sagi

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HKEY = 'hr:contract';
const ONBOARDING_HKEY = 'hr:onboarding';
const CONTRACT_VERSION = '2026-09-05';

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.result;
}

async function loadOnboarding(id) {
  const raw = await redis(['HGET', ONBOARDING_HKEY, id]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function loadContract(id) {
  const raw = await redis(['HGET', HKEY, id]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function loadAllContracts() {
  const flat = await redis(['HGETALL', HKEY]);
  if (!Array.isArray(flat)) return [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push(JSON.parse(flat[i + 1])); } catch (e) {}
  }
  return out;
}

async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (e) {}
}

const ROLE_LABEL = { sales: 'Менеджер по продажам', success: 'Работа с текущими клиентами', support: 'Техподдержка' };

// Явно НЕ принимаем никаких банковских полей, даже если клиент их пришлёт.
const ALLOWED_FIELDS = ['fio', 'dob', 'iin', 'addr', 'docnum', 'docdate', 'docauth', 'phone', 'email'];

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!R_URL || !R_TOK) { res.status(500).json({ error: 'Хранилище не подключено' }); return; }

    const action = body?.action;

    if (action === 'get') {
      const id = (body?.id || '').toString().trim();
      if (!id) { res.status(400).json({ error: 'Нет id' }); return; }
      const existing = await loadContract(id);
      if (existing) {
        res.status(200).json({ ok: true, item: { ...existing, signed: true } });
        return;
      }
      const onboarding = await loadOnboarding(id);
      res.status(200).json({
        ok: true,
        item: { id, signed: false, role: onboarding?.role || '', name: onboarding?.name || '' },
      });
      return;
    }

    if (action === 'save') {
      const id = (body?.id || '').toString().trim();
      if (!id) { res.status(400).json({ error: 'Нет id' }); return; }

      // Подписание необратимо: если уже подписан — просто возвращаем существующую запись,
      // повторная отправка формы ничего не перезатирает (личное дело нельзя подделать задним числом).
      const already = await loadContract(id);
      if (already) { res.status(200).json({ ok: true, item: { ...already, signed: true } }); return; }

      const onboarding = await loadOnboarding(id);
      if (!onboarding) { res.status(400).json({ error: 'Не найден чек-лист адаптации для этого id — сначала начните его на onboarding.html' }); return; }

      const fieldsIn = (body?.fields && typeof body.fields === 'object') ? body.fields : {};
      const fields = {};
      for (const k of ALLOWED_FIELDS) {
        const v = (fieldsIn[k] || '').toString().slice(0, 300).trim();
        if (v) fields[k] = v;
      }
      if (!fields.fio || !fields.iin || !fields.addr || !fields.phone) {
        res.status(400).json({ error: 'Заполните хотя бы ФИО, ИИН, адрес и телефон' }); return;
      }
      if (!/^\d{12}$/.test(fields.iin)) {
        res.status(400).json({ error: 'ИИН должен состоять из 12 цифр' }); return;
      }

      const item = {
        id,
        role: onboarding.role || '',
        fields,
        contractVersion: CONTRACT_VERSION,
        signedAt: Date.now(),
      };
      await redis(['HSET', HKEY, id, JSON.stringify(item)]);

      notifyTelegram(
        `📄 Договор ГПХ подписан — Sagi\n\n` +
        `👤 ${fields.fio}\n` +
        `🧩 Роль: ${ROLE_LABEL[item.role] || item.role || '—'}\n` +
        `📞 ${fields.phone}\n\n` +
        `Статус: https://hr.sagibonus.com/onboarding-status.html`
      );

      res.status(200).json({ ok: true, item: { ...item, signed: true } });
      return;
    }

    if (action === 'list') {
      const PASS = process.env.DASHBOARD_PASSWORD || '';
      if (!PASS || (body?.password || '') !== PASS) { res.status(403).json({ error: 'Неверный пароль' }); return; }
      const all = await loadAllContracts();
      all.sort((a, b) => (b.signedAt || 0) - (a.signedAt || 0));
      res.status(200).json({ ok: true, items: all, roleLabels: ROLE_LABEL });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
