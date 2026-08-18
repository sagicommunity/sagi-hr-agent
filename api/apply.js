// Vercel Serverless Function — приём отклика кандидата + авто-скрининг (Claude) + сохранение в Redis.
// POST { name, contact, source?, resume }  → { ok, score, verdict, summary }

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

// 2026-08-17, по прямому указанию Sagi: отсутствие опыта холодных звонков и отсутствие
// компьютера/интернета — НЕ повод для отказа. Всему учат на стажировке: сначала звонки и обход
// администратора/кассира, выход на ЛПР, назначение встреч — первые 1-2 недели саму встречу
// проводит наставник, и только потом стажёр начинает вести встречи сам. Компьютер нужен
// примерно к этому моменту (через 1-2 недели), не с первого дня. Поэтому «Отказ» — теперь
// только для явных не-по-теме случаев (грубость, спам, прямой отказ работать в принципе),
// а не для отсутствия опыта/техники.
const SCREEN_SYS = `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ, sagi.kz). Оцениваешь кандидата на позицию менеджера по продажам (хантер): звонки, обход администратора/кассира, поиск ЛПР, выявление боли, работа с возражениями, закрытие на демо/встречу. Работа: офис в Астане.

ВАЖНО: это стартовая позиция, всему учат на стажировке. Отсутствие опыта холодных звонков или продаж — НЕ повод для отказа, это нормально для новичка. Оцени только реальные красные флаги: явную грубость/неадекватность, прямой отказ учиться или работать, отсутствие мотивации в принципе. Такие случаи — «Отказ». Во всех остальных случаях, включая отсутствие опыта, ставь «Брать на интервью» или «Резерв».

Верни ТОЛЬКО валидный JSON, без markdown и пояснений:
{"score": <число 0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения по сути>", "strengths": ["<сильная сторона>", ...], "flags": ["<красный флаг>", ...], "age": <возраст числом, если есть в резюме, иначе null>}`;

