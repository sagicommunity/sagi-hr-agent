// Vercel Serverless Function — приём отклика кандидата + авто-скрининг (Claude) + сохранение в Redis.
// 2026-08-19, по указанию Sagi: резюме больше не запрашиваем вообще («зачем нам резюме, если можем
// выявить нужные моменты через вопросы») — вместо одного поля «резюме/о себе» форма (apply.html)
// теперь задаёт короткую структурированную анкету (те же вопросы, что раньше шли в переписке
// hh.kz/Telegram) с готовыми вариантами ответа (chips) там, где это уместно, плюс возраст и город.
// POST { name, contact, age?, city, source, expSales, techReady, noCombine, startWhen, comment?, referrerName?, referrerPhone?, vacancy, refId? }
//   → { ok, score, verdict, summary }

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CAND_KEY = 'hr:candidates';

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

// 2026-08-19, по указанию Sagi: вопросы больше не задаём в переписке (hh.kz-чат, Telegram-бот) —
// сразу шлём короткую ссылку на эту форму, а сама анкета/скрининг происходит здесь. Чтобы кандидат,
// который уже был заведён в hr:candidates при интейке (hh_<negId> из api/hh_poll.js, tg_<chatId> из
// api/tg.js), не задваивался при заполнении формы — ссылка несёт ?src=...&neg=/chat=..., фронтенд
// (apply.html) собирает из этого refId и шлёт его сюда. Если по refId нашлась существующая запись —
// ОБНОВЛЯЕМ её (сохраняя тот же id, значит и все внешние ссылки на неё остаются рабочими), иначе —
// создаём новую запись как раньше (обычный органический трафик на apply.html без метки).
async function findAndUpdateCandidate(id, patch) {
  if (!id) return null;
  const raw = await redis(['LRANGE', CAND_KEY, 0, -1]);
  if (!Array.isArray(raw)) return null;
  for (let i = 0; i < raw.length; i++) {
    let rec; try { rec = JSON.parse(raw[i]); } catch (e) { continue; }
    if (rec && rec.id === id) {
      const updated = { ...rec, ...patch, id: rec.id };
      await redis(['LSET', CAND_KEY, i, JSON.stringify(updated)]);
      return updated;
    }
  }
  return null;
}

// 2026-08-19, по прямому указанию Sagi: резюме не запрашиваем, оцениваем СТРОГО по структурированным
// ответам анкеты (см. buildScreenPrompt ниже). Отсутствие опыта холодных звонков и отсутствие
// компьютера/интернета на старте — НЕ повод для отказа. Всему учат на обучении: сначала звонки,
// выход на ЛПР, назначение встреч — первые 1-2 недели саму встречу/демо проводит наставник, и только
// потом стажёр ведёт их сам. Поэтому «Отказ» — только для явных красных флагов из анкеты (см. ниже),
// а не для отсутствия опыта.
function buildScreenPrompt(isRemote) {
  const workLine = isRemote
    ? 'работающего ПОЛНОСТЬЮ УДАЛЁННО: звонки, поиск ЛПР, работа с возражениями, закрытие сделки через ОНЛАЙН-демонстрацию (Zoom/видеозвонок), без офиса и личных встреч'
    : 'звонки, поиск ЛПР, работа с возражениями, закрытие на встречу. Работа: офис в Астане';
  const techFlag = isRemote
    ? '\n- явно нет компьютера/ноутбука или стабильного интернета — это обязательное условие для полностью удалённой работы;'
    : '';
  return `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ, sagi.kz). Оцениваешь кандидата на позицию менеджера по продажам, ${workLine}.

ВАЖНО: это стартовая позиция, всему учат на обучении. Резюме не запрашиваем — оценивай СТРОГО по структурированным ответам анкеты ниже, не додумывай. Отсутствие опыта продаж или холодных звонков — НЕ повод для отказа, это нормально для новичка.

Реальные красные флаги, из-за которых можно поставить «Отказ»:
- кандидат прямо говорит, что холодные звонки не для него, или готов работать только с тёплыми лидами;${techFlag}
- на вопрос про совмещение прямо говорит, что не готов(а) менять приоритеты ради этой работы (вариант «Есть, и не готов(а) менять приоритеты») — неважно, что именно занимает время: другая работа, учёба, свои проекты, уход за ребёнком и т.п. — при таком ответе человек сам говорит, что не сможет выделить нужную вовлечённость, это не дискриминация по обстоятельствам, а честный сигнал от самого кандидата;
- явная грубость, неадекватность или полное отсутствие мотивации в комментарии.

Если кандидат отвечает, что что-то отнимает время, но готов(а) расставить приоритеты и уделять достаточно времени (вариант «Есть, но готов(а) поставить это в приоритет») — это НЕ автоматический отказ, но обязательно упомяни это в summary как момент, который стоит уточнить лично: сможет ли человек на практике держать нужную вовлечённость на стажировке (максимальная активность, ответственность за своё и чужое время — это будет сразу видно по факту).

Во всех остальных случаях ставь «Брать на интервью» или «Резерв» (используй «Резерв» при неоднозначных сигналах, не спеши сразу на «Отказ»).

Верни ТОЛЬКО валидный JSON, без markdown и пояснений:
{"score": <число 0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения по сути>", "strengths": ["<сильная сторона>", ...], "flags": ["<красный флаг>", ...]}`;
}

