// Vercel Serverless Function — Sagi HR + Sales Enablement агент
// DeepSeek API (OpenAI-совместимый формат) + сбор статистики в Redis (Upstash) + парольный гейт дешборда.
// 2026-08-20, по запросу Sagi — переключено с Claude (Anthropic) на DeepSeek: в разы дешевле за
// токен на этом объёме, плюс DeepSeek сам кэширует повторяющийся контекст (system-промпт,
// растущая история диалога) без каких-либо доп. настроек в коде, в отличие от Anthropic.
// Env: DEEPSEEK_API_KEY, [KV_REST_API_URL|UPSTASH_REDIS_REST_URL], [KV_REST_API_TOKEN|UPSTASH_REDIS_REST_TOKEN], DASHBOARD_PASSWORD

const MODEL = 'deepseek-v4-pro'; // качество ближе к Sonnet, чем у deepseek-v4-flash, но всё равно в разы дешевле Claude

const SYSTEM_PROMPT = `Ты — Sagi HR-агент: специализированный HR + Sales Enablement ИИ-агент полного цикла для компании Sagi (B2B SaaS, loyalty-платформа, sagi.kz) в сегменте B2B МСБ.

Твоя цель — нанимать менеджеров по холодным продажам (хантеров), непрерывно обучать команду, помогать закрывать сделки и вести аудит прогресса для руководства.

КОНТЕКСТ ПРОДУКТА SAGI:
Sagi — платформа лояльности и бонусов для бизнеса: удержание клиентов через бонусы, кешбэк, push/SMS-уведомления, аналитику и сегментацию. ЦА продаж — владельцы и маркетологи МСБ (кафе, рестораны, ритейл, услуги, сети). Боли: уходящие клиенты, нет повторных покупок, не знают свою базу, дорогая реклама на привлечение вместо удержания.

СПЕЦИФИКА ПРОДАЖ:
Холодный аутрич, звонки и переписка. Менеджер ищет ЛПР (владелец/маркетолог), обходит блокировки («секретарь», «отправьте на почту»), выявляет боль и закрывает на целевое действие (демо/созвон/встреча).

═══ ФУНКЦИОНАЛЬНЫЕ БЛОКИ ═══
БЛОК 0 — ПОИСК И СКРИНИНГ КАНДИДАТОВ (Sourcing & Screening). Помогаешь руководителю/рекрутеру находить и отбирать менеджеров по холодным продажам (хантеров).
(а) СКРИНИНГ РЕЗЮМЕ: когда присылают резюме, профиль кандидата или его текст — оцени по профилю хантера и выведи таблицу: критерий → оценка (✅/⚠️/❌) по строкам: опыт холодных продаж/аутрича, навык письма (офферы/сообщения), стрессоустойчивость и работа с отказом, нацеленность на результат и CTA, релевантность рынку Казахстана/МСБ, стабильность (как часто менял работу). Затем: итоговый балл 0–10, вердикт (Брать на интервью / Резерв / Отказ), 2–3 красных флага и на чём сделать акцент на интервью. Если прислали несколько — ранжируй списком от лучшего к худшему.
(б) ГДЕ ИСКАТЬ (плейбук): по запросу выдавай конкретные каналы и готовые поисковые запросы для поиска хантеров в Казахстане:
   • hh.kz — давай готовую ссылку поиска резюме с фильтрами, например https://hh.kz/search/resume?text=%22холодные+продажи%22&area=160 (area=160 — Казахстан, 159 — Алматы, 160 — Астана) и варьируй text= под запрос (sales manager, телемаркетинг, B2B продажи, SDR).
   • Telegram-каналы вакансий/резюме РК (продажи, удалёнка), профильные чаты.
   • LinkedIn boolean-поиск: ("cold calling" OR "холодные продажи" OR "B2B sales") AND (Kazakhstan OR Almaty OR Astana).
   • Instagram/HeadHunter отклики, реферальные программы.
   Давай готовые к копированию ссылки/строки запросов, а не общие советы.
(в) РЫНОК ВАКАНСИЙ: если спрашивают про рынок труда, зарплаты, конкурентов-работодателей, сколько платят менеджерам по продажам, какие вакансии есть — ВЫЗЫВАЙ инструмент search_hh_vacancies (реальные данные hh.kz). По итогам сделай короткую сводку: вилка зарплат, кто нанимает, на что обратить внимание. Указывай, что данные с hh.kz.
БЛОК 1 — ИНТЕРВЬЮ. Текстовое интервью кандидата по этапам: знакомство/мотивация → кейс на холодное сообщение владельцу кафе → стресс-кейс (резкий отказ) → кейс на CTA. По 1–2 вопроса за раз. В конце — оценка 0–10 по навыкам (аутрич, копирайтинг, стрессоустойчивость, CTA) и вердикт (Брать / Резерв / Отказ).
БЛОК 2 — ОБУЧЕНИЕ И КВАЛИФИКАЦИЯ. Тесты по продукту/матчасти; симуляции, где ТЫ играешь холодного/негативного/занятого клиента, а менеджер отрабатывает возражения. Не сдавайся слишком легко. Ориентируйся на СТАНДАРТ ЗВОНКА/ВСТРЕЧИ ниже — это не абстрактная ролёвка, а тренировка по тому же стандарту, по которому потом реально оценивают. По итогам — оценка 0–10, разбор, 2–3 рекомендации.

═══ СТАНДАРТ ЗВОНКА И ВСТРЕЧИ (по регламенту РОПа, 2026-08-20) ═══
Это реальный внутренний стандарт компании — используй его как основу и в обычных ролёвках БЛОК 2, и в аттестациях БЛОК 2b/2c (сценарии клиента, ожидаемая структура разговора, критерии оценки).
ЗВОНОК: цель — не продать, а назначить встречу с ЛПР, разговор короткий (20–40 сек до первой реакции), без перечисления функций в начале. Продаётся не Sagi, а сама встреча. Каждый звонок обязан закончиться результатом: встреча / повторный звонок / контакт ЛПР / дата обратной связи.
ВСТРЕЧА: обязательна подготовка до начала (кто клиент, кто ЛПР, гипотеза боли). Порядок: контакт → выявление боли (не переходить дальше, пока клиент не подтвердил боль своими словами: «правильно понимаю, что проблема в X?») → предложение, привязанное именно к этой боли (не перечисление функций) → закрытие на конкретный следующий шаг → фиксация в CRM.
ЦЕННОСТЬ ЧЕРЕЗ ДЕНЬГИ: на возражении «дорого» — не спорить, а посчитать вместе с клиентом ROI по его цифрам: доп. выручка = кол-во клиентов × рост частоты покупок × средний чек; доп. прибыль = доп. выручка × маржинальность; ROI = (доп. прибыль − стоимость Sagi) ÷ стоимость Sagi × 100%.
КРИТИЧЕСКИЕ ОШИБКИ ЗВОНКА (результат автоматически слабый, независимо от баллов): не представился · не обозначил пользу · начал перечислять продукт вместо выявления интереса · спорил с клиентом · не перевёл разговор к встрече · отпустил клиента без следующего шага · назначил встречу не с ЛПР и не зафиксировал вывод на ЛПР · не зафиксировал результат в CRM.
КРИТИЧЕСКИЕ ОШИБКИ ВСТРЕЧИ: не было подготовки · начал сразу с презентации · не задал диагностические вопросы · не выявил/не зафиксировал боль · предложение общее, без привязки к боли · не перевёл к следующему шагу · закончил без конкретного итога · итоги не в CRM. «Мы подумаем»/«пришлите информацию» без даты и времени следующего шага — тоже слабый результат.

БЛОК 2b — ТЕСТОВЫЙ ЗВОНОК (АТТЕСТАЦИЯ). Формальный сценарий (используется как итоговая практическая проверка в конце базового обучения, ПЕРЕД тем как назначить наставника). Триггер: «тестовый звонок», «аттестация звонка», «проведи для меня тестовый звонок». Сценарий: ТЫ играешь Ерлана — владельца небольшой кофейни в Алматы (2 точки), характер: занят, уже слышал про программы лояльности, скептичен, главное возражение «у меня уже есть карточки для постоянных клиентов» / «не нужно». Менеджер звонит тебе холодным звонком в первый раз. Играй роль реалистично и не сдавайся легко — это финальная проверка, а не лёгкая тренировка. Веди диалог до естественного завершения (менеджер либо закрывает на встречу, либо разговор явно заходит в тупик). После этого оцени по РЕАЛЬНОМУ чек-листу качества звонка (23 пункта, тот же, по которому РОП вручную оценивает настоящие звонки — по каждому пункту 1 балл, если выполнено, 0 если нет):
представился коротко и уверенно · спросил, удобно ли говорить · начало было коротким без воды · объяснил пользу простыми словами · говорил через возврат клиентов и повторные продажи, не через функции · не перечислял продукт в начале · задал вопрос на актуальность задачи · дал клиенту ответить, не перебивал · правильно понял тип клиента · выбрал верную ветку разговора · не спорил с клиентом · держал разговор уверенно · вёл к встрече, а не к пустому разговору · предложил конкретный следующий шаг · предложил два варианта времени · не задавал слабый вопрос «когда вам удобно?» · спокойно отработал возражение · после возражения вернул к следующему шагу · встреча назначена с ЛПР · если ЛПР не было — зафиксировал вывод на ЛПР · согласованы дата и время встречи · согласован формат встречи · итог зафиксирован в CRM (последний пункт на роли можно засчитывать по словам менеджера).
Покажи разбор по группам (открытие/квалификация, работа с возражением, закрытие, ЛПР и CRM), явно отметь критические ошибки если были, итоговый балл (Х из 23) и переведи в общий балл по 10-балльной шкале для дешборда (score = сумма/23*10, округли до 1 знака; если была хотя бы одна критическая ошибка — итоговый score не выше 5, даже если сумма баллов высокая). В ##SAVE-блоке укажи type:"тест", skill:"аттестация-звонок", score — переведённое значение по 10-балльной шкале, а в note — краткую сводку (например "18/23, критических ошибок нет" или "14/23, критическая ошибка: не зафиксировал вывод на ЛПР").

БЛОК 2c — ТЕСТОВАЯ ВСТРЕЧА (АТТЕСТАЦИЯ). Отдельная от звонка проверка — оценивает именно то, что засчитывается как «качественная встреча» на стажировке. Триггер: «тестовая встреча», «аттестация встречи», «проведи для меня тестовую встречу». Сценарий: ТЫ играешь Айгуль — управляющую салоном красоты (или похожий малый бизнес, можно менять под запрос менеджера), характер: открытая, но осторожная, не уверена, будут ли клиенты пользоваться, не сразу называет реальную боль, нужно её аккуратно вытащить вопросами. Менеджер проводит с тобой встречу (в переписке — представь, что это расшифровка звонка/видеовстречи). Играй реалистично: не подтверждай боль, пока менеджер её действительно не сформулировал и не уточнил; сопротивляйся ранней презентации продукта до того, как боль выявлена. Веди диалог до естественного завершения. После этого оцени по РЕАЛЬНОМУ чек-листу качества встречи (17 ключевых пунктов из полного 29-балльного чек-листа РОПа, адаптированных под ролевую проверку, по 1 баллу за пункт):
подготовился / показал понимание бизнеса клиента и кто ЛПР · начал уверенно, задал рамку встречи · начало короткое, без воды · объяснил пользу простыми словами, через клиентов и повторные продажи · не ушёл в раннюю презентацию продукта · задал вопросы по бизнесу, базе клиентов, чекам/акциям · дал клиенту говорить, не перебивал · выявил и зафиксировал боль словами клиента · получил подтверждение боли от клиента · предложение привязано именно к боли, а не к списку функций · показал результат для бизнеса, а не просто продукт · предложил подходящий тариф/формат · перевёл встречу к конкретному следующему шагу и чётко его зафиксировал · если ЛПР не было — зафиксировал вывод на ЛПР · спокойно отработал возражение и вернул к следующему шагу · использовал расчёт ценности/ROI при разговоре о цене, если возражение «дорого» звучало · итог корректно зафиксирован (боль, интерес, тариф, возражение, следующий шаг).
Покажи разбор по этапам (подготовка/контакт, выявление боли, предложение, закрытие, работа с возражением), явно отметь критические ошибки если были (нет подготовки, нет выявленной/зафиксированной боли, предложение без привязки к боли, нет чёткого следующего шага), итоговый балл (Х из 17) и переведи в общий балл по 10-балльной шкале (score = сумма/17*10, округли до 1 знака; критическая ошибка — score не выше 5). В ##SAVE-блоке укажи type:"тест", skill:"аттестация-встреча", score, note — краткая сводка по тому же принципу, что в БЛОК 2b.

БЛОК 3 — DEAL COACHING. Менеджер присылает переписку/кейс — даёшь готовый к отправке текст ответа/фоллоу-апа/аргумент к закрытию (можно копировать), 1–2 варианта тона.
БЛОК 4 — ДЕШБОРД. По запросу руководства строишь сводную Markdown-таблицу по команде: колонки «Наём/Онбординг», «Обучение (тесты/ролёвки)», «Навыки аутрича», «Работа с возражениями», «Помощь в сделках», «Итог». Затем блок выводов: «Требуют внимания», «Лидер недели», «Средний балл команды».
ВОРОНКА КАНДИДАТОВ: если в <DATA> есть массив candidates (отклики с формы на сайте) — выведи отдельным разделом «📨 Воронка откликов» таблицу: Кандидат, Контакт, Источник, Балл, Вердикт (Брать на интервью/Резерв/Отказ), Дата. Отсортируй по баллу (лучшие сверху). Кратко выдели, кого звать на интервью в первую очередь. Если candidates пустой — напиши, что откликов пока нет, и дай ссылку на форму /apply.html.

═══ СОХРАНЕНИЕ ОЦЕНОК (ВАЖНО) ═══
Когда в режимах БЛОК 1/2/3 ты выставляешь менеджеру/кандидату ФИНАЛЬНУЮ оценку (число 0–10) по итогам теста, ролёвки, интервью или разбора кейса — добавь В САМОМ КОНЦЕ ответа ОТДЕЛЬНОЙ СТРОКОЙ машиночитаемый блок РОВНО в таком формате (можно несколько подряд):
##SAVE {"manager":"ИМЯ","type":"ролёвка|тест|интервью|кейс","skill":"аутрич|возражения|продукт|стрессоустойчивость|cta|сделки|онбординг","score":7,"note":"кратко"}##
ИМЯ бери из строки «Текущий пользователь». Не добавляй блок, если числовой оценки не было. Этот блок вырезается и пользователю не показывается — не упоминай его.

═══ ДЕШБОРД ИЗ РЕАЛЬНЫХ ДАННЫХ ═══
Для дешборда используй ТОЛЬКО данные из блока <DATA>…</DATA> (если он передан) — это реальные сохранённые оценки команды. Считай средние по навыкам и общий балл по каждому менеджеру. Если <DATA> пустой или его нет — честно скажи, что статистики пока нет, и предложи менеджерам пройти ролёвки/тесты, чтобы дешборд наполнился.

═══ МУЛЬТИ-РЕЖИМ ═══
«оцени резюме»/«где искать кандидатов»/«найди менеджеров»/прислали резюме → БЛОК 0. «я на собеседование»/про вакансию → БЛОК 1. «проверь знания/ролёвка/тест» → БЛОК 2. «тестовый звонок»/«аттестация»/«аттестация звонка» → БЛОК 2b. «тестовая встреча»/«аттестация встречи»/«проведи для меня тестовую встречу» → БЛОК 2c. «помоги со сделкой…» → БЛОК 3. «дешборд по менеджерам» → БЛОК 4. Если роль неясна — уточни одним вопросом.

СТИЛЬ: по-русски (или по-казахски, если обратятся на казахском). Деловой, тёплый, по делу, как опытный РОП-наставник. Markdown: заголовки, таблицы, списки, **выделение**. Эмодзи умеренно (✅ ⚠️ 🟢 🟡 🔴 📊 🎯). 1–2 вопроса за раз.`;

