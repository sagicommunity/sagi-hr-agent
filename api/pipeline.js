// Vercel Serverless Function — рекрутинг-пайплайн (для РОПа/рекрутера).
// POST { action, password, ... }. Защищено DASHBOARD_PASSWORD. Данные — Redis list hr:candidates.
// actions: 'list' | 'add' | 'stage' | 'delete' | 'hhFunnel'

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CAND_KEY = 'hr:candidates';
// 2026-08-18, по замечанию Sagi: «Стажировка» ставилась сразу после приглашения, до того как
// человек вообще зарегистрировался и прошёл обучение — не отражало реальность. Теперь путь:
// Ответил (написал в ответ на первое сообщение) -> Приглашён (отправлено приглашение, ждём
// регистрации) -> Обучение (зарегистрировался на hr.sagibonus.com, проходит базовую программу)
// -> Стажировка (закончил все 10 модулей, назначен наставник, реально стажируется).
// 2026-08-18, по запросу Sagi («сократить отток, но сейчас его нечем измерять») — добавлены
// «Трудоустроен» (реальный выход на работу после стажировки) и «Ушёл» (реальный отток, с
// причиной в поле exitReason). До этой правки воронка обрывалась на «Стажировка» и того, что
// происходит с человеком дальше, в системе не было вообще — значит и отток нечем было мерить.
// 2026-08-18, найден и исправлен баг: hh_poll.js при отказе на гейт-вопросе (кандидат прямо
// написал, что формат/холодные звонки не подходят) ставит кандидату stage='Не подходит', но
// этой стадии не было в STAGES — normalize() (см. ниже) молча сбрасывал её на 'Новый' при
// каждом открытии pipeline.html, и при первом же действии (смена стадии/удаление ЛЮБОГО
// кандидата — normalize() прогоняет весь список) это тихо перезаписывалось в хранилище навсегда.
// Из-за этого в pipeline.html не было самого статуса «Не подходит» в выпадающем списке, и в
// воронке на hh.kz этот отказ был не виден нигде, кроме отдельной строки текстом (totalDeclined).
const STAGES = ['Новый', 'Ответил', 'Приглашён', 'Обучение', 'Стажировка', 'Трудоустроен', 'На связи', 'Квалификация', 'Интервью', 'Оффер', 'Не подходит', 'Отказ', 'Ушёл'];

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
async function loadAll() {
  const arr = await redis(['LRANGE', CAND_KEY, 0, 999]);
  if (!Array.isArray(arr)) return [];
  return arr.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}
async function saveAll(items) {
  await redis(['DEL', CAND_KEY]);
  for (const x of items.slice().reverse()) await redis(['LPUSH', CAND_KEY, JSON.stringify(x)]);
}