const VAC_TITLES = {
  sales: 'Менеджер по продажам',
  sales_remote: 'Менеджер по продажам, удалённо',
  success_remote: 'Менеджер по работе с текущими клиентами, удалённо',
  support_remote: 'Специалист технической поддержки, удалённо',
};

// 2026-08-23, по указанию Sagi: вторая вакансия на той же ссылке (apply.html?vac=success) —
// работа с ТЕКУЩЕЙ базой клиентов (продления, обучение клиента продукту, кросс-партнёрства между
// клиентами Sagi, рост базы через рекомендации от текущих клиентов). Это НЕ холодные продажи —
// красные флаги здесь другие: не «холодные звонки не моё» (это не относится к роли), а явное
// нежелание общаться с текущими клиентами / отсутствие вовлечённости.
//
// 2026-08-23, ПРАВКА ПОЛИТИКИ от Асемгуль (COO), передано через Sagi: в отличие от продаж (где
// «invited=true» для всех, см. handler ниже), для этой роли явно нужен гейт — «оценить клиента
// через бот по требованиям, тем кто соответствует по требованиям на 90% звать на собеседование».
// Поэтому здесь, в отличие от buildScreenPrompt (продажи), ИИ обязан вернуть matchPercent —
// это единственная вакансия, где ИИ-оценка реально решает, не просто справка в Telegram.
function buildSuccessScreenPrompt() {
  return `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ, sagi.kz). Оцениваешь кандидата на позицию менеджера по работе с текущими клиентами, работающего ПОЛНОСТЬЮ УДАЛЁННО: ведение базы текущих клиентов — контроль продлений, помощь клиентам с продуктом, организация партнёрств между клиентами Sagi, рост базы через рекомендации от довольных клиентов.

ВАЖНО: это не холодные продажи — кандидат работает с уже существующими клиентами компании. Резюме не запрашиваем — оценивай СТРОГО по структурированным ответам анкеты ниже, не додумывай.

Требования к позиции (по ним считай matchPercent — процент 0-100, насколько кандидат ИМ соответствует):
1. Свободный русский, разговорный казахский (не «плюс», а требование).
2. Опыт работы с текущими клиентами / удержанием, желательно на подписке или повторяющихся платежах — отсутствие опыта снижает процент, но не обнуляет его, если остальное сильное.
3. Уверенное владение WhatsApp Business и готовность полноценно пользоваться ИИ-инструментами (ChatGPT/Claude) в повседневной работе.
4. Самостоятельность — готов(а) звонить и писать без напоминаний, реальная вовлечённость (смотри ответ про совмещение с другими делами).
5. Компьютер/ноутбук и стабильный интернет — обязательное условие для полностью удалённой работы.

Считай matchPercent как честную интегральную оценку по всем пунктам выше (не только по казахскому — если кандидат прямо ответил «не говорю по-казахски», это ощутимо снижает процент, но остальные сильные пункты всё равно учитываются). Явная грубость, неадекватность или полное отсутствие мотивации в комментарии — резко снижай matchPercent.

Верни ТОЛЬКО валидный JSON, без markdown и пояснений:
{"matchPercent": <число 0-100>, "score": <число 0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения по сути, включая по какому пункту(-ам) недобор, если есть>", "strengths": ["<сильная сторона>", ...], "flags": ["<красный флаг>", ...]}`;
}

