// Vercel Serverless Function — Sagi HR + Sales Enablement агент
// Claude (Anthropic API) + сбор статистики в Redis (Upstash) + парольный гейт дешборда.
// Env: ANTHROPIC_API_KEY, [KV_REST_API_URL|UPSTASH_REDIS_REST_URL], [KV_REST_API_TOKEN|UPSTASH_REDIS_REST_TOKEN], DASHBOARD_PASSWORD

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `Ты — Sagi HR-агент: специализированный HR + Sales Enablement ИИ-агент полного цикла для компании Sagi (B2B SaaS, loyalty-платформа, sagi.kz) в сегменте B2B МСБ.

Твоя цель — нанимать менеджеров по холодным продажам (хантеров), непрерывно обучать команду, помогать закрывать сделки и вести аудит прогресса для руководства.

КОНТЕКСТ ПРОДУКТА SAGI:
Sagi — платформа лояльности и бонусов для бизнеса: удержание клиентов через бонусы, кешбэк, push/SMS-уведомления, аналитику и сегментацию. ЦА продаж — владельцы и маркетологи МСБ (кафе, рестораны, ритейл, услуги, сети). Боли: уходящие клиенты, нет повторных покупок, не знают свою базу, дорогая реклама на привлечение вместо удержания.

СПЕЦИФИКА ПРОДАЖ:
Холодный аутрич, звонки и переписка. Менеджер ищет ЛПР (владелец/маркетолог), обходит блокировки («секретарь», «отправьте на почту»), выявляет боль и закрывает на целевое действие (демо/созвон/встреча).

═══ ФУНКЦИОНАЛЬНЫЕ БЛОКИ ═══
БЛОК 1 — НАЁМ И СКРИНИНГ. Текстовое интервью кандидата по этапам: знакомство/мотивация → кейс на холодное сообщение владельцу кафе → стресс-кейс (резкий отказ) → кейс на CTA. По 1–2 вопроса за раз. В конце — оценка 0–10 по навыкам (аутрич, копирайтинг, стрессоустойчивость, CTA) и вердикт (Брать / Резерв / Отказ).
БЛОК 2 — ОБУЧЕНИЕ И КВАЛИФИКАЦИЯ. Тесты по продукту/матчасти; симуляции, где ТЫ играешь холодного/негативного/занятого клиента, а менеджер отрабатывает возражения. Не сдавайся слишком легко. По итогам — оценка 0–10, разбор, 2–3 рекомендации.
БЛОК 3 — DEAL COACHING. Менеджер присылает переписку/кейс — даёшь готовый к отправке текст ответа/фоллоу-апа/аргумент к закрытию (можно копировать), 1–2 варианта тона.
БЛОК 4 — ДЕШБОРД. По запросу руководства строишь сводную Markdown-таблицу по команде: колонки «Наём/Онбординг», «Обучение (тесты/ролёвки)», «Навыки аутрича», «Работа с возражениями», «Помощь в сделках», «Итог». Затем блок выводов: «Требуют внимания», «Лидер недели», «Средний балл команды».

═══ СОХРАНЕНИЕ ОЦЕНОК (ВАЖНО) ═══
Когда в режимах БЛОК 1/2/3 ты выставляешь менеджеру/кандидату ФИНАЛЬНУЮ оценку (число 0–10) по итогам теста, ролёвки, интервью или разбора кейса — добавь В САМОМ КОНЦЕ ответа ОТДЕЛЬНОЙ СТРОКОЙ машиночитаемый блок РОВНО в таком формате (можно несколько подряд):
##SAVE {"manager":"ИМЯ","type":"ролёвка|тест|интервью|кейс","skill":"аутрич|возражения|продукт|стрессоустойчивость|cta|сделки|онбординг","score":7,"note":"кратко"}##
ИМЯ бери из строки «Текущий пользователь». Не добавляй блок, если числовой оценки не было. Этот блок вырезается и пользователю не показывается — не упоминай его.

═══ ДЕШБОРД ИЗ РЕАЛЬНЫХ ДАННЫХ ═══
Для дешборда используй ТОЛЬКО данные из блока <DATA>…</DATA> (если он передан) — это реальные сохранённые оценки команды. Считай средние по навыкам и общий балл по каждому менеджеру. Если <DATA> пустой или его нет — честно скажи, что статистики пока нет, и предложи менеджерам пройти ролёвки/тесты, чтобы дешборд наполнился.

═══ МУЛЬТИ-РЕЖИМ ═══
«я на собеседование»/про вакансию → БЛОК 1. «проверь знания/ролёвка/тест» → БЛОК 2. «помоги со сделкой…» → БЛОК 3. «дешборд по менеджерам» → БЛОК 4. Если роль неясна — уточни одним вопросом.

СТИЛЬ: по-русски (или по-казахски, если обратятся на казахском). Деловой, тёплый, по делу, как опытный РОП-наставник. Markdown: заголовки, таблицы, списки, **выделение**. Эмодзи умеренно (✅ ⚠️ 🟢 🟡 🔴 📊 🎯). 1–2 вопроса за раз.`;

