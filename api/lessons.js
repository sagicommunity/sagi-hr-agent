// Vercel Serverless Function — правки контента учебных модулей (lessons.js) поверх git-файла,
// 2026-08-24, по указанию Sagi: хочет сам смотреть и редактировать модули как руководитель,
// без пересборки/деплоя на каждую правку. lessons.js (basic+adv, 20 модулей) остаётся исходным
// набором по умолчанию; правки хранятся отдельно в Redis HASH hr:lessons (field=moduleId,
// value=JSON {title,desc,content,quiz,updatedAt}) и НАКЛАДЫВАЮТСЯ поверх дефолта на клиенте —
// и в кабинете стажёра (index.html), и в просмотрщике (training-preview.html). Так правки сразу
// видят и стажёры, и Sagi, без git-коммита.
// POST { action, ... }
// actions:
//   public { }                                  -> { ok, overrides:{id:{title,desc,content,quiz}} } — без пароля, для рендера
//   list   { password }                         -> то же самое, для экрана редактора (тоже сверяем пароль, хоть контент и не секретный)
//   save   { password, id, title, desc, content, quiz } -> { ok, item } — сохраняет правку одного модуля
//   reset  { password, id }                     -> { ok } — удаляет правку, модуль возвращается к дефолту из lessons.js

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HKEY = 'hr:lessons';

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

// Канонический список id модулей (basic + adv, см. lessons.js) — правку разрешаем только на
// известный id, чтобы не насоздавать мусорных полей в hr:lessons.
const VALID_IDS = new Set([
  'intro', 'problem', 'bonuses', 'communication', 'crm', 'app', 'call-script', 'meeting-script', 'cases', 'final',
  'product-competitive', 'product-features', 'objections-hard', 'objections-followup',
  'b2b-prospecting', 'b2b-pipeline', 'b2b-closing', 'cases-wins', 'cases-mistakes',
  'emotional-triggers',
]);

async function loadOverrides() {
  const raw = await redis(['HGETALL', HKEY]);
  const out = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      try { out[raw[i]] = JSON.parse(raw[i + 1]); } catch { /* skip broken record */ }
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!R_URL || !R_TOK) { res.status(500).json({ error: 'Хранилище не подключено' }); return; }

    const action = body?.action;

    if (action === 'public') {
      const overrides = await loadOverrides();
      res.status(200).json({ ok: true, overrides });
      return;
    }

    const PASS = process.env.DASHBOARD_PASSWORD || '';
    const passOk = !!PASS && (body?.password || '') === PASS;

    if (action === 'list') {
      if (!passOk) { res.status(403).json({ error: 'Неверный пароль' }); return; }
      const overrides = await loadOverrides();
      res.status(200).json({ ok: true, overrides });
      return;
    }

    if (action === 'save') {
      if (!passOk) { res.status(403).json({ error: 'Неверный пароль' }); return; }
      const id = (body?.id || '').toString().trim();
      if (!VALID_IDS.has(id)) { res.status(400).json({ error: 'Неизвестный модуль' }); return; }
      const title = (body?.title || '').toString().slice(0, 200).trim();
      const desc = (body?.desc || '').toString().slice(0, 400).trim();
      const content = (body?.content || '').toString().slice(0, 60000);
      let quiz = body?.quiz;
      if (!Array.isArray(quiz)) quiz = [];
      quiz = quiz
        .map(q => ({
          q: (q?.q || '').toString().slice(0, 500).trim(),
          options: Array.isArray(q?.options) ? q.options.map(o => (o || '').toString().slice(0, 300).trim()).filter(Boolean) : [],
          correct: Number.isInteger(q?.correct) ? q.correct : 0,
        }))
        .filter(q => q.q && q.options.length >= 2);
      if (!title) { res.status(400).json({ error: 'Нужен заголовок' }); return; }

      const item = { title, desc, content, quiz, updatedAt: Date.now() };
      await redis(['HSET', HKEY, id, JSON.stringify(item)]);
      res.status(200).json({ ok: true, item });
      return;
    }

    if (action === 'reset') {
      if (!passOk) { res.status(403).json({ error: 'Неверный пароль' }); return; }
      const id = (body?.id || '').toString().trim();
      if (!VALID_IDS.has(id)) { res.status(400).json({ error: 'Неизвестный модуль' }); return; }
      await redis(['HDEL', HKEY, id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
