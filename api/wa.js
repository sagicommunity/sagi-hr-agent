// Vercel Serverless Function — WhatsApp-бот найма кандидатов (Sagi Careers), Meta Cloud API.
// Вебхук: GET — верификация Meta; POST — входящие сообщения → диалог → скрининг → Пайплайн (Redis hr:candidates) → сигнал РОПу.
// Env: WHATSAPP_TOKEN (постоянный токен доступа Meta), WHATSAPP_PHONE_ID (Phone Number ID),
//      WHATSAPP_VERIFY_TOKEN (любая строка-«пароль» для верификации вебхука — та же, что вводите в Meta),
//      ANTHROPIC_API_KEY, KV_*, TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID (уведомления РОПу).

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CAND_KEY = 'hr:candidates';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || '';
const SITE = 'https://hr.sagibonus.com';

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) return null;
  return (await r.json()).result;
}
async function getState(wa) { try { const s = await redis(['GET', 'hr:wa:' + wa]); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
async function setState(wa, st) { try { await redis(['SET', 'hr:wa:' + wa, JSON.stringify(st), 'EX', 172800]); } catch (e) {} }

async function waSend(to, text) {
  if (!WA_TOKEN || !WA_PHONE_ID) return;
  try {
    await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + WA_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }),
    });
  } catch (e) {}
}

function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }
function parseAge(s) { const m = String(s || '').match(/\b(1[4-9]|[2-6]\d|70)\b/); return m ? parseInt(m[1], 10) : null; }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ---- Пульс-проверки после трудоустройства (retention) ----
// Вопрос отправляет ФАЗА G в api/hh_poll.js (на 14/30/90 день после employedAt), ставит ключ
// hr:pulse_wait:<телефон> на 7 дней. Здесь только ловим ответ, пока ждём именно его.
function looksAtRisk(text) {
  return /(увольня|уволю|уйти с работ|ухожу с работ|не нравится работа|не нравиться работа|устал[а]?\s+от|тяжело работать|не тян|не справляюсь|хочу уволиться|ищу друг(ую|ое)\s+работ|подыскиваю\s+друг|не устраивает работа|разочаров|выгора|плохой наставник|нет поддержки|хочу уйти|думаю уйти|скоро уйду|наверное уйду)/i.test(text || '');
}
async function appendPulseReply(id, entry) {
  const raw = await redis(['LRANGE', CAND_KEY, 0, -1]);
  if (!Array.isArray(raw)) return false;
  for (let i = 0; i < raw.length; i++) {
    let rec; try { rec = JSON.parse(raw[i]); } catch (e) { continue; }
    if (rec && rec.id === id) {
      const pulseReplies = Array.isArray(rec.pulseReplies) ? rec.pulseReplies : [];
      pulseReplies.push(entry);
      const updated = { ...rec, pulseReplies };
      await redis(['LSET', CAND_KEY, i, JSON.stringify(updated)]);
      return updated;
    }
  }
  return false;
}
async function notifyAtRisk(rec, day, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '', chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  const msg = `⚠️ Возможный риск ухода сотрудника — Sagi\n\n👤 ${rec?.name || '—'}\n📅 День ${day} после трудоустройства\n\n🗣 Ответ на пульс-проверку:\n${(text || '').slice(0, 800)}\n\nСтоит связаться лично, пока не поздно.\n\nПайплайн: ${SITE}/pipeline.html`;
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true }) }); } catch (e) {}
}
function waMessage(name) { const n = (name || '').trim().split(/\s+/)[0] || ''; return `Здравствуйте${n ? ', ' + n : ''}! 👋 Меня зовут [ваше имя], я из Sagi. Мы расширяем отдел продаж и заинтересовались вашим опытом. Удобно ответить на пару вопросов?`; }

const SCREEN_SYS = `Ты — HR-скринер Sagi (loyalty-платформа для B2B МСБ). Оцениваешь кандидата на менеджера по ХОЛОДНЫМ продажам (аутрич, звонки, поиск ЛПР, работа с возражениями, закрытие на встречу). Работа: офис в Астане.
КЛЮЧЕВОЙ ФИЛЬТР: кандидат ОБЯЗАН быть готов САМОСТОЯТЕЛЬНО искать ЛПР и делать ХОЛОДНЫЕ звонки/обзвоны. Если из ответов видно, что он НЕ хочет/не готов к холодным звонкам и самостоятельному поиску клиентов (ждёт только тёплые/входящие лиды, «не люблю звонить», только переписка/соцсети) — ставь «Отказ» и низкий балл, и прямо укажи это в summary.
Верни ТОЛЬКО валидный JSON без markdown:
{"score": <0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения>"}`;

