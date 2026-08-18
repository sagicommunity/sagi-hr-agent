// Vercel Serverless Function — Telegram-бот найма кандидатов (Sagi Careers).
// Вебхук: показывает открытые вакансии, ведёт кандидата по нужному сценарию (продажи / техподдержка),
// скринит и кладёт в Пайплайн (Redis hr:candidates), сигналит РОПу.
// Setup: GET /api/tg?action=setup — ставит вебхук на самого себя.
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
function waMessage(name) { const n = (name || '').trim().split(/\s+/)[0] || ''; return `Здравствуйте${n ? ', ' + n : ''}! Меня зовут [ваше имя], я из Sagi. Спасибо за отклик на вакансию, удобно ответить на пару вопросов / созвониться?`; }

// ---- Вакансии ----
const VAC = {
  sales:          { key: 'sales',          title: 'Менеджер по продажам',                  format: 'офис, Астана' },
  sales_remote:   { key: 'sales_remote',   title: 'Менеджер по продажам, удалённо',       format: 'удалённо' },
  support_office: { key: 'support_office', title: 'Менеджер техподдержки (офис, Астана)',  format: 'офис, Астана' },
  support_remote: { key: 'support_remote', title: 'Менеджер техподдержки (удалённо, вечер)', format: 'удалённо' },
};

const MENU = `Здравствуйте и спасибо, что откликнулись!

Нам в Sagi правда важно найти своих людей в команду, поэтому каждую заявку смотрит живой HR, а не "робот в стол".

Кто мы: Sagi - казахстанская платформа лояльности для бизнеса (sagi.kz). Наш Instagram: instagram.com/sagi.bonus (@sagi.bonus) - подписывайтесь, чтобы лучше узнать команду.

Сразу честно: я ИИ-бот, помощник команды найма. Задам несколько коротких вопросов, это всего 2-3 минуты, и передам вашу заявку напрямую рекрутеру. Чем понятнее вы ответите, тем быстрее мы вернёмся: самым подходящим кандидатам пишем уже в течение 1-2 дней.

Давайте начнём. Выберите вакансию, на которую откликаетесь (отправьте 1, 2, 3 или 4):

1) Менеджер по продажам
   - Офис, Астана. Холодные продажи: звонки, поиск клиентов, встречи
   - Оклад 100 000 ₸ + до 120 000 ₸ за KPI + % с продаж

2) Менеджер техподдержки - офис
   - Офис, Астана. График 5/2, смены 09:00-18:00 / 14:00-22:00
   - 200 000 ₸ на руки + бонусы по KPI

3) Менеджер техподдержки - удалённо (вечер)
   - Полностью удалённо. 4 дня в неделю, 18:00-22:00
   - 100 000 ₸ на руки (фикс) + бонусы

4) Менеджер по продажам - удалённо
   - Полностью удалённо. Холодные звонки + онлайн-демо, без офиса и выездов
   - Оклад 100 000 ₸ + до 120 000 ₸ за KPI + % с продаж

Напишите 1, 2, 3 или 4.`;

function parseVacancy(text) {
  const s = (text || '').toLowerCase();
  const d = s.replace(/[^\d]/g, '');
  if (d === '1') return 'sales';
  if (d === '2') return 'support_office';
  if (d === '3') return 'support_remote';
  if (d === '4') return 'sales_remote';
  // по ключевым словам
  const isRemote = /(удал[её]н|дистанц|из дома|онлайн)/.test(s);
  const isSales = /продаж|sales|менеджер по прод/.test(s);
  const isSupport = /поддерж|техпод|support/.test(s);
  if (isSales && isRemote) return 'sales_remote';
  if (isSales) return 'sales';
  if (isSupport && isRemote) return 'support_remote';
  if (isSupport) return 'support_office';
  return null;
}

