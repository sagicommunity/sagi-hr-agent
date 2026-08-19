// Vercel Serverless Function — приём отклика кандидата + авто-скрининг (Claude) + сохранение в Redis.
// 2026-08-19, по указанию Sagi: резюме больше не запрашиваем вообще («зачем нам резюме, если можем
// выявить нужные моменты через вопросы») — вместо одного поля «резюме/о себе» форма (apply.html)
// теперь задаёт короткую структурированную анкету (те же вопросы, что раньше шли в переписке
// hh.kz/Telegram) с готовыми вариантами ответа (chips) там, где это уместно, плюс возраст и город.
// POST { name, contact, age?, city, source, expSales, techReady, noCombine, startWhen, comment?, vacancy, refId? }
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
- планирует совмещать с другой работой/учёбой — при такой нагрузке роль не выполнить;
- явная грубость, неадекватность или полное отсутствие мотивации в комментарии.

Во всех остальных случаях ставь «Брать на интервью» или «Резерв» (используй «Резерв» при неоднозначных сигналах, не спеши сразу на «Отказ»).

Верни ТОЛЬКО валидный JSON, без markdown и пояснений:
{"score": <число 0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения по сути>", "strengths": ["<сильная сторона>", ...], "flags": ["<красный флаг>", ...]}`;
}

const VAC_TITLES = { sales: 'Менеджер по продажам', sales_remote: 'Менеджер по продажам, удалённо' };

// Уведомление в Telegram по КАЖДОЙ заявке через форму (2026-08-17: единая политика с hh.kz и
// Telegram-ботом — раньше алертило только по «сильным», из-за чего заявки молча терялись и
// оставались без реакции — кандидаты потом сами писали, дошло ли). Финальное решение всё равно
// за Sagi, но теперь он хотя бы видит каждую заявку.
async function notifyTelegram(rec) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  const strong = rec.verdict === 'Брать на интервью' || (typeof rec.score === 'number' && rec.score >= 7);
  const text =
    `${strong ? '🔥 Сильный кандидат' : '💬 Новая заявка'} (форма отклика) — Sagi\n\n` +
    `🎯 Вакансия: ${rec.vacancy}\n` +
    `👤 ${rec.name}\n` +
    `⭐ ${rec.score != null ? rec.score + '/10' : '—'} · ${rec.verdict}\n` +
    `📞 ${rec.contact}\n` +
    `📍 Источник: ${rec.source}\n\n` +
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
    const vacancy = (body?.vacancy === 'sales_remote') ? 'sales_remote' : 'sales';
    const isRemote = vacancy === 'sales_remote';
    const vacTitle = VAC_TITLES[vacancy];
    // Метка канала-источника (hh.kz-негоциация / Telegram-чат и т.д.) — см. findAndUpdateCandidate выше.
    const refId = (body?.refId || '').toString().slice(0, 100).trim();
    if (!name || !contact || !city || !source || !expSales || !techReady || !noCombine || !startWhen) {
      res.status(400).json({ error: 'Заполните, пожалуйста, все обязательные поля анкеты.' }); return;
    }

    const answers = [
      { q: 'Город', a: city },
      { q: 'Откуда узнали о вакансии', a: source },
      { q: 'Опыт в продажах / холодных звонках', a: expSales },
      { q: 'Компьютер и стабильный интернет', a: techReady },
      { q: 'Совмещение с другой работой/учёбой', a: noCombine },
      { q: 'Когда готов(а) приступить', a: startWhen },
    ];
    if (comment) answers.push({ q: 'Комментарий кандидата', a: comment });

    let evaln = { score: null, verdict: 'Резерв', summary: '', strengths: [], flags: [] };
    try {
      const userContent = `Вакансия: ${vacTitle}\nКандидат: ${name}\nГород: ${city}\nИсточник: ${source}\n\nОтветы анкеты:\n1) Опыт в продажах/холодных звонках: ${expSales}\n2) Компьютер и стабильный интернет: ${techReady}\n3) Совмещение с другой работой/учёбой: ${noCombine}\n4) Когда готов(а) приступить: ${startWhen}\n5) Комментарий кандидата: ${comment || '—'}`;
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 800, system: buildScreenPrompt(isRemote),
          messages: [{ role: 'user', content: userContent }],
        }),
      });
      const ad = await ar.json();
      if (ar.ok) {
        const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { try { const o = JSON.parse(m[0]); evaln = { score: o.score ?? null, verdict: o.verdict || 'Резерв', summary: o.summary || '', strengths: o.strengths || [], flags: o.flags || [] }; } catch (e) {} }
      }
    } catch (e) {}

    // По прямому указанию Sagi (2026-08-17, «так и всем», уточнено ещё раз позже в тот же день) —
    // та же философия, что и на hh.kz: не держим кандидата в подвешенном «рассмотрим и свяжемся»,
    // а сразу зовём на ОБУЧЕНИЕ (не стажировку — уточнение Sagi 2026-08-18: стажировка начинается
    // позже, когда подключается наставник, после прохождения всех 10 модулей). Отсутствие опыта
    // холодных звонков, компьютера или интернета — НЕ причина для отказа (см. buildScreenPrompt
    // выше), этому всему учат на обучении. «Отказ» от ИИ-скринера ставится только за реальные
    // красные флаги из структурированной анкеты (см. buildScreenPrompt).
    const invited = evaln.verdict !== 'Отказ';
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
      strengths: evaln.strengths, flags: evaln.flags,
      stage: invited ? 'Приглашён' : 'Отказ', ts: Date.now(),
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

    const inviteText = `${name}, спасибо за отклик! По вашим ответам приглашаем вас на обучение — это первый шаг: пройдёте базовую программу, а после неё подключим наставника и перейдёте к стажировке уже на практике.\n\nЧто нужно сделать:\n1) Перейти на hr.sagibonus.com\n2) Нажать на карточку «🎓 Стажёр» и зарегистрироваться (займёт минуту)\n3) Пройти базовую программу (о продукте, скрипты, тесты). Есть встроенный ИИ-тренажёр, чтобы отрабатывать звонки на практике\n\nПодробные условия по доходу: hr.sagibonus.com/usloviya.html\n\nЕсли появятся вопросы, пишите в WhatsApp: +7 707 700 0087.`;
    const declineText = `${name}, спасибо за отклик! Сейчас, судя по ответам, эта позиция не очень совпадает с тем, что нужно для этой роли. Если что-то изменится или откроется другая подходящая позиция, обязательно свяжемся. Удачи!`;

    res.status(200).json({ ok: true, score: evaln.score, verdict: evaln.verdict, summary: evaln.summary, invited, message: invited ? inviteText : declineText });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