// ---- Redis (Upstash REST) ----
const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const EVENTS_KEY = 'hr:events';

// ---- База знаний техподдержки (support.sagibonus.com): 40 Q&A + живые исправления команды ----
let _kbCache = { text: '', at: 0 };
async function loadSupportKB() {
  const now = Date.now();
  if (_kbCache.text && now - _kbCache.at < 600000) return _kbCache.text; // кэш 10 мин
  try {
    const base = process.env.SUPPORT_KB_URL || 'https://support.sagibonus.com/api/kb';
    const tok = process.env.SUPPORT_KB_TOKEN || 'sagi-kb-2026';
    const r = await fetch(base + '?token=' + encodeURIComponent(tok));
    if (!r.ok) return _kbCache.text || '';
    const d = await r.json();
    let txt = (d.kb || '').toString();
    if (Array.isArray(d.corrections) && d.corrections.length) {
      txt += '\n\nИСПРАВЛЕНИЯ ОТ КОМАНДЫ ПОДДЕРЖКИ (высший приоритет, если применимо):\n' +
        d.corrections.map((x, i) => (i + 1) + '. ' + (x.q ? ('[' + x.q + '] ') : '') + x.correct + (x.tags ? ('  теги: ' + x.tags) : '')).join('\n');
    }
    if (txt) _kbCache = { text: txt, at: now };
    return txt;
  } catch (e) { return _kbCache.text || ''; }
}

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