// ---- Тексты вопросов по сценариям ----
function questions(vac) {
  const title = VAC[vac].title;
  const common = {
    name: `Отлично, вакансия "${title}". Давайте начнём: как вас зовут? (имя и фамилия)`,
    phone: 'Приятно познакомиться! Оставьте ваш номер телефона / WhatsApp для связи.',
  };
  if (vac === 'sales' || vac === 'sales_remote') {
    const remote = vac === 'sales_remote';
    return {
      ...common,
      source: 'Спасибо! Откуда вы узнали о вакансии? (HH, Instagram, по рекомендации и т.п.)',
      resume: 'Отлично. Пришлите ваше резюме текстом или ссылкой (hh.kz, LinkedIn). Можно кратко: опыт, достижения, чем занимались.',
      q1: 'Спасибо! Теперь пара вопросов по делу.\n\n1) Работа это самостоятельный поиск клиентов и холодные звонки/обзвоны (искать ЛПР, звонить "вхолодную"). Готовы так работать? И есть ли у вас такой опыт?',
      q2: '2) Какой ваш лучший результат в продажах? (план / цифры / достижения)',
      q3: remote
        ? '3) Работа полностью удалённая: звонки и онлайн-демонстрации (Zoom/видеозвонок), без офиса и выездов к клиентам. Есть ли у вас стабильный интернет, компьютер/ноутбук и тихое место для звонков весь рабочий день? И когда готовы приступить?'
        : '3) Вы в Астане и готовы работать в офисе? И когда можете приступить?',
    };
  }
  // техподдержка (офис и удалёнка) — общий набор вопросов
  const sup = {
    ...common,
    education: 'Расскажите про образование: какое и где? И вы уже закончили учёбу или ещё учитесь?',
    support_exp: 'Есть ли у вас опыт работы в поддержке / колл-центре / сервисе? Если да, где именно и сколько лет? Если опыта нет, так и напишите.',
    computer: 'Есть ли у вас компьютер или ноутбук для работы?',
    kazakh: 'Разговариваете ли вы на казахском языке? (да / немного / нет)',
    it_exp: 'Есть ли опыт в IT? Работали ли с кассовыми системами (iiko, 1С и т.п.) и есть ли опыт интеграций? Если нет, это не страшно, так и напишите.',
    start: 'И последнее: когда вы готовы выйти на работу?\n\nВажно: перед выходом нужно пройти стажировку в компании, на ней вы освоите продукт Sagi и рабочие скрипты.',
  };
  if (vac === 'support_office') {
    sup.office_terms = `Условия по вакансии "Менеджер техподдержки - офис":
- Офис, Астана
- График 5/2 со скользящими выходными
- Смены: 09:00-18:00 (2 дня в неделю) и 14:00-22:00 (3 дня в неделю)
- 200 000 ₸ на руки + бонусы по KPI
- Работа в паре с другим менеджером поддержки

Важно: это полная занятость, совмещать с другой работой параллельно нельзя.

Вас всё устраивает? (да / нет)`;
  } else {
    sup.internet = 'Работа полностью удалённая, вечерняя смена 18:00-22:00, важно быть онлайн всю смену и отвечать клиентам в течение 5 минут. Есть ли у вас стабильный хороший интернет и спокойное место для работы?';
  }
  return sup;
}

const ORDER = {
  sales: ['name', 'phone', 'source', 'resume', 'q1', 'q2', 'q3'],
  sales_remote: ['name', 'phone', 'source', 'resume', 'q1', 'q2', 'q3'],
  support_office: ['name', 'phone', 'education', 'support_exp', 'computer', 'kazakh', 'it_exp', 'office_terms', 'start'],
  support_remote: ['name', 'phone', 'education', 'support_exp', 'computer', 'kazakh', 'it_exp', 'internet', 'start'],
};

// ---- Скрининг (разные критерии для продаж и поддержки) ----
const SCREEN_SALES = `Ты — HR-скринер Sagi (loyalty-платформа для B2B МСБ). Оцениваешь кандидата на менеджера по ХОЛОДНЫМ продажам (аутрич, звонки, поиск ЛПР, работа с возражениями, закрытие на встречу). Работа: офис в Астане.
КЛЮЧЕВОЙ ФИЛЬТР: кандидат ОБЯЗАН быть готов САМОСТОЯТЕЛЬНО искать ЛПР и делать ХОЛОДНЫЕ звонки/обзвоны. Если из ответов видно, что он НЕ хочет/не готов к холодным звонкам и самостоятельному поиску клиентов (ждёт только тёплые/входящие лиды, «не люблю звонить», только переписка/соцсети) — ставь «Отказ» и низкий балл, и прямо укажи это в summary.
Верни ТОЛЬКО валидный JSON без markdown:
{"score": <0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения>"}`;