// 2026-08-23, по указанию Sagi: третья вакансия на той же ссылке (apply.html?vac=support) —
// техподдержка клиентов Sagi (отвечает на вопросы в WhatsApp/чате, разбирает типовые технические
// проблемы, проводит интеграцию клиентам, эскалирует сложное разработчикам). Sagi явно сказал
// сделать «так же, как первая вакансия» (продажи) — то есть БЕЗ гейта по проценту, как у
// success_remote: invited=true для всех (см. handler ниже), эта оценка — только справка в Telegram,
// как у продаж, а не решающий фактор.
// 2026-08-24, по указанию Sagi: конкретный список вопросов для техподдержки (кассовые интеграции,
// объём заявок в день, CRM Битрикс24, совмещение с другой работой/учёбой, наличие ноутбука, опыт
// в Product Management, готовность приступить) — заменил общий вопросник. Комфорт с ИИ-инструментами
// больше НЕ отдельный обязательный вопрос для этой роли (убран по этому же указанию).
function buildSupportScreenPrompt() {
  return `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ, sagi.kz). Оцениваешь кандидата на позицию специалиста технической поддержки, работающего ПОЛНОСТЬЮ УДАЛЁННО: отвечает клиентам в WhatsApp/чате, разбирает типовые технические проблемы (вход в аккаунт, начисление/списание бонусов, интеграции), проводит интеграцию клиентам, эскалирует сложное разработчикам.

ВАЖНО: это стартовая позиция, это НЕ холодные продажи и НЕ работа на удержание/рост базы — кандидат реагирует на входящие обращения клиентов. Резюме не запрашиваем — оценивай СТРОГО по структурированным ответам анкеты ниже, не додумывай. Отсутствие опыта именно в техподдержке — НЕ повод для отказа, это нормально для новичка.

Опыт интеграции с кассовыми системами (iiko, r-keeper, 1С, МойСклад и т.п.), уровень CRM Битрикс24 и опыт в Product Management — это ПЛЮСЫ, не обязательные требования: их отсутствие НЕ повод для отказа, просто учитывай при оценке (сильнее кандидат — выше score, но verdict «Отказ» ставь только за реальные красные флаги ниже).

Реальные красные флаги, из-за которых можно поставить «Отказ»:
- кандидат прямо говорит, что общение с клиентами / разбор их проблем — не его(её);
- явно нет ноутбука — обязательное условие для полностью удалённой работы;
- на вопрос про совмещение прямо говорит, что не готов(а) менять приоритеты ради этой работы;
- явная грубость, неадекватность или полное отсутствие мотивации в комментарии.

Во всех остальных случаях ставь «Брать на интервью» или «Резерв» (используй «Резерв» при неоднозначных сигналах, не спеши сразу на «Отказ»).

Верни ТОЛЬКО валидный JSON, без markdown и пояснений:
{"score": <число 0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения по сути>", "strengths": ["<сильная сторона>", ...], "flags": ["<красный флаг>", ...]}`;
}