async function screen(name, fullText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let out = { score: null, verdict: 'Резерв', summary: '' };
  if (!apiKey || !fullText) return out;
  try {
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: SCREEN_SYS, messages: [{ role: 'user', content: `Кандидат: ${name}\n\nАнкета и ответы:\n${fullText.slice(0, 7000)}` }] }),
    });
    const ad = await ar.json();
    if (ar.ok) { const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'); const m = txt.match(/\{[\s\S]*\}/); if (m) { const o = JSON.parse(m[0]); out = { score: o.score ?? null, verdict: o.verdict || 'Резерв', summary: o.summary || '' }; } }
  } catch (e) {}
  return out;
}

// Алерт по КАЖДОЙ заявке (2026-08-17: та же единая политика, что в hh_poll.js/tg.js/apply.js —
// раньше алертило только по «сильным», заявки без уведомления молча лежали в пайплайне).
async function notifyROP(rec) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '', chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  const strong = rec.verdict === 'Брать на интервью' || (typeof rec.score === 'number' && rec.score >= 7);
  const text = `${strong ? '🔥 Сильный кандидат' : '💬 Новая заявка'} (WhatsApp-бот) — Sagi\n\n👤 ${rec.name}\n⭐ ${rec.score != null ? rec.score + '/10' : '—'} · ${rec.verdict}\n📞 ${rec.contact}\n\n${rec.summary || ''}\n\nПайплайн: ${SITE}/pipeline.html`;
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }); } catch (e) {}
}

const Q = {
  name: 'Здравствуйте! 👋\n\nСразу честно: я — ИИ-бот 🤖, виртуальный помощник команды найма Sagi (я не живой человек). Моя задача — познакомиться с вами, задать несколько коротких вопросов и передать вашу заявку HR-менеджеру, чтобы он быстрее её рассмотрел. Это займёт ~2–3 минуты.\n\nВакансия: *менеджер по продажам* (холодные продажи — звонки, поиск клиентов, встречи). Офис в Астане 🏢.\n\nЧто важно знать:\n• Ваши ответы и контакты увидит только наша команда найма — для подбора.\n• Если подойдёте — с вами свяжется живой человек.\n• Отвечайте свободно, своими словами. Если что-то непонятно — просто напишите вопрос, я поясню. 🙂\n\nДавайте начнём — как вас зовут? (имя и фамилия)',
  age: 'Приятно познакомиться! Сколько вам полных лет? (напишите числом, например: 27)',
  source: 'Спасибо! Откуда вы узнали о вакансии? (Instagram, HH, по рекомендации и т.п.)',
  resume: 'Отлично. Пришлите ваше резюме — *текстом* или *ссылкой* (hh.kz, LinkedIn). Можно кратко: опыт, достижения, чем занимались.',
  q1: 'Спасибо! Теперь пара вопросов по делу.\n\n1️⃣ Работа — это самостоятельный поиск клиентов и холодные звонки/обзвоны (искать ЛПР, звонить «вхолодную»). Готовы так работать? И есть ли у вас такой опыт?',
  q2: '2️⃣ Какой ваш лучший результат в продажах? (план/цифры/достижения)',
  q3: '3️⃣ Вы в Астане и готовы работать в офисе? И когда можете приступить?',
};

function answerFaq(text) {
  const t = (text || '').toLowerCase();
  if (/(\bбот\b|робот|живой человек|ты человек|вы человек|ты кто|вы кто|это ии|\bии\b|нейросет|искусствен)/.test(t)) return 'Да, я ИИ-бот 🤖 — помогаю команде найма Sagi собрать и оценить заявки. Дальше с вами обязательно свяжется живой человек.';
  if (/(компани|sagi|саги|чем занима|что за фирм|какой продукт|что прода|что за работ|что делать буду|обязанност)/.test(t)) return 'Sagi — платформа лояльности и бонусов для бизнеса (sagi.kz). Менеджер по продажам предлагает её владельцам бизнеса (кафе, магазины, услуги): звонки, поиск клиентов, встречи и закрытие сделок.';
  if (/(зарплат|оклад|сколько плат|доход|ставк|процент|з\/п|\bзп\b|оплат|деньг|kpi|бонус|заработ)/.test(t)) return 'По деньгам: оклад 100 000 ₸ + до 120 000 ₸ за выполнение KPI + проценты с продаж. Подробнее расскажем на собеседовании. У нас были менеджеры, которые зарабатывали до 1 500 000 ₸. 💪';
  if (/(удал[её]н|офис|график|формат|режим|из дома|онлайн|город|где наход|локац|астан|где работа)/.test(t)) return 'Офис в Астане 🏢 — нам нужен сотрудник в офис. Удалённый формат возможен, но тогда без фиксированного оклада — только проценты с продаж.';
  if (/(опыт|без опыта|нужен ли опыт|стаж|новичок|студент)/.test(t)) return 'Опыт в продажах приветствуется, но главное — желание и обучаемость. Расскажите о себе — мы оценим.';
  if (/(сколько вопрос|долго|сколько врем|сколько займ|это надолго|быстро)/.test(t)) return 'Совсем недолго — пара минут: имя, резюме и 3 коротких вопроса.';
  return null;
}