const SCREEN_SALES_REMOTE = `Ты — HR-скринер Sagi (loyalty-платформа для B2B МСБ). Оцениваешь кандидата на менеджера по ХОЛОДНЫМ продажам, работающего ПОЛНОСТЬЮ УДАЛЁННО: звонки, поиск ЛПР, работа с возражениями, закрытие сделки через ОНЛАЙН-демонстрацию (Zoom/видеозвонок), без личных встреч и без офиса.
ФИЛЬТР 1: кандидат ОБЯЗАН быть готов САМОСТОЯТЕЛЬНО искать ЛПР и делать ХОЛОДНЫЕ звонки/обзвоны. Если не готов (ждёт только тёплые/входящие лиды, «не люблю звонить», только переписка) — ставь «Отказ» и низкий балл, укажи это в summary.
ФИЛЬТР 2: для удалённой работы критична самодисциплина (никто не контролирует очно) и техническая готовность — стабильный интернет, компьютер/ноутбук, тихое место для звонков и видеозвонков весь рабочий день. Если этого явно нет или кандидат выглядит ненадёжным по этим признакам — снижай балл, вплоть до «Отказ».
Верни ТОЛЬКО валидный JSON без markdown:
{"score": <0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения>"}`;

const SCREEN_SUPPORT = `Ты — HR-скринер Sagi (loyalty-платформа для B2B МСБ). Оцениваешь кандидата на менеджера ТЕХНИЧЕСКОЙ ПОДДЕРЖКИ: приём обращений клиентов в WhatsApp/чатах, решение типовых вопросов по платформе, ведение заявок в CRM, консультации владельцев бизнеса.
ЧТО ВАЖНО: грамотная речь (русский обязателен, казахский — плюс), вежливость и спокойствие с клиентами, дисциплина и ответственность, обучаемость, наличие компьютера/ноутбука. Опыт в поддержке/сервисе/колл-центре — плюс. Опыт в IT, с кассовыми системами (iiko/1С), интеграциями, понимание программ лояльности — плюс.
ДЛЯ УДАЛЁННОЙ вечерней смены критично: стабильный интернет, наличие компьютера, дисциплина, готовность быть онлайн всю смену и отвечать в течение 5 минут.
ДЛЯ ОФИСА критично: готовность к полной занятости БЕЗ совмещения с другой работой.
КРАСНЫЕ ФЛАГИ → «Отказ»/низкий балл: нет компьютера (особенно для удалёнки), неготовность быть онлайн всю смену, желание совмещать с другой работой (для офиса), грубость или явно неграмотная речь.
Верни ТОЛЬКО валидный JSON без markdown:
{"score": <0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения>"}`;

async function screen(vac, name, fullText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let out = { score: null, verdict: 'Резерв', summary: '' };
  if (!apiKey || !fullText) return out;
  const sys = vac === 'sales' ? SCREEN_SALES : vac === 'sales_remote' ? SCREEN_SALES_REMOTE : SCREEN_SUPPORT;
  try {
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: sys, messages: [{ role: 'user', content: `Вакансия: ${VAC[vac].title}\nКандидат: ${name}\n\nАнкета и ответы:\n${fullText.slice(0, 7000)}` }] }),
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
  const text = `🔥 Сильный кандидат (Telegram-бот) — Sagi\n\n🎯 Вакансия: ${rec.vacancy}\n👤 ${rec.name}\n⭐ ${rec.score != null ? rec.score + '/10' : '—'} · ${rec.verdict}\n📞 ${rec.contact}\n\n${rec.summary || ''}\n\nПайплайн: ${SITE}/pipeline.html`;
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }); } catch (e) {}
}