// ---- Redis (Upstash REST) ----
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

async function saveEvents(events) {
  if (!events.length) return;
  for (const ev of events) {
    try { await redis(['LPUSH', EVENTS_KEY, JSON.stringify({ ...ev, ts: Date.now() })]); } catch (e) {}
  }
  try { await redis(['LTRIM', EVENTS_KEY, 0, 999]); } catch (e) {}
}

async function loadEvents() {
  try {
    const arr = await redis(['LRANGE', EVENTS_KEY, 0, 999]);
    if (!Array.isArray(arr)) return [];
    return arr.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function aggregate(events) {
  const byMgr = {};
  for (const e of events) {
    const m = (e.manager || '—').trim() || '—';
    byMgr[m] = byMgr[m] || { manager: m, count: 0, scores: [], skills: {}, types: {} };
    const g = byMgr[m];
    g.count++;
    const sc = Number(e.score);
    if (!isNaN(sc)) g.scores.push(sc);
    if (e.skill) { g.skills[e.skill] = g.skills[e.skill] || []; if (!isNaN(sc)) g.skills[e.skill].push(sc); }
    if (e.type) g.types[e.type] = (g.types[e.type] || 0) + 1;
  }
  const avg = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
  return Object.values(byMgr).map(g => ({
    manager: g.manager,
    events: g.count,
    overall: avg(g.scores),
    bySkill: Object.fromEntries(Object.entries(g.skills).map(([k, v]) => [k, avg(v)])),
    byType: g.types,
  }));
}

// ---- helpers ----
const DASH_RE = /дешборд|dashboard|сводк\w*\s+по\s+менеджер|прогресс\s+команд|отчёт\s+по\s+команд/i;
function extractSaves(text) {
  const events = [];
  const re = /##SAVE\s*(\{.*?\})\s*##/gs;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { const obj = JSON.parse(m[1]); if (obj && (obj.manager || obj.score != null)) events.push(obj); } catch (e) {}
  }
  const clean = text.replace(/\s*##SAVE\s*\{.*?\}\s*##/gs, '').trim();
  return { events, clean };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY не задан в настройках Vercel.' }); return; }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const userName = (body?.userName || '').toString().slice(0, 60).trim();
    const dashPass = (body?.dashboardPassword || '').toString();
    const period = (body?.period || 'all').toString();
    const incoming = Array.isArray(body?.messages) ? body.messages : [];
    const messages = incoming
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-24)
      .map(m => ({ role: m.role, content: m.content }));
    if (!messages.length) { res.status(400).json({ error: 'Пустой запрос' }); return; }

    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const isDashboard = lastUser ? DASH_RE.test(lastUser.content) : false;

    // ---- парольный гейт дешборда ----
    const PASS = process.env.DASHBOARD_PASSWORD || '';
    let dataBlock = '';
    if (isDashboard) {
      if (PASS && dashPass !== PASS) {
        res.status(200).json({
          reply: '🔒 Доступ к дешборду — только для руководителя.\n\nВведите **пароль РОПа** в поле ниже и отправьте.',
          needPassword: true,
        });
        return;
      }
      const all = await loadEvents();
      const now = Date.now();
      const span = period === 'week' ? 7 * 86400000 : period === 'month' ? 30 * 86400000 : Infinity;
      const events = all.filter(e => !e.ts || (now - e.ts) <= span);
      const agg = aggregate(events);
      const periodLabel = period === 'week' ? 'последние 7 дней' : period === 'month' ? 'последние 30 дней' : 'всё время';
      dataBlock = `\n\n<DATA>\n${JSON.stringify({ generatedAt: new Date().toISOString(), period: periodLabel, managers: agg, totalEvents: events.length }, null, 0)}\n</DATA>`;
    }

    const sysSuffix =
      `\n\n— Текущий пользователь: имя=${userName || 'не указано'}.` +
      (isDashboard ? ' Роль: руководитель (доступ к дешборду подтверждён). Построй дешборд строго из блока <DATA>.' : '') +
      dataBlock;

    const anthRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2200, system: SYSTEM_PROMPT + sysSuffix, messages }),
    });
    const data = await anthRes.json();
    if (!anthRes.ok) {
      res.status(anthRes.status).json({ error: data?.error?.message || ('Anthropic API error ' + anthRes.status) });
      return;
    }
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const { events, clean } = extractSaves(raw);
    if (events.length) {
      const fixed = events.map(e => ({ ...e, manager: (e.manager && String(e.manager).trim()) || userName || '—' }));
      saveEvents(fixed); // best-effort, не блокируем ответ
    }
    res.status(200).json({ reply: clean || '(пустой ответ)', saved: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
