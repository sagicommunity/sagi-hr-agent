// Vercel Serverless Function — экспорт/очистка статистики дешборда (для РОПа).
// POST { action: 'export'|'clear', password, scope?: 'test'|'all', period?: 'week'|'month'|'all' }
// Защищено DASHBOARD_PASSWORD. Данные — в Redis (Upstash), ключ hr:events.

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const EVENTS_KEY = 'hr:events';
const CAND_KEY = 'hr:candidates';
const TEST_RE = /тест|test|проверка/i;

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

async function loadList(key) {
  const arr = await redis(['LRANGE', key, 0, 999]);
  if (!Array.isArray(arr)) return [];
  return arr.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}
async function loadEvents() { return loadList(EVENTS_KEY); }

// Чистка списка: удаляет тестовые (по имени) или всё. Возвращает {removed, remaining}.
async function clearList(key, nameField, scope) {
  if (scope === 'all') { await redis(['DEL', key]); return { removed: 'all', remaining: 0 }; }
  const items = await loadList(key);
  const keep = items.filter(x => !TEST_RE.test(String(x[nameField] || '')));
  const removed = items.length - keep.length;
  await redis(['DEL', key]);
  for (const x of keep.slice().reverse()) await redis(['LPUSH', key, JSON.stringify(x)]);
  return { removed, remaining: keep.length };
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
      const target = body?.target || 'all'; // 'events' | 'candidates' | 'all'
      const out = { ok: true, scope };
      if (target === 'events' || target === 'all') out.events = await clearList(EVENTS_KEY, 'manager', scope);
      if (target === 'candidates' || target === 'all') out.candidates = await clearList(CAND_KEY, 'name', scope);
      // обратная совместимость со старым фронтом
      const ev = out.events, cn = out.candidates;
      out.removed = (typeof ev?.removed === 'number' ? ev.removed : 0) + (typeof cn?.removed === 'number' ? cn.removed : 0);
      out.remaining = (ev?.remaining || 0) + (cn?.remaining || 0);
      res.status(200).json(out);
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