// ---- Ответы на частые вопросы кандидата (с учётом выбранной вакансии) ----
function answerFaq(text, vac) {
  const t = (text || '').toLowerCase();
  if (/(\bбот\b|робот|живой человек|ты человек|вы человек|ты кто|вы кто|это ии|\bии\b|нейросет|искусствен)/.test(t)) return 'Да, я ИИ-бот, помогаю команде найма Sagi собрать и оценить заявки. Дальше с вами обязательно свяжется живой человек.';
  if (/(компани|sagi|саги|чем занима|что за фирм|какой продукт)/.test(t)) return 'Sagi - казахстанская B2B платформа лояльности для малого и среднего бизнеса (sagi.kz): бонусы, кешбэк, уведомления и аналитика для кафе, магазинов и сервисов. Наш Instagram: @sagi.bonus.';
  // Зарплата / формат / обязанности зависят от выбранной вакансии
  if (/(зарплат|оклад|сколько плат|доход|ставк|процент|з\/п|\bзп\b|оплат|деньг|kpi|бонус|заработ)/.test(t)) {
    if (vac === 'support_office') return 'По вакансии техподдержки (офис): 200 000 ₸ на руки + бонусы по KPI. Детали на собеседовании.';
    if (vac === 'support_remote') return 'По вакансии техподдержки (удалёнка, вечер): 100 000 ₸ на руки (фикс) + бонусы. Детали на собеседовании.';
    if (vac === 'sales') return 'По продажам: оклад 100 000 ₸ + до 120 000 ₸ за KPI + проценты с продаж. Топ-менеджеры зарабатывали до 1 500 000 ₸. Детали на собеседовании.';
    if (vac === 'sales_remote') return 'По удалённым продажам условия те же, что в офисе: оклад 100 000 ₸ + до 120 000 ₸ за KPI + проценты с продаж. Детали на собеседовании.';
    return 'Зарплата зависит от вакансии, после выбора я подскажу. По продажам (офис и удалёнка): оклад + KPI + %; по техподдержке: 200 000 ₸ (офис) или 100 000 ₸ фикс (удалёнка, вечер) + бонусы.';
  }
  if (/(удал[её]н|офис|график|формат|режим|из дома|онлайн|город|где наход|локац|астан|где работа|смена|часы)/.test(t)) {
    if (vac === 'support_office') return 'Офис в Астане. График 5/2 со скользящими выходными, смены 09:00-18:00 и 14:00-22:00.';
    if (vac === 'support_remote') return 'Полностью удалённо. Вечерняя смена 18:00-22:00, 4 дня в неделю. Важно быть онлайн всю смену.';
    if (vac === 'sales') return 'Офис в Астане, нужен сотрудник в офис. Если удобнее удалённо, у нас есть отдельная вакансия «Менеджер по продажам, удалённо» с той же оплатой (оклад+KPI+%), просто выберите её в меню.';
    if (vac === 'sales_remote') return 'Полностью удалённо: звонки и онлайн-демонстрации через Zoom/видеозвонки, без офиса и выездов к клиентам. Нужен стабильный интернет, компьютер и тихое место для звонков весь рабочий день.';
    return 'Формат зависит от вакансии: продажи и техподдержка-офис это офис в Астане, продажи-удалёнка и техподдержка-удалёнка из дома.';
  }
  if (/(обязанност|что делать буду|что за работ|чем занима.{0,4}буд|задач)/.test(t)) {
    if (vac === 'sales') return 'Менеджер по продажам предлагает Sagi владельцам бизнеса: звонки, поиск клиентов, встречи и закрытие сделок.';
    if (vac === 'sales_remote') return 'Менеджер по продажам (удалённо) предлагает Sagi владельцам бизнеса: холодные звонки, поиск клиентов, онлайн-демонстрации и закрытие сделок, всё дистанционно.';
    if (vac && vac.startsWith('support')) return 'Техподдержка: принимать обращения клиентов в WhatsApp/чатах, решать вопросы по платформе Sagi, вести заявки в CRM, консультировать владельцев бизнеса.';
    return 'Зависит от вакансии: продажи (звонки, встречи/демо, сделки) или техподдержка (обращения клиентов, заявки в CRM, консультации).';
  }
  if (/(опыт|без опыта|нужен ли опыт|стаж|новичок|студент)/.test(t)) return 'Опыт приветствуется, но главное желание и обучаемость. Продукт специфический, всему научим. Расскажите о себе, мы оценим.';
  if (/(сколько вопрос|долго|сколько врем|сколько займ|это надолго|быстро)/.test(t)) return 'Совсем недолго, пара минут: несколько коротких вопросов о вас.';
  if (/(стажиров|обучени|научат|тренинг)/.test(t)) return 'Перед выходом стажировка, где вы освоите продукт Sagi и рабочие скрипты. Условия уточнит рекрутер.';
  return null;
}

