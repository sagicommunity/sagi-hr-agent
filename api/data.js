// Vercel Serverless Function — экспорт/очистка статистики дешборда (для РОПа).
// POST { action: 'export'|'clear', password, scope?: 'test'|'all', period?: 'week'|'month'|'all' }
// Защищено DASHBOARD_PASSWORD. Данные — в Redis (Upstash), ключ hr:events.

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const EVENTS_KEY = 'hr:events';

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  const res = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result;
}

async function loadEvents() {
  const arr = await redis(['LRANGE', EVENTS_KEY, 0, 999]);
  if (!Array.isArray(arr)) return [];
  return arr.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

function inPeriod(e, period) {
  if (!period || period === 'all' || !e.ts) return true;
  const span = period === 'week' ? 7 * 86400000 : period === 'month' ? 30 * 86400000 : Infinity;
  return (Date.now() - e.ts) <= span;
}

function toCsv(events) {
  const head = ['datetime', 'manager', 'type', 'skill', 'score', 'note'];
  const esc = c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
  const rows = [head.map(esc).join(',')];
  for (const e of events) {
    rows.push([
      e.ts ? new Date(e.ts).toISOString() : '',
      e.manager, e.type, e.skill, e.score, e.note,
    ].map(esc).join(','));
  }
  return rows.join('\r\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const PASS = process.env.DASHBOARD_PASSWORD || '';
    const password = (body?.password || '').toString();
    if (!PASS || password !== PASS) { res.status(403).json({ error: 'Неверный пароль РОПа' }); return; }
    if (!R_URL || !R_TOK) { res.status(500).json({ error: 'Хранилище не подключено' }); return; }

    const action = body?.action;

    if (action === 'export') {
      const period = body?.period || 'all';
      const events = (await loadEvents()).filter(e => inPeriod(e, period));
      res.status(200).json({ csv: toCsv(events), count: events.length });
      return;
    }

    if (action === 'clear') {
      const scope = body?.scope === 'all' ? 'all' : 'test';
      if (scope === 'all') {
        await redis(['DEL', EVENTS_KEY]);
        res.status(200).json({ ok: true, scope, removed: 'all', remaining: 0 });
        return;
      }
      // scope=test — удаляем записи, где имя содержит «тест»/«test»
      const events = await loadEvents();
      const isTest = e => /тест|test/i.test(String(e.manager || ''));
      const keep = events.filter(e => !isTest(e));
      const removed = events.length - keep.length;
      await redis(['DEL', EVENTS_KEY]);
      // восстанавливаем порядок (новые сверху): LRANGE вернул новые первыми → пушим в обратном порядке
      for (const e of keep.slice().reverse()) {
        await redis(['LPUSH', EVENTS_KEY, JSON.stringify(e)]);
      }
      res.status(200).json({ ok: true, scope, removed, remaining: keep.length });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
