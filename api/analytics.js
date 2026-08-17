// Vercel Serverless Function — сводная аналитика по найму (для РОПа).
// POST { password }. Защищено DASHBOARD_PASSWORD (тот же пароль, что у /pipeline.html).
// Агрегирует три источника данных:
//   1) hr:candidates       — общий пайплайн кандидатов (все каналы)
//   2) hh:seen_negotiations / hh:replied_negotiations — воронка hh.kz (api/hh_poll.js)
//   3) hr:tg:stat:*        — воронка Telegram-бота найма (api/tg.js), включая переходы по UTM-меткам (Threads/Instagram и т.п.)

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const CAND_KEY = 'hr:candidates';
const HH_SEEN_KEY = 'hh:seen_negotiations';
const HH_REPLIED_KEY = 'hh:replied_negotiations';
const TG_SOURCES_KEY = 'hr:tg:stat:sources';

const STAGES = ['Новый', 'Ответил', 'На связи', 'Квалификация', 'Интервью', 'Оффер', 'Стажировка', 'Отказ'];

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
async function redisBatch(cmds) {
  if (!R_URL || !R_TOK) return cmds.map(() => null);
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) return cmds.map(() => null);
  const d = await r.json();
  return Array.isArray(d) ? d.map(x => x.result) : cmds.map(() => null);
}

async function loadCandidates() {
  const arr = await redis(['LRANGE', CAND_KEY, 0, 1999]);
  if (!Array.isArray(arr)) return [];
  return arr.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

function tally(items, keyFn, fallback) {
  const m = new Map();
  for (const it of items) {
    const k = (keyFn(it) || fallback || '—').toString().trim() || (fallback || '—');
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

// Классифицирует источник кандидата в укрупнённую группу канала для верхнеуровневой сводки.
function channelOf(c) {
  const src = (c.source || '').toLowerCase();
  const id = (c.id || '').toLowerCase();
  if (id.startsWith('hh_') || src.includes('hh.kz') || src.includes('hh.ru')) return 'hh.kz';
  if (src.includes('telegram') || src.includes('tg-бот') || src.includes('telegram-бот')) return 'Telegram-бот';
  if (src.includes('ручное') || id.startsWith('manual_')) return 'Ручное добавление';
  if (src.includes('pdf') || src.includes('список')) return 'Пайплайн (вручную РОПом)';
  if (src.includes('форма') || src.includes('apply')) return 'Форма отклика (сайт)';
  return c.source || 'Другое';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const PASS = process.env.DASHBOARD_PASSWORD || '';
    if (!PASS || (body?.password || '') !== PASS) { res.status(403).json({ error: 'Неверный пароль РОПа' }); return; }
    if (!R_URL || !R_TOK) { res.status(500).json({ error: 'Хранилище не подключено' }); return; }

    const candidates = await loadCandidates();
    const now = Date.now();
    const DAY = 86400000;

    // ---- Общий пайплайн ----
    const byStage = STAGES.map(s => ({ key: s, count: candidates.filter(c => (c.stage || 'Новый') === s).length }));
    const byChannel = tally(candidates, channelOf);
    const byVacancy = tally(candidates, c => c.vacancy, 'Не указана');
    const byVerdict = tally(candidates, c => c.verdict, 'Без вердикта');
    const scored = candidates.filter(c => typeof c.score === 'number');
    const avgScore = scored.length ? Math.round((scored.reduce((s, c) => s + c.score, 0) / scored.length) * 10) / 10 : null;

    // ---- hh.kz воронка ----
    const [hhSeen, hhReplied] = await redisBatch([
      ['SCARD', HH_SEEN_KEY],
      ['SCARD', HH_REPLIED_KEY],
    ]);
    const hhTotalSeen = typeof hhSeen === 'number' ? hhSeen : 0;
    const hhTotalReplied = typeof hhReplied === 'number' ? hhReplied : 0;
    const hhCandidates = candidates.filter(c => (c.id || '').startsWith('hh_'));
    const hhByVerdict = tally(hhCandidates.filter(c => c.verdict), c => c.verdict, 'Без вердикта');

    // ---- Telegram-бот воронка (со срезом по источнику/UTM — Threads, Instagram и т.п.) ----
    const tgSources = await redis(['SMEMBERS', TG_SOURCES_KEY]);
    const srcList = Array.isArray(tgSources) ? tgSources : [];
    const [tgTotalStarts, tgTotalCompleted] = await redisBatch([
      ['GET', 'hr:tg:stat:starts:total'],
      ['GET', 'hr:tg:stat:completed:total'],
    ]);
    const perSourceCmds = [];
    for (const src of srcList) { perSourceCmds.push(['GET', 'hr:tg:stat:starts:src:' + src], ['GET', 'hr:tg:stat:completed:src:' + src]); }
    const perSourceRes = await redisBatch(perSourceCmds);
    const tgBySource = srcList.map((src, i) => {
      const starts = parseInt(perSourceRes[i * 2], 10) || 0;
      const completed = parseInt(perSourceRes[i * 2 + 1], 10) || 0;
      return { key: src, starts, completed, conversionPct: starts ? Math.round((completed / starts) * 1000) / 10 : 0 };
    }).sort((a, b) => b.starts - a.starts);

    // ---- Динамика по дням (последние 14 дней, по общему пайплайну) ----
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const dayStart = now - i * DAY;
      const d = new Date(dayStart);
      const label = d.toISOString().slice(5, 10); // MM-DD
      const count = candidates.filter(c => c.ts && (now - c.ts) < (i + 1) * DAY && (now - c.ts) >= i * DAY).length;
      days.push({ label, count });
    }

    res.status(200).json({
      ok: true,
      generatedAt: now,
      candidates: {
        total: candidates.length,
        last7days: candidates.filter(c => c.ts && (now - c.ts) <= 7 * DAY).length,
        last30days: candidates.filter(c => c.ts && (now - c.ts) <= 30 * DAY).length,
        avgScore,
        byStage,
        byChannel,
        byVacancy,
        byVerdict,
        daily: days,
      },
      hhkz: {
        totalSeen: hhTotalSeen,
        totalReplied: hhTotalReplied,
        pendingReply: Math.max(0, hhTotalSeen - hhTotalReplied),
        replyRatePct: hhTotalSeen ? Math.round((hhTotalReplied / hhTotalSeen) * 1000) / 10 : 0,
        byVerdict: hhByVerdict,
      },
      telegram: {
        totalStarts: parseInt(tgTotalStarts, 10) || 0,
        totalCompleted: parseInt(tgTotalCompleted, 10) || 0,
        conversionPct: (parseInt(tgTotalStarts, 10) || 0) ? Math.round(((parseInt(tgTotalCompleted, 10) || 0) / (parseInt(tgTotalStarts, 10) || 1)) * 1000) / 10 : 0,
        bySource: tgBySource,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