function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }
function extractPhone(...sources) {
  for (const s of sources) {
    const m = String(s || '').match(/(\+?7|8)?[\s\-(]*\d{3}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/);
    if (m) { let d = digits(m[0]); if (d.length === 10) d = '7' + d; if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1); return d; }
  }
  return '';
}
function waMessage(name) {
  const n = (name || '').trim().split(/\s+/)[0] || '';
  return `Здравствуйте${n ? ', ' + n : ''}! 👋 Меня зовут [ваше имя], я из компании Sagi (платформа лояльности для бизнеса). Мы расширяем отдел продаж и заинтересовались вашим опытом. Можете уделить пару минут — задам 3 коротких вопроса по позиции менеджера по продажам?`;
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function parseAge(s) {
  const t = String(s || '');
  const m = t.match(/(\d{1,2})\s*(?:лет|год[а]?|г\.?)\b/i) || t.match(/возраст[^\d]{0,8}(\d{1,2})/i);
  if (m) { const a = parseInt(m[1], 10); if (a >= 14 && a <= 70) return a; }
  return null;
}

const SCREEN_SYS = `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ). Оцениваешь кандидата на менеджера по ХОЛОДНЫМ продажам (хантер): аутрич, звонки, поиск ЛПР, работа с возражениями, закрытие на встречу. Работа: офис в Астане.
КЛЮЧЕВОЙ ФИЛЬТР: кандидат ОБЯЗАН быть готов САМОСТОЯТЕЛЬНО искать ЛПР и делать ХОЛОДНЫЕ звонки/обзвоны. Если видно, что он НЕ хочет/не готов к холодным звонкам и самостоятельному поиску клиентов (только тёплые/входящие лиды, «не люблю звонить», только переписка) — ставь «Отказ» и низкий балл, укажи это в summary.
Верни ТОЛЬКО валидный JSON без markdown:
{"score": <0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения>", "strengths": ["..."], "flags": ["..."], "age": <возраст числом, если есть в резюме, иначе null>}`;

const SCREEN_SYS_REMOTE = `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ). Оцениваешь кандидата на менеджера по ХОЛОДНЫМ продажам, работающего ПОЛНОСТЬЮ УДАЛЁННО (хантер): аутрич, звонки, поиск ЛПР, работа с возражениями, закрытие сделки через онлайн-демо (Zoom/видеозвонок), без офиса и личных встреч.
ФИЛЬТР 1: кандидат ОБЯЗАН быть готов САМОСТОЯТЕЛЬНО искать ЛПР и делать ХОЛОДНЫЕ звонки/обзвоны. Если не готов — «Отказ», низкий балл, укажи в summary.
ФИЛЬТР 2: критична самодисциплина без офисного контроля и техническая готовность (интернет, компьютер, тихое место для звонков/видео весь день). Если под вопросом — снижай балл.
Верни ТОЛЬКО валидный JSON без markdown:
{"score": <0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения>", "strengths": ["..."], "flags": ["..."], "age": <возраст числом, если есть в резюме, иначе null>}`;

const VAC_TITLES = { sales: 'Менеджер по продажам', sales_remote: 'Менеджер по продажам — удалённо' };

async function screen(name, resume, vacancy) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let out = { score: null, verdict: 'Резерв', summary: '', strengths: [], flags: [], age: null };
  if (!apiKey || !resume) return out;
  const sys = vacancy === 'sales_remote' ? SCREEN_SYS_REMOTE : SCREEN_SYS;
  try {
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 700, system: sys, messages: [{ role: 'user', content: `Кандидат: ${name}\n\nРезюме:\n${resume.slice(0, 7000)}` }] }),
    });
    const ad = await ar.json();
    if (ar.ok) {
      const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { const o = JSON.parse(m[0]); out = { score: o.score ?? null, verdict: o.verdict || 'Резерв', summary: o.summary || '', strengths: o.strengths || [], flags: o.flags || [], age: (typeof o.age === 'number' && o.age >= 14 && o.age <= 70) ? o.age : null }; }
    }
  } catch (e) {}
  return out;
}