// Приглашение на ОБУЧЕНИЕ (не на стажировку — уточнение Sagi 2026-08-18: стажировка начинается
// позже, когда подключается наставник, после прохождения всех 10 модулей) — та же философия,
// что и на hh.kz (2026-08-17, по прямому указанию Sagi «так и всем»): не держим кандидата в
// подвешенном «рассмотрим и свяжемся», сразу зовём на обучение. Исключение — только явный
// «Отказ» от ИИ-скринера (жёсткий стоп-фактор вроде «не готов к холодным звонкам»), таких не
// приглашаем, а вежливо отказываем.
function buildWaInviteText(name) {
  const n = (name || '').trim().split(/\s+/)[0] || '';
  const greet = n ? `${n}, спасибо за ответы!` : 'Спасибо за ответы!';
  return `${greet} 🙌\n\nПриглашаем вас на обучение. Это первый шаг: пройдёте базовую программу, а после неё подключим наставника и перейдёте к стажировке уже на практике.\n\nЧто нужно сделать:\n1) Перейти на hr.sagibonus.com\n2) Нажать на карточку «🎓 Стажёр» и зарегистрироваться (займёт минуту)\n3) Пройти базовую программу (о продукте, скрипты, тесты), обычно занимает около часа. Есть встроенный ИИ-тренажёр, чтобы отрабатывать звонки на практике. С момента регистрации даётся 3 часа: если сейчас есть свободный час-два, начинайте сразу, если нет, можно зарегистрироваться и начать попозже, когда будет удобно, только не откладывайте надолго\n\nВажный момент заранее: первое время на стажировке — это холодные звонки, вы сами ищете и закрываете клиентов с нуля, этому и учим. Тёплые лиды от компании подключаем не сразу, а когда уверенно продаёте самостоятельно (закрываете сделки по холодным и уверенно проводите демо по видео), обычно это второй месяц. Стажировка требует реальной вовлечённости, это будет видно сразу.\n\nПодробные условия по доходу: hr.sagibonus.com/usloviya.html\n\nЕсли появятся вопросы, можно написать сюда же или в WhatsApp: +7 707 700 0087.`;
}
function buildWaDeclineText(name) {
  const n = (name || '').trim().split(/\s+/)[0] || '';
  const greet = n ? `${n}, спасибо за ответы!` : 'Спасибо за ответы!';
  return `${greet} Сейчас, судя по ответам, эта позиция не очень совпадает с тем, что нужно для этой роли. Если что-то изменится или откроется другая подходящая позиция, обязательно свяжемся. Удачи! 🙌`;
}
async function finalize(wa, st) {
  const d = st.data || {};
  const age = parseAge(d.age);
  const fullText = `Возраст: ${age != null ? age : (d.age || '—')}\n\nРезюме/о себе: ${d.resume || '—'}\n\nОпыт холодных продаж: ${d.q1 || '—'}\nЛучший результат: ${d.q2 || '—'}\nГотовность/формат: ${d.q3 || '—'}`;
  // Структурированные ответы кандидата боту — для просмотра в пайплайне по клику
  const answers = [
    { q: 'Имя', a: d.name || '' },
    { q: 'Возраст', a: age != null ? String(age) : (d.age || '') },
    { q: 'Откуда узнали о вакансии', a: d.source || '' },
    { q: 'Резюме / о себе', a: d.resume || '' },
    { q: 'Готовность к холодным звонкам и опыт', a: d.q1 || '' },
    { q: 'Лучший результат в продажах', a: d.q2 || '' },
    { q: 'Астана / офис / когда может приступить', a: d.q3 || '' },
  ].filter(x => x.a);
  const ev = await screen(d.name || '', fullText);
  const invited = true; // 2026-08-22, по указанию Sagi (та же политика, что и в api/apply.js): не отказываем никому на этапе анкеты — все идут сразу на обучение (ИИ-оценка — только справка в Telegram)
  await waSend(wa, invited ? buildWaInviteText(d.name) : buildWaDeclineText(d.name));
  const phone = digits(st.phone || '');
  const rec = {
    id: newId(), name: d.name || 'Из WhatsApp', contact: phone ? '+' + phone : '', phone, age,
    // 2026-08-18, по запросу Sagi: помечаем кандидатов вне 20-35, но НЕ авто-отклоняем (ст. 6 ТК
    // РК про дискриминацию по возрасту при приёме) — только пометка, решение всегда за Sagi.
    ageChecked: true, ageOutOfRange: age != null && (age < 20 || age > 35),
    source: 'WhatsApp-бот' + (d.source ? ' (' + d.source + ')' : ''), howFound: d.source || null,
    resume: fullText.slice(0, 2000), answers, score: ev.score, verdict: ev.verdict, summary: ev.summary,
    strengths: [], flags: [], stage: invited ? 'Приглашён' : 'Отказ', waMessage: waMessage(d.name), ts: Date.now(),
  };
  try { await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]); await redis(['LTRIM', CAND_KEY, 0, 1999]); } catch (e) {}
  await notifyROP(rec);
}

