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
// 2026-08-18, по запросу Sagi «добавь воронку по вакансии, сколько было откликов и конверсия» —
// те же ключи, что в api/hh_poll.js (SEEN/GATE_HANDLED/QUESTIONS_SENT/DECLINED/REPLIED), чтобы
// видеть не только «откликнулся / ответил», а честную многоступенчатую воронку: гейт-вопрос
// (интересен ли формат) -> анкета из 5 вопросов -> приглашение -> обучение -> стажировка.
const HH_GATE_HANDLED_KEY = 'hh:gate_handled';
const HH_QUESTIONS_SENT_KEY = 'hh:questions_sent';
const HH_DECLINED_KEY = 'hh:declined_negotiations';
const TG_SOURCES_KEY = 'hr:tg:stat:sources';

// 2026-08-18, по замечанию Sagi: «Стажировка» ставилась сразу после приглашения, до того как
// человек вообще зарегистрировался и прошёл обучение — не отражало реальность. Теперь путь:
// Ответил (написал в ответ на первое сообщение) -> Приглашён (отправлено приглашение, ждём
// регистрации) -> Обучение (зарегистрировался на hr.sagibonus.com, проходит базовую программу)
// -> Стажировка (закончил все 10 модулей, назначен наставник, реально стажируется).
const STAGES = ['Новый', 'Ответил', 'Приглашён', 'Обучение', 'Стажировка', 'Трудоустроен', 'На связи', 'Квалификация', 'Интервью', 'Оффер', 'Отказ', 'Ушёл'];

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
  // ВАЖНО (найдено 2026-08-18, баг с самого добавления воронки): Upstash REST API отдельным
  // маршрутом обслуживает батч из нескольких команд — POST на {R_URL}/pipeline, а не на базовый
  // R_URL (тот принимает ОДНУ команду за раз). Из-за этого все SCARD-счётчики воронки молча
  // возвращали null -> 0 на дешборде, хотя реальные данные в Redis были.
  const r = await fetch(R_URL + '/pipeline', {
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
    const [hhSeen, hhReplied, hhGateHandled, hhGatePassed, hhDeclined] = await redisBatch([
      ['SCARD', HH_SEEN_KEY],
      ['SCARD', HH_REPLIED_KEY],
      ['SCARD', HH_GATE_HANDLED_KEY],
      ['SCARD', HH_QUESTIONS_SENT_KEY],
      ['SCARD', HH_DECLINED_KEY],
    ]);
    const hhTotalSeen = typeof hhSeen === 'number' ? hhSeen : 0;
    const hhTotalReplied = typeof hhReplied === 'number' ? hhReplied : 0;
    const hhTotalGateHandled = typeof hhGateHandled === 'number' ? hhGateHandled : 0;
    const hhTotalGatePassed = typeof hhGatePassed === 'number' ? hhGatePassed : 0;
    const hhTotalDeclined = typeof hhDeclined === 'number' ? hhDeclined : 0;
    const hhCandidates = candidates.filter(c => (c.id || '').startsWith('hh_'));
    const hhByVerdict = tally(hhCandidates.filter(c => c.verdict), c => c.verdict, 'Без вердикта');
    // Полная воронка вакансии: от «получили отклик» до «трудоустроен». Первые 4 шага — это
    // сообщения в переписке на hh.kz (считаются по счётчикам выше, они точнее и не зависят от
    // того, успели ли мы создать карточку кандидата). Дальше — уже стадии карточки кандидата
    // (hr:candidates), т.к. приглашение/обучение/стажировка — это про саму карточку, а не
    // про переписку на hh.kz.
    const hhInvited = hhCandidates.filter(c => ['Приглашён', 'Обучение', 'Стажировка', 'Трудоустроен'].includes(c.stage)).length;
    const hhTrainingStarted = hhCandidates.filter(c => ['Обучение', 'Стажировка', 'Трудоустроен'].includes(c.stage)).length;
    const hhInternship = hhCandidates.filter(c => ['Стажировка', 'Трудоустроен'].includes(c.stage)).length;
    const hhEmployed = hhCandidates.filter(c => c.stage === 'Трудоустроен').length;
    const funnelRaw = [
      { key: 'Откликов получено', count: hhTotalSeen },
      { key: 'Ответили на гейт-вопрос (интересен формат?)', count: hhTotalGateHandled },
      { key: 'Прошли гейт, получили анкету из 5 вопросов', count: hhTotalGatePassed },
      { key: 'Ответили на анкету (оценено ИИ)', count: hhTotalReplied },
      { key: 'Приглашены на обучение', count: hhInvited },
      { key: 'Начали обучение (зарегистрировались)', count: hhTrainingStarted },
      { key: 'Дошли до стажировки', count: hhInternship },
      { key: 'Трудоустроены', count: hhEmployed },
    ];
    const funnelFirst = funnelRaw[0].count || 1;
    const hhFunnel = funnelRaw.map((r, i) => ({
      key: r.key,
      count: r.count,
      fromPrevPct: i === 0 ? null : (funnelRaw[i - 1].count ? Math.round((r.count / funnelRaw[i - 1].count) * 1000) / 10 : 0),
      fromStartPct: Math.round((r.count / funnelFirst) * 1000) / 10,
    }));

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

    // ---- Отток (2026-08-18, задача Sagi «сократить отток сотрудников») ----
    // employedAt/leftAt/exitReason проставляются в api/pipeline.js при смене стадии на
    // «Трудоустроен»/«Ушёл». Считаем, сколько реально вышедших сотрудников до сих пор работают,
    // сколько ушли, средний срок работы до ухода (в днях) и по каким причинам уходят чаще всего.
    const everEmployed = candidates.filter(c => c.employedAt);
    const leftCandidates = candidates.filter(c => c.stage === 'Ушёл');
    const stillEmployed = candidates.filter(c => c.stage === 'Трудоустроен');
    const tenureDays = leftCandidates
      .filter(c => c.employedAt && c.leftAt && c.leftAt > c.employedAt)
      .map(c => Math.round((c.leftAt - c.employedAt) / DAY));
    const avgTenureDays = tenureDays.length ? Math.round((tenureDays.reduce((s, x) => s + x, 0) / tenureDays.length) * 10) / 10 : null;
    const exitReasons = tally(leftCandidates.filter(c => c.exitReason), c => c.exitReason, 'Без причины');
    const churnRatePct = everEmployed.length ? Math.round((leftCandidates.length / everEmployed.length) * 1000) / 10 : 0;

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
      retention: {
        employedTotal: everEmployed.length,
        stillEmployed: stillEmployed.length,
        left: leftCandidates.length,
        churnRatePct,
        avgTenureDays,
        exitReasons,
      },
      hhkz: {
        totalSeen: hhTotalSeen,
        totalReplied: hhTotalReplied,
        pendingReply: Math.max(0, hhTotalSeen - hhTotalReplied),
        replyRatePct: hhTotalSeen ? Math.round((hhTotalReplied / hhTotalSeen) * 1000) / 10 : 0,
        byVerdict: hhByVerdict,
        totalGateHandled: hhTotalGateHandled,
        totalGatePassed: hhTotalGatePassed,
        totalDeclined: hhTotalDeclined,
        invited: hhInvited,
        trainingStarted: hhTrainingStarted,
        internship: hhInternship,
        employed: hhEmployed,
        funnel: hhFunnel,
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