// Уведомление в Telegram по КАЖДОЙ заявке через форму (2026-08-17: единая политика с hh.kz и
// Telegram-ботом — раньше алертило только по «сильным», из-за чего заявки молча терялись и
// оставались без реакции — кандидаты потом сами писали, дошло ли). Финальное решение всё равно
// за Sagi, но теперь он хотя бы видит каждую заявку.
async function notifyTelegram(rec) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  const strong = rec.verdict === 'Брать на интервью' || (typeof rec.score === 'number' && rec.score >= 7);
  const refLine = rec.referrerPhone ? `\n🎁 По рекомендации: ${rec.referrerName || '—'}, ${rec.referrerPhone}` : '';
  // matchPercent есть только у success_remote (гейт от Асемгуль) — показываем, если известен, чтобы
  // было видно, почему кандидат попал в «Интервью»/«Отказ»/«Квалификация» (см. api/apply.js handler).
  const matchLine = (typeof rec.matchPercent === 'number') ? `\n🎯 Соответствие требованиям: ${rec.matchPercent}%` : '';
  const text =
    `${strong ? '🔥 Сильный кандидат' : '💬 Новая заявка'} (форма отклика) — Sagi\n\n` +
    `🎯 Вакансия: ${rec.vacancy}\n` +
    `👤 ${rec.name}\n` +
    `⭐ ${rec.score != null ? rec.score + '/10' : '—'} · ${rec.verdict}${matchLine}\n` +
    `📞 ${rec.contact}\n` +
    `📍 Источник: ${rec.source}${refLine}\n\n` +
    `${rec.summary || ''}\n\n` +
    `Открыть пайплайн: https://hr.sagibonus.com/pipeline.html`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (e) {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY не задан' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const name = (body?.name || '').toString().slice(0, 80).trim();
    const contact = (body?.contact || '').toString().slice(0, 120).trim();
    const ageRaw = body?.age;
    const age = (typeof ageRaw === 'number' && ageRaw >= 14 && ageRaw <= 75) ? ageRaw : null;
    const city = (body?.city || '').toString().slice(0, 80).trim();
    const source = (body?.source || '').toString().slice(0, 80).trim();
    const expSales = (body?.expSales || '').toString().slice(0, 200).trim();
    const techReady = (body?.techReady || '').toString().slice(0, 200).trim();
    const noCombine = (body?.noCombine || '').toString().slice(0, 200).trim();
    const startWhen = (body?.startWhen || '').toString().slice(0, 120).trim();
    const comment = (body?.comment || '').toString().slice(0, 2000).trim();
    // 2026-08-19, реферальная программа (по указанию Sagi): друг указывает, кто из сотрудников/
    // стажёров его порекомендовал — имя и телефон, БЕЗ сверки с базой сотрудников («без проверки»,
    // решение Sagi). $50 начисляется, если этот друг проработает от 2 месяцев ИЛИ сделает продажу
    // в первый месяц — это считает api/pipeline.js (computeReferralStatus) и вручную отмечает Sagi.
    const referrerName = (body?.referrerName || '').toString().slice(0, 80).trim();
    const referrerPhone = (body?.referrerPhone || '').toString().slice(0, 60).trim();
    // 2026-08-23: добавлены вторая (success_remote) и третья (support_remote) вакансии на той же
    // ссылке apply.html.
    const vacancy = (body?.vacancy === 'sales_remote') ? 'sales_remote'
      : (body?.vacancy === 'success_remote') ? 'success_remote'
      : (body?.vacancy === 'support_remote') ? 'support_remote' : 'sales';
    const isRemote = vacancy !== 'sales';
    const isSuccess = vacancy === 'success_remote';
    const isSupport = vacancy === 'support_remote';
    const vacTitle = VAC_TITLES[vacancy];
    // Комфорт с ИИ-инструментами — вопрос ТОЛЬКО для success_remote (см. apply.html: showAiComfort).
    // 2026-08-24, по указанию Sagi: для support_remote этот вопрос убран — заменён конкретным
    // списком вопросов (кассовые интеграции, Битрикс24, Product Management и т.д., см. ниже).
    // Уровень казахского — вопрос ТОЛЬКО для success_remote (см. apply.html: showKazakh), добавлен
    // 2026-08-23 по правке Асемгуль (COO): для этой роли это реальное требование, а не «плюс».
    const aiComfort = (body?.aiComfort || '').toString().slice(0, 200).trim();
    const kazakh = (body?.kazakh || '').toString().slice(0, 200).trim();
    // 2026-08-24, по указанию Sagi: конкретные вопросы для support_remote (список от Sagi) —
    // кассовые интеграции, объём обращений в день, CRM Битрикс24, Product Management. cashIntegrationDetail
    // и supportTicketsPerDay — необязательные уточнения (не блокируют отправку формы).
    const cashIntegration = (body?.cashIntegration || '').toString().slice(0, 200).trim();
    const cashIntegrationDetail = (body?.cashIntegrationDetail || '').toString().slice(0, 200).trim();
    const supportTicketsPerDay = (body?.supportTicketsPerDay || '').toString().slice(0, 120).trim();
    const bitrix24 = (body?.bitrix24 || '').toString().slice(0, 200).trim();
    const productManagement = (body?.productManagement || '').toString().slice(0, 200).trim();
    // Метка канала-источника (hh.kz-негоциация / Telegram-чат и т.д.) — см. findAndUpdateCandidate выше.
    const refId = (body?.refId || '').toString().slice(0, 100).trim();
    const needAiComfort = isSuccess;
    const needSupportExtra = isSupport;
    if (!name || !contact || !city || !source || !expSales || !techReady || !noCombine || !startWhen || (needAiComfort && !aiComfort) || (isSuccess && !kazakh) || (needSupportExtra && (!cashIntegration || !bitrix24 || !productManagement))) {
      res.status(400).json({ error: 'Заполните, пожалуйста, все обязательные поля анкеты.' }); return;
    }

    const expQLabel = isSuccess ? 'Опыт работы с текущими клиентами / удержанием'
      : isSupport ? 'Опыт в техподдержке / клиентском сервисе'
      : 'Опыт в продажах / холодных звонках';
    const techReadyQLabel = isSupport ? 'Есть ли ноутбук' : 'Компьютер и стабильный интернет';
    const answers = [
      { q: 'Город', a: city },
      { q: 'Откуда узнали о вакансии', a: source },
      { q: expQLabel, a: expSales },
    ];
    if (isSupport && supportTicketsPerDay) answers.push({ q: 'Сколько заявок в день обрабатывали', a: supportTicketsPerDay });
    if (isSupport) {
      answers.push({ q: 'Опыт интеграции с кассовыми системами', a: cashIntegration + (cashIntegrationDetail ? ` (${cashIntegrationDetail})` : '') });
      answers.push({ q: 'Уровень владения CRM Битрикс24', a: bitrix24 });
    }
    answers.push({ q: techReadyQLabel, a: techReady });
    answers.push({ q: 'Чем занят помимо работы и готов(а) ли поставить работу в приоритет', a: noCombine });
    if (isSupport) answers.push({ q: 'Опыт в Product Management', a: productManagement });
    answers.push({ q: 'Когда готов(а) приступить', a: startWhen });
    if (isSuccess) answers.push({ q: 'Уровень казахского языка', a: kazakh });
    if (needAiComfort) answers.push({ q: 'Комфорт с ИИ-инструментами (ChatGPT/Claude) в работе', a: aiComfort });
    if (comment) answers.push({ q: 'Комментарий кандидата', a: comment });

    // matchPercent используется только для success_remote (гейт от Асемгуль, см. buildSuccessScreenPrompt);
    // для остальных вакансий остаётся null и не влияет на приглашение (invited=true всегда, см. ниже).
    let evaln = { score: null, verdict: 'Резерв', summary: '', strengths: [], flags: [], matchPercent: null };
    try {
      const userContent = isSuccess
        ? `Вакансия: ${vacTitle}\nКандидат: ${name}\nГород: ${city}\nИсточник: ${source}\n\nОтветы анкеты:\n1) Опыт работы с текущими клиентами/удержанием: ${expSales}\n2) Компьютер и стабильный интернет: ${techReady}\n3) Чем занят помимо работы и готовность поставить работу в приоритет: ${noCombine}\n4) Уровень казахского языка: ${kazakh}\n5) Комфорт с ИИ-инструментами: ${aiComfort}\n6) Когда готов(а) приступить: ${startWhen}\n7) Комментарий кандидата: ${comment || '—'}`
        : isSupport
        ? `Вакансия: ${vacTitle}\nКандидат: ${name}\nГород: ${city}\nИсточник: ${source}\n\nОтветы анкеты:\n1) Опыт интеграции с кассовыми системами: ${cashIntegration}${cashIntegrationDetail ? ` (${cashIntegrationDetail})` : ''}\n2) Опыт в техподдержке/клиентском сервисе: ${expSales}${supportTicketsPerDay ? `; заявок в день: ${supportTicketsPerDay}` : ''}\n3) Уровень владения CRM Битрикс24: ${bitrix24}\n4) Чем занят помимо работы и готовность поставить работу в приоритет: ${noCombine}\n5) Есть ли ноутбук: ${techReady}\n6) Опыт в Product Management: ${productManagement}\n7) Когда готов(а) приступить: ${startWhen}\n8) Комментарий кандидата: ${comment || '—'}`
        : `Вакансия: ${vacTitle}\nКандидат: ${name}\nГород: ${city}\nИсточник: ${source}\n\nОтветы анкеты:\n1) Опыт в продажах/холодных звонках: ${expSales}\n2) Компьютер и стабильный интернет: ${techReady}\n3) Чем занят помимо работы и готовность поставить обучение в приоритет: ${noCombine}\n4) Когда готов(а) приступить: ${startWhen}\n5) Комментарий кандидата: ${comment || '—'}`;
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 800,
          system: isSuccess ? buildSuccessScreenPrompt() : isSupport ? buildSupportScreenPrompt() : buildScreenPrompt(isRemote),
          messages: [{ role: 'user', content: userContent }],
        }),
      });
      const ad = await ar.json();
      if (ar.ok) {
        const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const o = JSON.parse(m[0]);
            evaln = {
              score: o.score ?? null, verdict: o.verdict || 'Резерв', summary: o.summary || '',
              strengths: o.strengths || [], flags: o.flags || [],
              matchPercent: (typeof o.matchPercent === 'number') ? o.matchPercent : null,
            };
          } catch (e) {}
        }
      }
    } catch (e) {}

    // По прямому указанию Sagi (2026-08-17, «так и всем», уточнено ещё раз позже в тот же день) —
    // та же философия, что и на hh.kz: не держим кандидата в подвешенном «рассмотрим и свяжемся»,
    // а сразу зовём на ОБУЧЕНИЕ (не стажировку — уточнение Sagi 2026-08-18: стажировка начинается
    // позже, когда подключается наставник, после прохождения всех 10 модулей). Отсутствие опыта
    // холодных звонков, компьютера или интернета — НЕ причина для отказа (см. buildScreenPrompt
    // выше), этому всему учат на обучении. «Отказ» от ИИ-скринера ставится только за реальные
    // красные флаги из структурированной анкеты (см. buildScreenPrompt). Это ТОЛЬКО для продаж —
    // для success_remote действует отдельная политика (см. блок ниже).
    //
    // 2026-08-23, ПРАВКА ПОЛИТИКИ от Асемгуль (COO) для success_remote, передано через Sagi: «оценить
    // клиента через бот по требованиям, тем кто соответствует по требованиям на 90% звать на
    // собеседование». В отличие от продаж, здесь ИИ-оценка (matchPercent) РЕАЛЬНО решает, не просто
    // справка. Если API-вызов не удался (matchPercent неизвестен) — НЕ отказываем автоматически (это
    // было бы нечестно к кандидату из-за технического сбоя), ставим на «Квалификация» для ручной
    // проверки Sagi/Асемгуль.
    const SUCCESS_MATCH_THRESHOLD = 90;
    const successMatchKnown = isSuccess && typeof evaln.matchPercent === 'number';
    const invited = isSuccess ? (successMatchKnown && evaln.matchPercent >= SUCCESS_MATCH_THRESHOLD) : true;
    const rec = {
      id: refId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      name, contact, phone: '', vacancy: vacTitle,
      source: (source ? source + ' · ' : 'форма отклика · ') + vacTitle, howFound: source || null,
      // 2026-08-19: возраст теперь вводит сам кандидат (поле формы), а не угадывает ИИ из резюме —
      // резюме больше не запрашиваем. Пометка вне 20-35 лет — НЕ авто-отказ, юридически рискован
      // жёсткий авто-отказ по возрасту (ст. 6 ТК РК про дискриминацию при приёме на работу).
      age, ageChecked: true, ageOutOfRange: age != null && (age < 20 || age > 35),
      city,
      answers,
      score: evaln.score, verdict: evaln.verdict, summary: evaln.summary,
      strengths: evaln.strengths, flags: evaln.flags, matchPercent: evaln.matchPercent,
      stage: !isSuccess
        ? (invited ? 'Приглашён' : 'Отказ')
        : (successMatchKnown ? (invited ? 'Интервью' : 'Отказ') : 'Квалификация'),
      ts: Date.now(),
      // Реферальная программа: поля ниже заполняются, только если кандидат указал, кто его
      // порекомендовал. Статус пересчитывается автоматически в api/pipeline.js по мере того, как
      // кандидат продвигается (трудоустройство, 2 месяца стажа) или Sagi вручную отмечает продажу
      // в первый месяц — см. computeReferralStatus там же.
      referrerName: referrerName || '', referrerPhone: referrerPhone || '',
      referralBonusAmount: referrerPhone ? 50 : null,
      saleInFirstMonth: false,
      referralBonusStatus: referrerPhone ? 'ожидает' : null,
      referralPaidAt: null,
    };
    // Если пришли по ссылке из hh.kz/Telegram (refId = hh_<negId> / tg_<chatId>) — обновляем уже
    // существующую запись, созданную при интейке, вместо того чтобы плодить дубликат (см. комментарий
    // у findAndUpdateCandidate выше). Иначе (обычный органический трафик на apply.html) — создаём новую.
    let saved = null;
    try {
      if (refId) saved = await findAndUpdateCandidate(refId, rec);
      if (!saved) { await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]); await redis(['LTRIM', CAND_KEY, 0, 999]); saved = rec; }
    } catch (e) {}
    notifyTelegram(saved || rec); // best-effort, не блокируем ответ

    const inviteTextSales = `${name}, спасибо за отклик! По вашим ответам приглашаем вас на обучение — это первый шаг: пройдёте базовую программу, а после неё подключим наставника и перейдёте к стажировке уже на практике.\n\nЧто нужно сделать:\n1) Перейти на hr.sagibonus.com\n2) Нажать на карточку «🎓 Стажёр» и зарегистрироваться (займёт минуту)\n3) Пройти базовую программу (о продукте, скрипты, тесты), обычно занимает около часа. Есть встроенный ИИ-тренажёр, чтобы отрабатывать звонки на практике. С момента регистрации даётся 3 часа: если сейчас есть свободный час-два, начинайте сразу, если нет, можно зарегистрироваться и начать попозже, когда будет удобно, только не откладывайте надолго\n\nВажный момент заранее: первое время на стажировке — это холодные звонки, вы сами ищете и закрываете клиентов с нуля, этому и учим. Тёплые лиды от компании подключаем не сразу, а когда уверенно продаёте самостоятельно (закрываете сделки по холодным и уверенно проводите демо по видео), обычно это второй месяц. Стажировка требует реальной вовлечённости, это будет видно сразу.\n\nПодробные условия по доходу: hr.sagibonus.com/usloviya.html\n\nКстати: когда начнёте работать, приводите друзей — за каждого, кто проработает от 2 месяцев (или сделает продажу уже в первый месяц), $50 вам.\n\nЕсли появятся вопросы, пишите в WhatsApp: +7 707 700 0087.`;
    // 2026-08-23, по итоговому процессу от Асемгуль (COO), передано через Sagi: ИИ-бот оценивает
    // анкету по требованиям, кандидатов с matchPercent ≥90% приглашаем на собеседование (не сразу на
    // обучение, как в продажах — тут структура другая: интервью → при успехе недельная стажировка,
    // уточнение Sagi 2026-08-23 «стажировка неделя»).
    const inviteTextSuccess = `${name}, спасибо за отклик на позицию «${vacTitle}»! По вашим ответам приглашаем вас на собеседование.\n\nВ ближайшее время с вами свяжутся в WhatsApp по указанному контакту, чтобы согласовать удобное время созвона. После собеседования, при успешном прохождении — недельная стажировка на практике.\n\nЕсли появятся вопросы, пишите в WhatsApp: +7 707 700 0087.`;
    // Нейтральный текст — используется, только если ИИ-оценка технически не удалась (matchPercent
    // неизвестен), чтобы не сообщать кандидату ложный отказ из-за сбоя. Такие заявки уходят в
    // pipeline.html со статусом «Квалификация» на ручную проверку.
    const holdTextSuccess = `${name}, спасибо за отклик на позицию «${vacTitle}»! Заявку получили, ответы рассматриваем — в ближайшее время с вами свяжутся по указанному контакту.\n\nЕсли появятся вопросы, пишите в WhatsApp: +7 707 700 0087.`;
    // 2026-08-23, по указанию Sagi («какие вопросы надо задавать, как у продаж чтобы было? Таким
    // образом тоже надо сделать») — структура сообщения как у продаж (конкретные шаги, а не
    // расплывчатое «свяжемся»), но контент честный: формального трека обучения с модулями на
    // hr.sagibonus.com для техподдержки НЕТ (это специфика продаж), поэтому шаг про наставника/
    // разбор обращений — черновик по аналогии с тем, как устроена стажировка у остальных ролей,
    // а не подтверждённый Sagi процесс. Явно флагнуто ему на проверку.
    const inviteTextSupport = `${name}, спасибо за отклик на позицию «${vacTitle}»! По вашим ответам приглашаем вас начать.\n\nЧто дальше:\n1) В ближайшее время с вами свяжутся в WhatsApp, чтобы обсудить старт.\n2) Расскажем, как устроена поддержка: куда обращаются клиенты, где искать ответы на типовые вопросы, как проводить интеграцию.\n3) Первое время разбираете обращения вместе с наставником, дальше — самостоятельно.\n\nОплата: первый месяц 150 000 ₸ + KPI, со второго месяца — 200 000 ₸ + KPI.\n\nЕсли появятся вопросы, пишите в WhatsApp: +7 707 700 0087.`;
    const declineText = `${name}, спасибо за отклик! Сейчас, судя по ответам, эта позиция не очень совпадает с тем, что нужно для этой роли. Если что-то изменится или откроется другая подходящая позиция, обязательно свяжемся. Удачи!`;

    const message = isSuccess
      ? (!successMatchKnown ? holdTextSuccess : (invited ? inviteTextSuccess : declineText))
      : isSupport
      ? (invited ? inviteTextSupport : declineText)
      : (invited ? inviteTextSales : declineText);

    res.status(200).json({ ok: true, score: evaln.score, verdict: evaln.verdict, summary: evaln.summary, matchPercent: evaln.matchPercent, invited, message });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