// ---- Финализация: скрининг + запись в пайплайн ----
function buildFullText(vac, d) {
  if (vac === 'sales' || vac === 'sales_remote') {
    return `Резюме/о себе: ${d.resume || '—'}\n\nОпыт холодных продаж: ${d.q1 || '—'}\nЛучший результат: ${d.q2 || '—'}\nГотовность/формат: ${d.q3 || '—'}`;
  }
  const branch = vac === 'support_office'
    ? `Согласие на условия офиса (без совмещения): ${d.office_terms || '—'}`
    : `Удалёнка — интернет/место/готовность быть онлайн: ${d.internet || '—'}`;
  return `Образование: ${d.education || '—'}\nОпыт в поддержке: ${d.support_exp || '—'}\nКомпьютер: ${d.computer || '—'}\nКазахский язык: ${d.kazakh || '—'}\nОпыт IT / кассовые системы / интеграции: ${d.it_exp || '—'}\n${branch}\nГотовность выйти на работу: ${d.start || '—'}`;
}

// Приглашение на ОБУЧЕНИЕ сразу после заявки (не на стажировку — уточнение Sagi 2026-08-18:
// стажировка начинается позже, когда подключается наставник, после прохождения всех 10
// модулей) (2026-08-17, по указанию Sagi «так и всем») — та же философия, что и на hh.kz: не
// держим в подвешенном «рассмотрим и свяжемся». НО только для вакансий продаж (sales/sales_remote)
// — программа обучения на hr.sagibonus.com сейчас вся заточена под продажи (скрипты звонков,
// работа с возражениями, продукт), для техподдержки такой программы пока нет, приглашать туда
// было бы нечестно. Для техподдержки и явного «Отказ» оставляем прежнее «рассмотрим и свяжемся»
// — тут это правда, автоматики после заявки нет.
function buildTgInviteText(name) {
  const n = (name || '').trim().split(/\s+/)[0] || '';
  const greet = n ? `${n}, спасибо за ответы!` : 'Спасибо за ответы!';
  return `${greet}\n\nПриглашаем вас на обучение. Это первый шаг: пройдёте базовую программу, а после неё подключим наставника и перейдёте к стажировке уже на практике.\n\nЧто нужно сделать:\n1) Перейти на hr.sagibonus.com\n2) Нажать на карточку «🎓 Стажёр» и зарегистрироваться (займёт минуту)\n3) Пройти базовую программу (о продукте, скрипты, тесты). Есть встроенный ИИ-тренажёр, чтобы отрабатывать звонки на практике\n\nПодробные условия по доходу: hr.sagibonus.com/usloviya.html\n\nЕсли появятся вопросы, пишите сюда же или в WhatsApp: +7 707 700 0087.`;
}
// Возраст здесь отдельным вопросом не спрашиваем (в отличие от wa.js) — best-effort вытаскиваем
// из свободного текста резюме/о себе, если кандидат сам его упомянул.
function extractAgeFromText(text) {
  const m = String(text || '').match(/(\d{1,2})\s*лет\b/i) || String(text || '').match(/(\d{1,2})\s*год(?:а)?\b/i);
  if (m) { const n = parseInt(m[1], 10); if (n >= 14 && n <= 90) return n; }
  return null;
}
async function finalize(chat, st) {
  const vac = st.vacancy || 'sales';
  const d = st.data || {};
  const fullText = buildFullText(vac, d);
  const ev = await screen(vac, d.name || '', fullText);
  const isSalesVac = vac === 'sales' || vac === 'sales_remote';
  const invited = isSalesVac && ev.verdict !== 'Отказ';
  await tgSend(chat, invited
    ? buildTgInviteText(d.name)
    : 'Спасибо за ответы! Заявка принята, мы рассмотрим её и свяжемся с вами по указанному контакту. Хорошего дня!');
  const phone = digits(d.phone);
  const age = extractAgeFromText(d.resume);
  const rec = {
    id: newId(), name: d.name || 'Из Telegram', contact: d.phone || '', phone, tgChatId: chat,
    vacancy: VAC[vac].title, age,
    // 2026-08-18, по запросу Sagi: помечаем кандидатов вне 20-35, но НЕ авто-отклоняем (ст. 6 ТК
    // РК про дискриминацию по возрасту при приёме) — только пометка, решение всегда за Sagi.
    ageChecked: true, ageOutOfRange: age != null && (age < 20 || age > 35),
    source: 'Telegram-бот · ' + VAC[vac].title + (d.source ? ' (' + d.source + ')' : ''), howFound: d.source || null,
    resume: fullText.slice(0, 2000), score: ev.score, verdict: ev.verdict, summary: ev.summary,
    strengths: [], flags: [], stage: invited ? 'Приглашён' : (ev.verdict === 'Отказ' ? 'Отказ' : 'Новый'), waMessage: waMessage(d.name), ts: Date.now(),
  };
  try { await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]); await redis(['LTRIM', CAND_KEY, 0, 1999]); } catch (e) {}
  await notifyROP(rec);
}

