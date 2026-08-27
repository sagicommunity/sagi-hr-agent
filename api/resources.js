// Vercel Serverless Function — правки списка видео-материалов (RESOURCES в onboarding.html)
// поверх git-файла. 2026-08-27, по указанию Sagi: список видео-встреч менеджеров (Катя и
// остальные) быстро разрастается (10-20 свежих записей в месяц, часть — провальные встречи,
// которые он сам разбирает и решает — оставлять как антипример или убрать). Раньше любое
// изменение списка требовало правки onboarding.html и git push — теперь Sagi добавляет/удаляет
// видео сам, без деплоя, так же как уже устроено с lessons.js (см. api/lessons.js — тот же
// паттерн: git-файл = дефолт, правки — отдельно в Redis, накладываются поверх на клиенте).
// HASH hr:resources: field = id пункта чек-листа (например 'sales6'), value = JSON-массив
// [{label,url,tag,tagText}, ...] — ПОЛНАЯ замена списка для этого пункта (проще всего для
// Sagi: добавить/удалить/переставить — просто редактируешь весь список сразу).
// POST { action, ... }
// actions:
//   public { }                          -> { ok, overrides:{key:[...]} } — без пароля, для рендера у всех
//   list   { password }                 -> то же самое, для экрана редактора
//   save   { password, key, items }     -> { ok, items } — сохраняет весь список для одного пункта
//   reset  { password, key }            -> { ok } — удаляет правку, пункт возвращается к дефолту из onboarding.html

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HKEY = 'hr:resources';

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

// Канонический список id пунктов чек-листа (см. ITEMS в onboarding.html / api/onboarding.js) —
// правку разрешаем только на известный id, чтобы не насоздавать мусорных полей в hr:resources.
const VALID_KEYS = new Set([
  'common1', 'common2', 'common3', 'common4', 'common5',
  'sales1', 'sales2', 'sales3', 'sales4', 'sales5', 'sales6', 'sales7', 'sales8', 'sales9', 'sales10', 'sales11',
  'success1', 'success2', 'success3', 'success4', 'success5', 'success6',
  'support1', 'support2', 'support3', 'support4', 'support5', 'support6', 'support7', 'support8',
]);
const VALID_TAGS = new Set(['first', 'next', 'opt']);
const TAG_TEXT = { first: 'сначала', next: 'потом', opt: 'по желанию' };

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
      const key = (body?.key || '').toString().trim();
      if (!VALID_KEYS.has(key)) { res.status(400).json({ error: 'Неизвестный пункт чек-листа' }); return; }
      let items = body?.items;
      if (!Array.isArray(items)) { res.status(400).json({ error: 'Нужен список items' }); return; }
      items = items
        .map(it => {
          const label = (it?.label || '').toString().slice(0, 200).trim();
          const url = (it?.url || '').toString().slice(0, 1000).trim();
          const tag = VALID_TAGS.has(it?.tag) ? it.tag : 'next';
          return { label, url, tag, tagText: TAG_TEXT[tag] };
        })
        .filter(it => it.label && it.url)
        .slice(0, 60);

      await redis(['HSET', HKEY, key, JSON.stringify(items)]);
      res.status(200).json({ ok: true, key, items });
      return;
    }

    if (action === 'reset') {
      if (!passOk) { res.status(403).json({ error: 'Неверный пароль' }); return; }
      const key = (body?.key || '').toString().trim();
      if (!VALID_KEYS.has(key)) { res.status(400).json({ error: 'Неизвестный пункт чек-листа' }); return; }
      await redis(['HDEL', HKEY, key]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