// 2026-08-18, найден и исправлен попутный баг: normalize() раньше строила объект «с нуля» из
// фиксированного списка полей, без spread — а действия 'stage' и 'delete' прогоняют ЧЕРЕЗ
// normalize() ВЕСЬ список кандидатов перед пересохранением (не только тронутую запись). Значит
// любой клик по смене стадии ЛЮБОГО кандидата на pipeline.html тихо стирал у ВСЕХ кандидатов
// поля, которых нет в этом списке ниже: messageSent, replyText, mentorName/mentorPhone
// (наставник, ФАЗА E в hh_poll.js), а теперь ещё и employedAt/leftAt/exitReason (трекинг
// оттока, см. ниже). Spread в начале сохраняет всё, что не перечислено явно.
function normalize(c) {
  return {
    ...c,
    id: c.id || newId(),
    name: c.name || '—',
    contact: c.contact || '',
    phone: c.phone || extractPhone(c.contact, c.resume),
    source: c.source || '—',
    vacancy: c.vacancy || 'Менеджер по продажам',
    age: (c.age != null && c.age !== '') ? c.age : parseAge(c.resume),
    score: c.score ?? null,
    verdict: c.verdict || 'Резерв',
    summary: c.summary || '',
    answers: Array.isArray(c.answers) ? c.answers : [],
    resume: c.resume || '',
    strengths: c.strengths || [],
    flags: c.flags || [],
    stage: STAGES.includes(c.stage) ? c.stage : 'Новый',
    waMessage: c.waMessage || waMessage(c.name),
    ts: c.ts || Date.now(),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const PASS = process.env.DASHBOARD_PASSWORD || '';
    if (!PASS || (body?.password || '') !== PASS) { res.status(403).json({ error: 'Неверный пароль РОПа' }); return; }
    if (!R_URL || !R_TOK) { res.status(500).json({ error: 'Хранилище не подключено' }); return; }

    const action = body?.action;

    if (action === 'list') {
      const items = (await loadAll()).map(normalize);
      res.status(200).json({ ok: true, stages: STAGES, items });
      return;
    }

    if (action === 'add') {
      const name = (body?.name || '').toString().slice(0, 80).trim();
      const phoneIn = (body?.phone || '').toString().trim();
      const contact = (body?.contact || '').toString().slice(0, 160).trim() || phoneIn;
      const source = (body?.source || 'ручное добавление').toString().slice(0, 80).trim();
      const resume = (body?.resume || '').toString().slice(0, 8000).trim();
      const vacancyIn = (body?.vacancy === 'sales_remote') ? 'sales_remote' : 'sales';
      const vacTitle = VAC_TITLES[vacancyIn];
      if (!name && !phoneIn && !resume) { res.status(400).json({ error: 'Нужно имя, телефон или резюме' }); return; }
      const ev = await screen(name, resume, vacancyIn);
      const answers = resume ? [{ q: 'Резюме / о себе', a: resume.slice(0, 4000) }] : [];
      const rec = normalize({
        id: newId(), name: name || 'Без имени', contact, phone: phoneIn ? digits(phoneIn) : extractPhone(contact, resume),
        source, vacancy: vacTitle, resume: resume.slice(0, 2000), answers, ...ev, stage: 'Новый', waMessage: waMessage(name), ts: Date.now(),
      });
      await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]);
      await redis(['LTRIM', CAND_KEY, 0, 1999]);
      res.status(200).json({ ok: true, item: rec });
      return;
    }

    if (action === 'stage') {
      const id = (body?.id || '').toString();
      const stage = (body?.stage || '').toString();
      if (!STAGES.includes(stage)) { res.status(400).json({ error: 'Неизвестная стадия' }); return; }
      const items = (await loadAll()).map(normalize);
      const idx = items.findIndex(x => x.id === id);
      if (idx < 0) { res.status(404).json({ error: 'Кандидат не найден' }); return; }
      items[idx].stage = stage;
      // Фиксируем даты для будущего расчёта оттока: когда реально вышел на работу и когда/почему
      // ушёл. employedAt проставляем только один раз (первый переход в «Трудоустроен»), чтобы
      // случайный клик туда-обратно не сбивал дату реального выхода.
      if (stage === 'Трудоустроен' && !items[idx].employedAt) items[idx].employedAt = Date.now();
      if (stage === 'Ушёл') {
        items[idx].leftAt = Date.now();
        const exitReason = (body?.exitReason || '').toString().slice(0, 500).trim();
        if (exitReason) items[idx].exitReason = exitReason;
      }
      await saveAll(items);
      res.status(200).json({ ok: true, item: items[idx] });
      return;
    }

    // Воронка по hh.kz для дешборда (2026-08-17, по запросу Sagi): сколько всего откликов пришло
    // на активную вакансию, скольким отправили первое сообщение, сколько ответили, сколько уже
    // приглашены на стажировку. Сама выборка живёт в hh_poll.js (там уже есть OAuth-токен hh.ru),
    // здесь просто проксируем server-to-server через HH_POLL_SECRET, чтобы секрет не светился в
    // браузере кандидата/рекрутера.
    if (action === 'hhFunnel') {
      try {
        const secret = process.env.HH_POLL_SECRET || '';
        const host = req.headers?.host || 'hr.sagibonus.com';
        const proto = host.includes('localhost') ? 'http' : 'https';
        if (!secret) { res.status(200).json({ ok: false, error: 'HH_POLL_SECRET не настроен' }); return; }
        const r = await fetch(`${proto}://${host}/api/hh_poll?secret=${encodeURIComponent(secret)}&hhFunnelStats=1`);
        const d = await r.json();
        res.status(200).json(d);
      } catch (e) {
        res.status(200).json({ ok: false, error: e.message });
      }
      return;
    }

    if (action === 'delete') {
      const id = (body?.id || '').toString();
      const items = (await loadAll()).map(normalize).filter(x => x.id !== id);
      await saveAll(items);
      res.status(200).json({ ok: true, remaining: items.length });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