export default async function handler(req, res) {
  // ---- setup webhook ----
  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'setup') {
      if (!BOT) { res.status(400).json({ error: 'CAREERS_BOT_TOKEN не задан в Vercel' }); return; }
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
    // Диагностика: узнать публичный @username бота (нужен для ссылок t.me/... в рекламе/Instagram).
    if (action === 'whoami') {
      if (!BOT) { res.status(400).json({ error: 'CAREERS_BOT_TOKEN не задан в Vercel' }); return; }
      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT}/getMe`);
        const d = await r.json();
        res.status(200).json({ ok: true, username: d?.result?.username ? '@' + d.result.username : null, link: d?.result?.username ? 'https://t.me/' + d.result.username : null, raw: d });
      } catch (e) { res.status(500).json({ error: e.message }); }
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

    // /start или /restart → показать меню вакансий
    if (text === '/start' || text === '/restart') {
      await setState(chat, { step: 'vacancy', vacancy: null, data: {} });
      await tgSend(chat, MENU);
      res.status(200).json({ ok: true }); return;
    }

    let st = await getState(chat);
    if (!st) { await setState(chat, { step: 'vacancy', vacancy: null, data: {} }); await tgSend(chat, MENU); res.status(200).json({ ok: true }); return; }
    if (!text) { res.status(200).json({ ok: true }); return; }
    st.data = st.data || {};

    // Шаг выбора вакансии
    if (st.step === 'vacancy') {
      const vac = parseVacancy(text);
      if (!vac) {
        const f = answerFaq(text, null);
        await tgSend(chat, (f ? f + '\n\n' : 'Не понял выбор. ') + 'Напишите 1, 2, 3 или 4, на какую вакансию откликаетесь.\n\n' + MENU);
        res.status(200).json({ ok: true }); return;
      }
      st.vacancy = vac; st.step = 'name'; await setState(chat, st);
      await tgSend(chat, questions(vac).name);
      res.status(200).json({ ok: true }); return;
    }

    const vac = st.vacancy || 'sales';
    const order = ORDER[vac];
    const Q = questions(vac);
    const i = order.indexOf(st.step);

    if (st.step === 'done') {
      const f = answerFaq(text, vac);
      await tgSend(chat, (f ? f + '\n\n' : '') + 'Ваша заявка уже принята. Если хотите заполнить заново, отправьте /start.');
      res.status(200).json({ ok: true }); return;
    }

    // Если кандидат задал ВОПРОС (а не дал ответ) — поясняем и повторяем текущий вопрос.
    // Важно: распознаём вопрос только по «?» или явному вопросительному началу,
    // иначе обычные ответы со словами «опыт/студент/зарплата» ломали бы диалог.
    const looksQuestion =
      /\?/.test(text) ||
      (text.length < 90 && /^(а\s|это\s|вы\s|ты\s|у вас\s|что|как|какой|какая|какие|какую|кто|где|когда|сколько|почему|зачем|можно|нужно ли|нужен ли|есть ли|правда|расскаж|подскаж|объясн)/i.test(text.trim()));
    if (looksQuestion) {
      const faq = answerFaq(text, vac);
      const ans = faq || 'Хороший вопрос! Точные детали уточнит рекрутер, когда свяжется. А пока продолжим.';
      await tgSend(chat, ans + '\n\n' + Q[st.step]);
      res.status(200).json({ ok: true }); return;
    }

    // сохраняем ответ на текущий шаг
    st.data[st.step] = text.slice(0, 4000);

    // последний шаг сценария → финализация
    if (i === order.length - 1) {
      st.step = 'done'; await setState(chat, st);
      await finalize(chat, st);
      res.status(200).json({ ok: true }); return;
    }
    const next = order[i + 1];
    st.step = next; await setState(chat, st);
    await tgSend(chat, Q[next]);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true }); // Telegram всегда 200
  }
}