const SCREEN_SYS_REMOTE = `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ, sagi.kz). Оцениваешь кандидата на позицию менеджера по продажам, работающего ПОЛНОСТЬЮ УДАЛЁННО (хантер): звонки, обход администратора/кассира, поиск ЛПР, работа с возражениями, закрытие сделки через ОНЛАЙН-демонстрацию (Zoom/видеозвонок), без личных встреч и без офиса.

ВАЖНО: это стартовая позиция, всему учат на стажировке. Отсутствие опыта холодных звонков, отсутствие компьютера или нестабильный интернет на СТАРТЕ — НЕ повод для отказа: первые 1-2 недели стажёр только звонит и назначает встречи, а саму встречу (демо по Zoom) проводит наставник. Компьютер и стабильный интернет понадобятся ближе к тому моменту, когда стажёр сам начнёт вести встречи, а не с первого дня. Оцени только реальные красные флаги: явную грубость/неадекватность, прямой отказ учиться или работать, отсутствие мотивации в принципе. Такие случаи — «Отказ». Во всех остальных случаях, включая отсутствие опыта или техники на старте, ставь «Брать на интервью» или «Резерв».

Верни ТОЛЬКО валидный JSON, без markdown и пояснений:
{"score": <число 0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения по сути>", "strengths": ["<сильная сторона>", ...], "flags": ["<красный флаг>", ...], "age": <возраст числом, если есть в резюме, иначе null>}`;

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
    const source = (body?.source || '').toString().slice(0, 80).trim();
    const resume = (body?.resume || '').toString().slice(0, 8000).trim();
    const vacancy = (body?.vacancy === 'sales_remote') ? 'sales_remote' : 'sales';
    const vacTitle = VAC_TITLES[vacancy];
    if (!name || !contact || !resume) { res.status(400).json({ error: 'Заполните имя, контакт и резюме.' }); return; }

    let evaln = { score: null, verdict: 'Резерв', summary: '', strengths: [], flags: [], age: null };
    try {
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 800, system: vacancy === 'sales_remote' ? SCREEN_SYS_REMOTE : SCREEN_SYS,
          messages: [{ role: 'user', content: `Вакансия: ${vacTitle}\nКандидат: ${name}\nИсточник: ${source || '—'}\n\nРезюме/анкета:\n${resume}` }],
        }),
      });
      const ad = await ar.json();
      if (ar.ok) {
        const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { try { const o = JSON.parse(m[0]); evaln = { score: o.score ?? null, verdict: o.verdict || 'Резерв', summary: o.summary || '', strengths: o.strengths || [], flags: o.flags || [], age: (typeof o.age === 'number' && o.age >= 14 && o.age <= 70) ? o.age : null }; } catch (e) {} }
      }
    } catch (e) {}

    // По прямому указанию Sagi (2026-08-17, «так и всем», уточнено ещё раз позже в тот же день) —
    // та же философия, что и на hh.kz: не держим кандидата в подвешенном «рассмотрим и свяжемся»,
    // а сразу зовём на ОБУЧЕНИЕ (не стажировку — уточнение Sagi 2026-08-18: стажировка начинается
    // позже, когда подключается наставник, после прохождения всех 10 модулей). Отсутствие опыта
    // холодных звонков, компьютера или интернета — НЕ причина для отказа (см. SCREEN_SYS/
    // SCREEN_SYS_REMOTE выше), этому всему учат на обучении, компьютер понадобится не с первого
    // дня. «Отказ» от ИИ-скринера теперь ставится только за реальные красные флаги (грубость,
    // явный отказ работать/учиться в принципе).
    const invited = evaln.verdict !== 'Отказ';
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name, contact, phone: '', vacancy: vacTitle,
      source: (source ? source + ' · ' : 'форма отклика · ') + vacTitle, howFound: source || null, age: evaln.age,
      // 2026-08-18, по запросу Sagi: помечаем кандидатов вне 20-35 лет, но НЕ авто-отклоняем —
      // жёсткий авто-отказ по возрасту юридически рискован (ст. 6 ТК РК про дискриминацию при
      // приёме на работу). Только пометка, финальное решение всегда за Sagi.
      ageChecked: true, ageOutOfRange: evaln.age != null && (evaln.age < 20 || evaln.age > 35),
      resume: resume.slice(0, 2000),
      answers: [{ q: 'Резюме / о себе', a: resume.slice(0, 4000) }],
      score: evaln.score, verdict: evaln.verdict, summary: evaln.summary,
      strengths: evaln.strengths, flags: evaln.flags,
      stage: invited ? 'Приглашён' : 'Отказ', ts: Date.now(),
    };
    try { await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]); await redis(['LTRIM', CAND_KEY, 0, 999]); } catch (e) {}
    notifyTelegram(rec); // best-effort, не блокируем ответ

    const inviteText = `${name}, спасибо за отклик! По вашим ответам приглашаем вас на обучение — это первый шаг: пройдёте базовую программу, а после неё подключим наставника и перейдёте к стажировке уже на практике.\n\nЧто нужно сделать:\n1) Перейти на hr.sagibonus.com\n2) Нажать на карточку «🎓 Стажёр» и зарегистрироваться (займёт минуту)\n3) Пройти базовую программу (о продукте, скрипты, тесты). Есть встроенный ИИ-тренажёр, чтобы отрабатывать звонки на практике\n\nПодробные условия по доходу: hr.sagibonus.com/usloviya.html\n\nЕсли появятся вопросы, пишите в WhatsApp: +7 707 700 0087.`;
    const declineText = `${name}, спасибо за отклик! Сейчас, судя по ответам, эта позиция не очень совпадает с тем, что нужно для этой роли. Если что-то изменится или откроется другая подходящая позиция, обязательно свяжемся. Удачи!`;

    res.status(200).json({ ok: true, score: evaln.score, verdict: evaln.verdict, summary: evaln.summary, invited, message: invited ? inviteText : declineText });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