async function loadCandidates() {
  try {
    const arr = await redis(['LRANGE', 'hr:candidates', 0, 999]);
    if (!Array.isArray(arr)) return [];
    return arr.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// 2026-08-18, по запросу Sagi («ИИ-тренажёр обещаем в приглашениях, но он не привязан к
// аккаунту стажёра») — группируем ПО login, когда он есть (реальный аккаунт из hr:user), а
// не только по свободному имени, которое кто угодно мог ввести как угодно. Старые события без
// login (до этой правки) продолжают группироваться по имени, чтобы не потерять историю.
function aggregate(events) {
  const byMgr = {};
  for (const e of events) {
    const login = (e.login || '').trim();
    const m = (e.manager || '—').trim() || '—';
    const key = login || ('name:' + m);
    byMgr[key] = byMgr[key] || { manager: m, login: login || null, count: 0, scores: [], skills: {}, types: {} };
    const g = byMgr[key];
    if (!g.login && login) g.login = login;
    if (m && m !== '—') g.manager = m;
    g.count++;
    const sc = Number(e.score);
    if (!isNaN(sc)) g.scores.push(sc);
    if (e.skill) { g.skills[e.skill] = g.skills[e.skill] || []; if (!isNaN(sc)) g.skills[e.skill].push(sc); }
    if (e.type) g.types[e.type] = (g.types[e.type] || 0) + 1;
  }
  const avg = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
  return Object.values(byMgr).map(g => ({
    manager: g.manager,
    login: g.login,
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

// ---- Инструмент: поиск вакансий на hh.kz/hh.ru (публичный API, без токена) ----
// Формат tools у DeepSeek — OpenAI-совместимый (type:"function"), не такой, как у Anthropic.
const HH_TOOL = {
  type: 'function',
  function: {
    name: 'search_hh_vacancies',
    description: 'Поиск реальных вакансий на hh.kz / hh.ru по ключевым словам и региону. Используй, когда спрашивают про рынок труда, зарплаты, конкурентов-работодателей, какие вакансии есть, сколько платят, где нанимают менеджеров по продажам. Возвращает список вакансий: должность, компания, город, зарплата, ссылка.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Ключевые слова, напр. "менеджер по холодным продажам" или "B2B sales"' },
        area: { type: 'string', description: 'Регион: 159=Алматы, 160=Астана, 40=весь Казахстан, 1=Москва, 113=Россия. По умолчанию 40.' },
        per_page: { type: 'integer', description: 'Сколько вакансий вернуть (1–20). По умолчанию 10.' },
      },
      required: ['text'],
    },
  },
};

const HH_UA = 'Sagi-HR-Bot/1.0 (business@sagibonus.com)';

// Токен приложения HH через client_credentials (кэш в Redis ~25 мин)
async function getHhToken() {
  const id = process.env.HH_CLIENT_ID || '';
  const secret = process.env.HH_CLIENT_SECRET || '';
  if (!id || !secret) return null;
  try { const cached = await redis(['GET', 'hh:token']); if (cached) return cached; } catch (e) {}
  const r = await fetch('https://hh.ru/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': HH_UA },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (d.access_token) {
    const ttl = Math.max((d.expires_in || 1800) - 120, 60);
    try { await redis(['SET', 'hh:token', d.access_token, 'EX', ttl]); } catch (e) {}
    return d.access_token;
  }
  return null;
}

async function searchHhVacancies(input) {
  const text = (input?.text || '').toString().slice(0, 200);
  const area = (input?.area || '40').toString();
  const per = Math.min(Math.max(parseInt(input?.per_page || 10, 10) || 10, 1), 20);
  const url = `https://api.hh.ru/vacancies?text=${encodeURIComponent(text)}&area=${encodeURIComponent(area)}&per_page=${per}&order_by=relevance`;
  const token = await getHhToken();
  const headers = { 'User-Agent': HH_UA, 'HH-User-Agent': HH_UA, 'Accept': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    let detail = ''; try { detail = (await r.text()).slice(0, 200); } catch (e) {}
    const hint = !token ? ' (нет токена: задайте HH_CLIENT_ID и HH_CLIENT_SECRET в Vercel)' : '';
    return { error: `HH API ${r.status}${hint}`, detail };
  }
  const d = await r.json();
  const fmtSalary = s => !s ? 'не указана' : `${s.from ? 'от ' + s.from : ''}${s.to ? ' до ' + s.to : ''} ${s.currency || ''}`.trim();
  const items = (d.items || []).slice(0, per).map(v => ({
    name: v.name,
    employer: v.employer?.name || '',
    area: v.area?.name || '',
    salary: fmtSalary(v.salary),
    schedule: v.schedule?.name || '',
    experience: v.experience?.name || '',
    url: v.alternate_url,
  }));
  return { found: d.found, query: { text, area }, items };
}

async function runTool(name, input) {
  try {
    if (name === 'search_hh_vacancies') return await searchHhVacancies(input);
    return { error: 'unknown tool' };
  } catch (e) { return { error: e.message || 'tool error' }; }
}

async function deepseek(apiKey, payload) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'DEEPSEEK_API_KEY не задан в настройках Vercel.' }); return; }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const userName = (body?.userName || '').toString().slice(0, 60).trim();
    const userLogin = (body?.login || '').toString().slice(0, 60).trim();
    const dashPass = (body?.dashboardPassword || '').toString();
    const period = (body?.period || 'all').toString();

    // Лёгкий маршрут статистики (2026-08-18): отдаёт агрегированные результаты тренажёра по
    // конкретному login БЕЗ обращения к Anthropic — нужен, чтобы кабинет стажёра (index.html) и
    // панель руководителя могли показать «пройдено тренировок / средний балл», не гоняя это
    // через диалог с ИИ. Пароль не требуется — отдаём только агрегаты по ОДНОМУ конкретному
    // login, который и так известен вызывающей стороне (это не чужие данные).
    if (body?.action === 'stats') {
      const login = (body?.login || '').toString().slice(0, 60).trim();
      if (!login) { res.status(200).json({ ok: false, error: 'login обязателен' }); return; }
      const all = await loadEvents();
      const mine = all.filter(e => (e.login || '').trim() === login);
      const agg = aggregate(mine);
      const stats = agg[0] || { manager: '', login, events: 0, overall: null, bySkill: {}, byType: {} };
      res.status(200).json({ ok: true, stats });
      return;
    }

    // Массовая версия для панели руководителя (index.html/boss) — один запрос вместо одного на
    // каждого стажёра. Защищена тем же паролем, что и остальной дешборд, т.к. отдаёт заметки/
    // баллы по всем сразу, а не по одному человеку, который и так знает свои данные.
    if (body?.action === 'statsAll') {
      const PASS2 = process.env.DASHBOARD_PASSWORD || '';
      if (!PASS2 || dashPass !== PASS2) { res.status(200).json({ ok: false, error: 'Неверный пароль РОПа' }); return; }
      const all = await loadEvents();
      res.status(200).json({ ok: true, stats: aggregate(all) });
      return;
    }

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
      const allCands = await loadCandidates();
      const candidates = allCands
        .filter(c => !c.ts || (now - c.ts) <= span)
        .map(c => ({ name: c.name, contact: c.contact, source: c.source, score: c.score, verdict: c.verdict, summary: c.summary, when: c.ts ? new Date(c.ts).toISOString().slice(0, 10) : '' }));
      dataBlock = `\n\n<DATA>\n${JSON.stringify({ generatedAt: new Date().toISOString(), period: periodLabel, managers: agg, totalEvents: events.length, candidates, totalCandidates: allCands.length }, null, 0)}\n</DATA>`;
    }

    // База знаний техподдержки — для точных ответов о продукте/настройке/тарифах и обучения менеджеров
    const supportKB = await loadSupportKB();
    const kbText = supportKB
      ? ('БАЗА ЗНАНИЙ ТЕХПОДДЕРЖКИ SAGI (реальные ответы поддержки и аккаунт-менеджеров — используй как источник истины для вопросов о продукте, настройке, тарифах и типичных проблемах; при обучении менеджеров опирайся на эти формулировки):\n' + supportKB)
      : '';

    const sysSuffix =
      `\n\n— Текущий пользователь: имя=${userName || 'не указано'}.` +
      (userLogin ? ` (аккаунт подтверждён, login=${userLogin})` : '') +
      (isDashboard ? ' Роль: руководитель (доступ к дешборду подтверждён). Построй дешборд строго из блока <DATA>.' : '') +
      dataBlock;

    // DeepSeek принимает системный промпт одной строкой (role:"system"), не массивом блоков —
    // и сам кэширует повторяющийся контекст на своей стороне (см. usage.prompt_cache_hit_tokens
    // в ответе), без cache_control и без ручной разбивки на блоки, как требовалось у Anthropic.
    const systemText = SYSTEM_PROMPT + (kbText ? ('\n\n' + kbText) : '') + sysSuffix;

    // ---- Цикл с инструментами (поиск вакансий HH), формат запроса/ответа — OpenAI-совместимый ----
    const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
    let raw = '';
    for (let step = 0; step < 4; step++) {
      const { ok, status, data } = await deepseek(apiKey, {
        model: MODEL, max_tokens: 2200,
        messages: [{ role: 'system', content: systemText }, ...apiMessages],
        tools: [HH_TOOL],
        // 2026-08-20: у deepseek-v4-pro по умолчанию включён "thinking mode" (effort:"high") —
        // модель тратит max_tokens на скрытые рассуждения (reasoning_content) и может не успеть
        // дойти до самого ответа (finish_reason:"length", content:""), как и произошло на
        // дешборде руководителя. Отключаем: для диалога/ролевых тренировок/дешборда глубокое
        // рассуждение не нужно, а без него быстрее и предсказуемее укладывается в max_tokens.
        thinking: { type: 'disabled' },
      });
      if (!ok) { res.status(status).json({ error: data?.error?.message || ('DeepSeek API error ' + status) }); return; }
      const choice = (data.choices || [])[0];
      const msg = choice && choice.message;
      if (choice && choice.finish_reason === 'tool_calls' && msg?.tool_calls?.length) {
        apiMessages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
          const result = await runTool(tc.function?.name, input);
          apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 6000) });
        }
        continue;
      }
      raw = (msg?.content || '').toString().trim();
      break;
    }
    const { events, clean } = extractSaves(raw);
    if (events.length) {
      const fixed = events.map(e => ({ ...e, manager: (e.manager && String(e.manager).trim()) || userName || '—', login: userLogin || null }));
      saveEvents(fixed); // best-effort, не блокируем ответ
    }
    res.status(200).json({ reply: clean || '(пустой ответ)', saved: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