export default async function handler(req, res) {
  // ---- верификация вебхука Meta ----
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && WA_VERIFY && token === WA_VERIFY) {
      res.status(200).send(challenge);
      return;
    }
    res.status(200).send('Sagi WhatsApp bot is running');
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    // статусы доставки и прочие события — игнорируем
    if (!msg || msg.type !== 'text' || !msg.from) { res.status(200).json({ ok: true }); return; }

    const wa = msg.from; // номер кандидата в WhatsApp (служит телефоном)
    const profileName = value?.contacts?.[0]?.profile?.name || '';
    let text = (msg.text?.body || '').trim();

    // Если ждём ответ именно на пульс-проверку (retention) — обрабатываем его отдельно и не
    // пускаем в обычный флоу анкеты кандидата.
    try {
      const pulseRaw = await redis(['GET', 'hr:pulse_wait:' + wa]);
      if (pulseRaw && text) {
        let pulse; try { pulse = JSON.parse(pulseRaw); } catch (e) { pulse = null; }
        if (pulse && pulse.candId) {
          await redis(['DEL', 'hr:pulse_wait:' + wa]);
          const atRisk = looksAtRisk(text);
          const rec = await appendPulseReply(pulse.candId, { day: pulse.day, text: text.slice(0, 1000), ts: Date.now(), atRisk });
          if (atRisk) await notifyAtRisk(rec || { name: pulse.name }, pulse.day, text);
          await waSend(wa, atRisk
            ? 'Спасибо, что честно ответили 🙏 Передал(а) это HR-менеджеру, с вами свяжутся, чтобы разобраться и помочь.'
            : 'Спасибо за ответ! Рады, что всё хорошо 🙌 Если что-то понадобится, пишите в любой момент.');
          res.status(200).json({ ok: true }); return;
        }
      }
    } catch (e) {}

    if (text === '/start' || /^(начать|заново|restart)$/i.test(text)) {
      await setState(wa, { step: 'name', data: {}, phone: wa });
      await waSend(wa, Q.name);
      res.status(200).json({ ok: true }); return;
    }

    let st = await getState(wa);
    if (!st) { await setState(wa, { step: 'name', data: {}, phone: wa }); await waSend(wa, Q.name); res.status(200).json({ ok: true }); return; }
    if (!text) { res.status(200).json({ ok: true }); return; }
    st.data = st.data || {};
    st.phone = st.phone || wa;

    const order = ['name', 'age', 'source', 'resume', 'q1', 'q2', 'q3'];
    const i = order.indexOf(st.step);

    if (st.step === 'done') {
      const f = answerFaq(text);
      await waSend(wa, (f ? f + '\n\n' : '') + 'Ваша заявка уже принята ✅ Если хотите заполнить заново — напишите «начать».');
      res.status(200).json({ ok: true }); return;
    }

    // Если кандидат задал вопрос — поясняем и повторяем текущий вопрос (не продвигаемся)
    const faq = answerFaq(text);
    const looksQuestion = faq !== null ||
      (/\?/.test(text) && text.length < 80 && /^(а |это |вы |ты |что|как|какой|какая|какие|кто|где|когда|сколько|почему|зачем|можно|есть ли|правда)/i.test(text.trim()));
    if (looksQuestion) {
      const ans = faq || 'Хороший вопрос! Точные детали уточнит рекрутер, когда свяжется. А пока продолжим 🙂';
      await waSend(wa, ans + '\n\n' + Q[st.step]);
      res.status(200).json({ ok: true }); return;
    }

    // сохраняем ответ на текущий шаг
    st.data[st.step] = text.slice(0, 4000);

    if (st.step === 'q3') {
      st.step = 'done'; await setState(wa, st);
      await finalize(wa, st);
      res.status(200).json({ ok: true }); return;
    }
    const next = order[i + 1];
    st.step = next; await setState(wa, st);
    await waSend(wa, Q[next]);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true }); // Meta ожидает 200
  }
}
