// Vercel Serverless Function — автосбор откликов с hh.kz (негоциации по вакансиям Sagi).
//
// ФИЛОСОФИЯ (обновлено 2026-08-14 по запросу Sagi): НЕ фильтруем кандидатов по резюме —
// многие хорошие продажники резюме толком не заполняют. Задача — довести КАЖДОГО, кто
// откликнулся, до ответа на пару простых вопросов, а дальше до стажировки (там уже видно,
// подходит человек или нет). Поэтому:
//   Фаза A (интейк): всем новым откликам СРАЗУ уходит первое сообщение с вопросами.
//                     Резюме не оценивается ИИ, просто сохраняется как контекст.
//   Фаза B (ответы):  когда кандидат отвечает в переписке на hh.kz, ИИ оценивает именно
//                     ОТВЕТ (адекватность речи, мотивация) — не резюме и не опыт продаж как
//                     таковой. РОПу приходит Telegram-алерт с текстом ответа и рекомендацией ИИ
//                     по КАЖДОМУ ответившему (не только по «сильным») — финальное решение за РОПом.
//
// Триггер: GET /api/hh_poll?secret=<HH_POLL_SECRET>  (по расписанию, см. README/память проекта)
//   ?debug=1        — вернуть подробности ошибок/причин вместо счётчика
//   ?dryrun=1       — ничего не отправлять/не сохранять/не помечать, только показать, что бы произошло
//   ?limit=N        — сколько НОВЫХ откликов обработать за этот запуск (по умолчанию 5)
//   ?limitReplies=N — сколько ожидающих ответа проверить на новые сообщения за этот запуск (по умолчанию 5)
//
// Env нужны:
//   HH_CLIENT_ID, HH_CLIENT_SECRET       — уже должны быть в проекте (используются и в chat.js для поиска вакансий)
//   HH_EMPLOYER_REFRESH_TOKEN_SEED       — разовый бутстрап refresh_token с OAuth-авторизации сотрудника
//   HH_EMPLOYER_ACCESS_TOKEN_SEED        — разовый бутстрап access_token (тот же обмен кода)
//   HH_EMPLOYER_ID                       — id работодателя на hh.kz (для списка активных вакансий)
//   HH_POLL_SECRET                       — случайная строка для защиты эндпоинта
//   ANTHROPIC_API_KEY, KV_REST_API_URL/TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — уже есть

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CAND_KEY = 'hr:candidates';
const SEEN_KEY = 'hh:seen_negotiations';       // отклику отправлено первое сообщение
const REPLIED_KEY = 'hh:replied_negotiations'; // ответ кандидата уже оценён и по нему был алерт
const REPLY_CURSOR_KEY = 'hh:reply_check_cursor'; // позиция «карусели» для фазы B — чтобы каждый прогон проверял РАЗНЫХ кандидатов, а не всегда первых N
const REMINDED_KEY = 'hh:reminded_negotiations'; // кому уже отправили напоминание (шлём максимум один раз)
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000; // напомнить, если прошло больше 24 часов без ответа
const REMINDER_TEXT = 'Добрый день! Не потерялись ли вопросы выше? Если вакансия всё ещё интересна, ответьте, пожалуйста, коротко на них, и мы продолжим 🙂 Если удобнее в WhatsApp или созвониться, пишите на +7 707 700 0087.';
const INVITE_WATCH_KEY = 'hh:invite_watch'; // negId кандидатов, которым отправили приглашение на стажировку и ещё следим за возможными вопросами
const WATCH_FOR_MS = 4 * 24 * 60 * 60 * 1000; // сколько дней после приглашения ещё проверяем чат на новые сообщения (вопросы)
const MAX_WATCH_PER_RUN = 8;

// ---- Рассылка старым откликам (архивные вакансии продаж, 2026-08-17, по прямому указанию Sagi) ----
// Sagi: «отправляй старым в день по 50» — после того как увидел реальный масштаб (~707 старых
// откликов по 55 архивным вакансиям) и сам выбрал темп, чтобы не словить бан hh.kz за спам-паттерн.
// Очередь строится один раз (buildArchiveQueue, порциями по вакансиям) и дедуплицируется по
// resume_id, чтобы один и тот же человек, откликавшийся на разные перезаливы вакансии за годы,
// получил сообщение только один раз. Отправка (archiveOutreach) идёт отдельным маршрутом с лимитом
// за вызов — вызывается РАЗ В ДЕНЬ отдельным scheduled task (не из общего часового прогона).
const ARCHIVE_QUEUE_KEY = 'hh:archive_queue';
const ARCHIVE_QUEUED_KEY = 'hh:archive_queued_resumes'; // resume_id (или neg:<id>, если резюме скрыто) — чтобы не задвоить очередь
const ARCHIVE_SENT_KEY = 'hh:archive_sent'; // negId, кому реально отправлено
function buildArchiveOutreachMessage(name) {
  const greet = name ? `${name}, здравствуйте!` : 'Здравствуйте!';
  return `${greet}\n\nВы раньше откликались у нас на вакансию менеджера по продажам. Сейчас у нас открыта вакансия менеджера по продажам, полностью удалённо, и мы приглашаем вас сразу на стажировку, это первый шаг перед выходом на работу.\n\nЧто нужно сделать:\n1) Перейти на hr.sagibonus.com\n2) Нажать на карточку «🎓 Стажёр» и зарегистрироваться (займёт минуту)\n3) Пройти базовую программу (о продукте, скрипты, тесты, есть встроенный ИИ-тренажёр звонков)\n\nПодробные условия по доходу: hr.sagibonus.com/usloviya.html\n\nЕсли вакансия уже не актуальна для вас или есть вопросы, можно ответить прямо здесь же, в этом чате, или написать в WhatsApp: +7 707 700 0087.`;
}

// Приглашение на стажировку — уходит В ТОТ ЖЕ чат на hh.kz, где кандидат уже отвечал (это
// продолжение диалога, не холодная рассылка), поэтому не выглядит спамом. Явно объясняет,
// что делать дальше, и приглашает задавать вопросы прямо здесь же. Ссылка на регистрацию несёт
// ?hh=<negId>, чтобы личный кабинет автоматически привязался к этой переписке на hh.kz — тогда
// напоминания об обучении и уведомление о наставнике смогут прийти в тот же чат.
function buildInviteMessage(name, negId) {
  const greet = (name && name !== 'Кандидат с hh.kz') ? `${name}, спасибо за ответы!` : 'Спасибо за ответы!';
  const regLink = negId ? `hr.sagibonus.com/?hh=${negId}` : 'hr.sagibonus.com';
  return `${greet}\n\nПриглашаем вас на стажировку. Это первый шаг перед выходом на работу, дальше уже на практике будет понятно, насколько вам подходит эта работа.\n\nЧто нужно сделать:\n1) Перейти на ${regLink}\n2) Нажать на карточку «🎓 Стажёр» и зарегистрироваться (займёт минуту)\n3) Пройти базовую программу (о продукте, скрипты, тесты). Есть встроенный ИИ-тренажёр, чтобы отрабатывать звонки на практике, а не только читать\n\nПодробные условия по доходу: hr.sagibonus.com/usloviya.html\n\nЕсли остались вопросы или что-то нужно уточнить по условиям, можно написать здесь же, в этом чате, или в WhatsApp: +7 707 700 0087. Если удобнее созвониться и уточнить голосом, тоже пишите на этот номер, договоримся о звонке.`;
}
async function notifyFollowUp(rec, questionText) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '', chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  const text = `❓ Вопрос от кандидата после приглашения на стажировку (HH.kz) — Sagi\n\n👤 ${rec?.name || 'Кандидат'}\n📞 ${rec?.contact || '—'}\n\n🗣 Сообщение:\n${(questionText || '').slice(0, 800)}\n\nОтветить нужно вручную, в переписке на hh.kz (автоматика больше не отвечает за этого кандидата).\nПайплайн: https://hr.sagibonus.com/pipeline.html`;
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }); } catch (e) {}
}
// ---- ФАЗА D (авто-ответ на частые вопросы после приглашения) ----
// Задача Sagi (2026-08-17): «старайся всё делать максимально самостоятельно» — прежде чем
// дёргать Sagi по каждому вопросу, пробуем сами ответить на типовые (когда стажировка, платно
// ли, нужен ли опыт, как связаться и т.д.). Если вопрос не попадает ни под один паттерн — тогда
// уже зовём Sagi, как раньше. Стиль без длинного тире, максимально по-человечески.
function answerHhFaq(text) {
  const t = (text || '').toLowerCase();
  if (/(когда начина|когда старт|когда стажир|с какого числа|как скоро)/.test(t)) return 'Начать можно в любой момент — как зарегистрируетесь на hr.sagibonus.com и пройдёте базовую программу (материалы + тесты, обычно пара дней в своём темпе). После этого подключаем наставника и переходите к практике.';
  if (/(платн|оплачива|стажировка.{0,10}(деньг|плат)|бесплатн)/.test(t)) return 'Само обучение не оплачивается отдельно, это подготовка перед стартом. А дальше действует система с окладом или без — подробно и с примерами дохода расписано тут: hr.sagibonus.com/usloviya.html';
  if (/(нужен ли опыт|без опыта|стаж работы|новичок)/.test(t)) return 'Опыт не обязателен, обучение как раз рассчитано на то, чтобы разобраться с нуля — материалы, скрипты и встроенный ИИ-тренажёр для отработки звонков.';
  if (/(сколько.{0,10}(модул|урок)|долго ли учит|сколько дней|сколько времени.{0,10}(обучен|учиться))/.test(t)) return 'Базовая программа — это набор коротких модулей с текстом и небольшими тестами, проходить можно в своём темпе, обычно занимает пару дней.';
  if (/(наставник|куратор|кто будет учить|с кем работать)/.test(t)) return 'После базовой программы вас подключат к наставнику, опытному менеджеру, дальше уже практика в паре с ним.';
  if (/(созвон|позвон|номер|телефон|whatsapp|вотсап|ватсап|связ.{0,5}голос|можно.{0,5}позвонить)/.test(t)) return 'Конечно, можно созвониться или написать в WhatsApp: +7 707 700 0087.';
  if (/(не могу зайти|не получается зарегистр|ошибка|не работает|логин|пароль)/.test(t)) return 'Если что-то не открывается или выдаёт ошибку на hr.sagibonus.com, напишите, что именно происходит, разберёмся. Можно и в WhatsApp: +7 707 700 0087, там быстрее.';
  return null;
}
async function hhReply(negId, token, text) {
  try { return await hhPostForm('/negotiations/' + negId + '/messages', token, { message: text }); } catch (e) { return { ok: false, error: e.message }; }
}
const REFRESH_KEY = 'hh:employer_refresh_token';
const ACCESS_KEY = 'hh:employer_access_token';
const ACCESS_EXP_KEY = 'hh:employer_access_expires';
// ---- ФАЗА E (напоминания стажёрам о прохождении обучения + распределение наставников) ----
// Список модулей базовой программы — держим синхронно с lessons.js (window.LESSONS.basic).
const BASIC_MODULE_IDS = ['intro', 'problem', 'bonuses', 'communication', 'crm', 'app', 'call-script', 'meeting-script', 'cases', 'final'];
const TRAINEE_STALL_MS = 48 * 60 * 60 * 1000; // не заходил / нет прогресса больше 2 дней — считаем застрявшим
const TRAINEE_REMIND_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // не напоминаем чаще раза в 3 дня
const MAX_TRAINEE_ACTIONS_PER_RUN = 8;
const MENTOR_CURSOR_KEY = 'hr:mentor_cursor';
// Наставники, которым по очереди (round-robin) отдают стажёров, прошедших базовую программу.
// Сейчас один — Азамат (Sagi подтвердил 2026-08-17). Когда появятся ещё, просто добавь сюда.
const MENTORS = [{ name: 'Азамат', phone: '+77025417933' }];
function buildTraineeReminderText(name, doneCount, total) {
  const greet = name ? `${name}, привет!` : 'Привет!';
  return `${greet}\n\nВы начали проходить обучение на hr.sagibonus.com (пройдено ${doneCount} из ${total} модулей), но давно не заходили. Если возникли сложности или вопросы по материалам, пишите сюда же или в WhatsApp: +7 707 700 0087, поможем. Если пока не готовы продолжать, тоже дайте знать, буду в курсе.`;
}
function buildMentorAssignedText(name, mentorName, mentorPhone) {
  const greet = name ? `${name}, поздравляем!` : 'Поздравляем!';
  const contactLine = mentorPhone ? `\n\nМожно написать ему напрямую в WhatsApp: ${mentorPhone}.` : '';
  return `${greet} Вы прошли базовую программу обучения. 🎉\n\nДальше с вами будет работать в паре наставник — ${mentorName || 'опытный менеджер команды'}, он свяжется с вами в ближайшее время, чтобы перейти к практике на реальных звонках и встречах.${contactLine}\n\nЕсли есть вопросы, можно написать сюда же или в WhatsApp: +7 707 700 0087.`;
}

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) return null;
  return (await r.json()).result;
}

async function getEmployerToken() {
  const now = Date.now();
  const cachedExp = parseInt((await redis(['GET', ACCESS_EXP_KEY])) || '0', 10);
  if (cachedExp > now + 60000) {
    const cached = await redis(['GET', ACCESS_KEY]);
    if (cached) return cached;
  }

  // Холодный старт (в Redis ещё ничего нет): используем изначальный access_token напрямую.
  // hh.ru отвечает invalid_grant/"token not expired", если пытаться рефрешить токен, который ещё жив —
  // поэтому не рефрешим сразу, а просто засеиваем кэш из env и отдаём access_token как есть.
  const hasCache = await redis(['EXISTS', ACCESS_KEY]);
  if (!hasCache && process.env.HH_EMPLOYER_ACCESS_TOKEN_SEED) {
    const seedAccess = process.env.HH_EMPLOYER_ACCESS_TOKEN_SEED;
    const seedExp = Date.now() + 13 * 24 * 3600 * 1000; // консервативно короче реального ~14-дневного TTL
    await redis(['SET', ACCESS_KEY, seedAccess]);
    await redis(['SET', ACCESS_EXP_KEY, String(seedExp)]);
    if (process.env.HH_EMPLOYER_REFRESH_TOKEN_SEED) await redis(['SET', REFRESH_KEY, process.env.HH_EMPLOYER_REFRESH_TOKEN_SEED]);
    return seedAccess;
  }

  let refreshToken = await redis(['GET', REFRESH_KEY]);
  if (!refreshToken) {
    refreshToken = process.env.HH_EMPLOYER_REFRESH_TOKEN_SEED || '';
    if (refreshToken) await redis(['SET', REFRESH_KEY, refreshToken]);
  }
  if (!refreshToken) throw new Error('Нет refresh_token — нужна повторная OAuth-авторизация HH (см. hh_credentials.md)');

  const r = await fetch('https://hh.ru/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.HH_CLIENT_ID || '',
      client_secret: process.env.HH_CLIENT_SECRET || '',
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('HH refresh_token обмен не удался: ' + JSON.stringify(d));
  await redis(['SET', ACCESS_KEY, d.access_token]);
  await redis(['SET', ACCESS_EXP_KEY, String(Date.now() + (d.expires_in ? d.expires_in * 1000 : 12 * 24 * 3600 * 1000))]);
  if (d.refresh_token) await redis(['SET', REFRESH_KEY, d.refresh_token]); // HH может ротировать refresh_token
  return d.access_token;
}

const HH_UA = 'SagiHRBot/1.0 (business@sagibonus.com)';
async function hhGet(path, token) {
  const r = await fetch('https://api.hh.ru' + path, { headers: { Authorization: 'Bearer ' + token, 'User-Agent': HH_UA } });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}
async function hhPost(path, token, body) {
  const r = await fetch('https://api.hh.ru' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', 'User-Agent': HH_UA },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}
// hh.ru's /negotiations/{id}/messages endpoint отклоняет JSON-тело с "bad_argument: message" —
// пробуем form-urlencoded (как /oauth/token), это распространённый паттерн у части его API.
async function hhPostForm(path, token, params) {
  const r = await fetch('https://api.hh.ru' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': HH_UA },
    body: new URLSearchParams(params || {}),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}

// Сейчас у Sagi активна только удалённая вакансия продаж (реальный заголовок на hh.kz —
// «Менеджер по продажам (B2B клиенты)» — без слова «удалённо» в названии!). Поэтому логика
// обратная: ищем явные признаки ОФИСНОЙ вакансии, а по умолчанию считаем удалённой.
function pickVacancyKind(title) {
  const s = (title || '').toLowerCase();
  if (/удал[её]н|дистанц|из дома|remote/.test(s)) return 'sales_remote';
  if (/\bофис|очно/.test(s)) return 'sales';
  return 'sales_remote';
}

// ---- ИИ-оценка ОТВЕТА кандидата (не резюме!) ----
// Задача: понять, стоит ли двигать человека к стажировке. Смотрим на адекватность речи,
// вменяемость ответов и мотивацию — НЕ придираемся к формальному опыту продаж.
const SCREEN_REPLY_SALES = `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ, вакансия «Менеджер по продажам», офис в Астане).
Тебе дан ответ кандидата на первое сообщение (вопросы про опыт звонков, готовность работать в офисе, когда готов начать).
ВАЖНО: НЕ придирайся к отсутствию опыта продаж — многие сильные продажники раскрываются не в резюме, а на стажировке. Твоя задача — понять,
адекватно ли человек отвечает, связная ли речь, есть ли реальная мотивация и готовность работать, нет ли явных красных флагов (грубость,
неадекватность, явное нежелание работать). Цель компании — довести как можно больше вменяемых кандидатов до стажировки, там уже будет видно.
Верни ТОЛЬКО валидный JSON без markdown:
{"recommend": "На стажировку" | "Уточнить" | "Не подходит", "summary": "<2-3 предложения по ответу кандидата>", "strengths": ["..."], "flags": ["..."]}`;

const SCREEN_REPLY_SALES_REMOTE = `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ, вакансия «Менеджер по продажам — удалённо»).
Тебе дан ответ кандидата на первое сообщение (вопросы про опыт звонков, когда готов начать).
ВАЖНО: НЕ придирайся к отсутствию опыта продаж — многие сильные продажники раскрываются не в резюме, а на стажировке. НЕ считай красным флагом
отсутствие компьютера или нестабильный интернет на старте — первые 1-2 недели стажёр только звонит и назначает встречи, а саму встречу (демо по
Zoom) проводит наставник, компьютер понадобится не с первого дня. Твоя задача — понять, адекватно ли человек отвечает, связная ли речь, есть ли
реальная мотивация и готовность учиться, нет ли явных красных флагов (грубость, неадекватность, прямой отказ работать/учиться в принципе). Цель
компании — довести как можно больше вменяемых кандидатов до стажировки, там уже будет видно.
Верни ТОЛЬКО валидный JSON без markdown:
{"recommend": "На стажировку" | "Уточнить" | "Не подходит", "summary": "<2-3 предложения по ответу кандидата>", "strengths": ["..."], "flags": ["..."]}`;

async function evaluateReply(vacKind, name, replyText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let out = { recommend: null, summary: '', strengths: [], flags: [], _debug: '' };
  if (!apiKey) { out._debug = 'no ANTHROPIC_API_KEY'; return out; }
  if (!replyText) { out._debug = 'empty replyText'; return out; }
  const sys = vacKind === 'sales_remote' ? SCREEN_REPLY_SALES_REMOTE : SCREEN_REPLY_SALES;
  try {
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: sys, messages: [{ role: 'user', content: `Кандидат: ${name}\n\nОтвет кандидата на hh.kz:\n${replyText.slice(0, 4000)}` }] }),
    });
    const ad = await ar.json();
    if (ar.ok) {
      const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { const o = JSON.parse(m[0]); out = { recommend: o.recommend || null, summary: o.summary || '', strengths: o.strengths || [], flags: o.flags || [] }; }
      else out._debug = 'no JSON match in response: ' + txt.slice(0, 200);
    } else {
      out._debug = 'anthropic api error ' + ar.status + ': ' + JSON.stringify(ad).slice(0, 300);
    }
  } catch (e) { out._debug = 'exception: ' + e.message; }
  return out;
}

function buildResumeText(resume) {
  if (!resume) return '';
  const parts = [];
  if (resume.title) parts.push('Позиция в резюме: ' + resume.title);
  if (resume.total_experience && resume.total_experience.months != null) {
    const m = resume.total_experience.months;
    parts.push(`Опыт всего: ${Math.floor(m / 12)} лет ${m % 12} мес`);
  }
  if (Array.isArray(resume.experience)) {
    for (const e of resume.experience.slice(0, 6)) {
      parts.push(`${e.position || ''} — ${e.company || ''} (${e.start || ''}–${e.end || 'н.в.'})\n${(e.description || '').replace(/<[^>]+>/g, ' ').slice(0, 500)}`);
    }
  }
  if (Array.isArray(resume.skill_set) && resume.skill_set.length) parts.push('Ключевые навыки: ' + resume.skill_set.join(', '));
  if (resume.skills) parts.push('О себе: ' + String(resume.skills).replace(/<[^>]+>/g, ' '));
  return parts.filter(Boolean).join('\n\n').slice(0, 7000);
}

function extractPhone(resume) {
  try {
    const c = (resume?.contact || []).find(x => x?.type?.id === 'cell' || x?.type?.id === 'home');
    return c?.value?.formatted || c?.value?.raw || '';
  } catch (e) { return ''; }
}

// Алерт РОПу — теперь только когда кандидат РЕАЛЬНО ответил (не на входе).
async function notifyReplied(rec, replyText) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '', chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  const text = `🎓 Кандидат ответил → отправлен на стажировку (HH.kz) — Sagi\n\n🎯 Вакансия: ${rec.vacancy}\n👤 ${rec.name}\n📞 ${rec.contact || '—'}\n\n🗣 Ответ кандидата:\n${(replyText || '').slice(0, 800)}\n\n🤖 Рекомендация ИИ (для справки, на решение не влияет): ${rec.verdict || '—'}\n${rec.summary || ''}\n\nСтажёру можно отправить материалы обучения: hr.sagibonus.com (карточка «🎓 Стажёр»)\nПайплайн: https://hr.sagibonus.com/pipeline.html`;
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }); } catch (e) {}
}

// Шаблон первого сообщения — фирменный стиль Sagi (тот, которым Sagi писал раньше вручную).
function buildFirstMessage(vacKind, name) {
  const greet = (name && name !== 'Кандидат с hh.kz') ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
  const isRemote = vacKind === 'sales_remote';
  const vacLine = isRemote ? 'Менеджер по B2B-продажам (удалённо)' : 'Менеджер по B2B-продажам';
  const q3 = isRemote
    ? 'Не собираетесь совмещать с другой работой или учёбой?'
    : 'Вы находитесь в Астане и готовы работать в офисе, не совмещая с другой работой или учёбой?';
  const q5 = isRemote ? '\n5) В каком городе вы сейчас проживаете?' : '';
  return `${greet}

Вы откликнулись на нашу вакансию:
${vacLine}

Об условиях и требованиях можно ознакомиться в самой вакансии.

Это IT-компания Sagi.
Наш Instagram: @sagi.bonus

Финансовые условия:
• Доход: фикс оклад 100 тыс ₸ + KPI до 120 тыс ₸ за проведённые встречи и звонки + бонусы с продаж. Менеджеры получают от 600 тыс до 1,2 млн ₸.
• Подробный расчёт (по шагам, с примерами): hr.sagibonus.com/usloviya.html

Если вам откликается данная вакансия, ответьте, пожалуйста, на следующие вопросы, можно коротко:

1) Есть ли у вас опыт в активных B2B-продажах? Это были МСБ предприниматели?
2) Имеется ли у вас опыт холодных звонков? Готовы совершать более 50 хол. звонков в день?
3) ${q3}
4) Если мы рассмотрим вашу кандидатуру, когда вы готовы приступить к работе / начать стажировку?${q5}

Если удобнее уточнить что-то в звонке или в WhatsApp, пишите: +7 707 700 0087.`;
}

// Находит в hr:candidates запись по id и заменяет её (обновление, а не добавление).
async function updateCandidateRecord(id, patch) {
  const raw = await redis(['LRANGE', CAND_KEY, 0, -1]);
  if (!Array.isArray(raw)) return false;
  for (let i = 0; i < raw.length; i++) {
    let rec;
    try { rec = JSON.parse(raw[i]); } catch (e) { continue; }
    if (rec && rec.id === id) {
      const updated = { ...rec, ...patch };
      await redis(['LSET', CAND_KEY, i, JSON.stringify(updated)]);
      return updated;
    }
  }
  return false;
}

// Достаёт текст последнего сообщения кандидата, если оно пришло ПОСЛЕ нашего сообщения
// (т.е. это реальный ответ на вопросы, а не изначальное сопроводительное письмо).
function extractCandidateReply(messages) {
  if (!Array.isArray(messages) || !messages.length) return { replyText: '', debug: 'no messages array' };
  const withTime = messages.map(m => ({
    text: m.text || m.message || '',
    author: m.author?.participant_type || m.author_type || m.from || '',
    ts: m.created_at ? Date.parse(m.created_at) : 0,
  }));
  withTime.sort((a, b) => a.ts - b.ts);
  const lastEmployerIdx = withTime.map((m, i) => ({ m, i })).filter(x => /employer/i.test(x.m.author)).map(x => x.i).pop();
  if (lastEmployerIdx == null) return { replyText: '', debug: 'no employer message found yet (первое сообщение ещё не учтено)' };
  const after = withTime.slice(lastEmployerIdx + 1).filter(m => /applicant|candidate|seeker/i.test(m.author) && m.text);
  if (!after.length) return { replyText: '', debug: 'no applicant message after our first message' };
  return { replyText: after.map(m => m.text).join('\n'), debug: '' };
}

export default async function handler(req, res) {
  // Ручное добавление кандидата — ТОЛЬКО через POST с телом (не query-параметрами), чтобы
  // имя/телефон кандидата не попадали в URL/логи. Обрабатывается до общей проверки method===GET.
  if (req.method === 'POST' && req.query?.addManual) {
    if (!process.env.HH_POLL_SECRET || (req.query?.secret || '') !== process.env.HH_POLL_SECRET) { res.status(403).json({ error: 'forbidden' }); return; }
    try {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body || '{}');
      body = body || {};
      const name = String(body.name || 'Без имени').slice(0, 200);
      const phoneRaw = String(body.phone || '');
      const note = String(body.note || '').slice(0, 2000);
      const stage = String(body.stage || 'Новый').slice(0, 50);
      const vacancy = String(body.vacancy || 'Менеджер по продажам, удалённо').slice(0, 200);
      const rec = {
        id: 'manual_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        name, contact: phoneRaw, phone: phoneRaw.replace(/\D/g, ''),
        vacancy, source: 'Ручное добавление (WhatsApp напрямую)',
        resume: note, score: null, verdict: null, summary: note,
        strengths: [], flags: [], stage, ts: Date.now(),
      };
      await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]);
      await redis(['LTRIM', CAND_KEY, 0, 1999]);
      res.status(200).json({ ok: true, added: rec });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!process.env.HH_POLL_SECRET || (req.query?.secret || '') !== process.env.HH_POLL_SECRET) { res.status(403).json({ error: 'forbidden' }); return; }
  const debug = req.query?.debug === '1';
  const dryRun = req.query?.dryrun === '1';

  // Диагностика: узнать, с какого именно Telegram-бота (username) и в какой чат уходят алерты
  // РОПу по ответам на hh.kz — это ДРУГОЙ бот, чем @Sagijobsbot (careers-бот кандидатов).
  if (req.query?.whoami) {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN || '';
      const chatId = process.env.TELEGRAM_CHAT_ID || '';
      if (!token) { res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN не задан в env' }); return; }
      const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const me = await meRes.json();
      let chatInfo = null;
      if (chatId) {
        try {
          const chatRes = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
          chatInfo = await chatRes.json();
        } catch (e) {}
      }
      res.status(200).json({
        ok: !!me.ok,
        bot: me.ok ? { id: me.result.id, username: '@' + me.result.username, name: me.result.first_name, link: 'https://t.me/' + me.result.username } : me,
        configuredChatId: chatId || null,
        chatInfo,
      });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика: TELEGRAM_CHAT_ID не задан — нужно узнать chat_id того, кто написал боту.
  // Сначала написать боту (@SagiHRbot) любое сообщение, потом дёрнуть этот маршрут — вернёт
  // список последних сообщений с chat.id и именем отправителя.
  if (req.query?.getUpdates) {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN || '';
      if (!token) { res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN не задан в env' }); return; }
      const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`);
      const d = await r.json();
      const chats = (d.result || []).map(u => {
        const msg = u.message || u.edited_message || u.channel_post;
        if (!msg || !msg.chat) return null;
        return { chatId: msg.chat.id, type: msg.chat.type, name: [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.title || msg.chat.username, username: msg.chat.username ? '@' + msg.chat.username : null, text: (msg.text || '').slice(0, 80), date: msg.date };
      }).filter(Boolean);
      res.status(200).json({ ok: !!d.ok, chats });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика/фикс (2026-08-17): после ре-авторизации HH OAuth (новый refresh_token в env
  // HH_EMPLOYER_REFRESH_TOKEN_SEED) старый access_token остаётся закэширован в Redis с ещё
  // не истёкшим "искусственным" TTL — код продолжает отдавать отозванный токен, не пытаясь
  // его обновить. Этот маршрут чистит кэш в Redis, чтобы следующий вызов заново засеялся из
  // свежих env-переменных и получил новый access_token через refresh_token grant.
  if (req.query?.resetTokens) {
    try {
      await redis(['DEL', REFRESH_KEY]);
      await redis(['DEL', ACCESS_KEY]);
      await redis(['DEL', ACCESS_EXP_KEY]);
      // Сразу пробуем получить новый токен, чтобы увидеть результат прямо в ответе.
      let fresh = null, freshErr = null;
      try { fresh = await getEmployerToken(); } catch (e) { freshErr = e.message; }
      res.status(200).json({ ok: !freshErr, cleared: [REFRESH_KEY, ACCESS_KEY, ACCESS_EXP_KEY], gotFreshToken: !!fresh, error: freshErr || null });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика (2026-08-17): ищем ЗАКРЫТЫЕ/архивные вакансии hh.kz — по ним могли остаться
  // старые переписки, которых наша автоматика никогда не видела (она тянет только /active).
  // Пробуем несколько вариантов эндпоинта hh.ru API, т.к. точная форма заранее не известна.
  if (req.query?.archivedVac) {
    try {
      const token = await getEmployerToken();
      const employerId = process.env.HH_EMPLOYER_ID || '';
      const attempts = [
        { label: 'employers/archived', path: `/employers/${employerId}/vacancies/archived?per_page=50` },
        { label: 'vacancies (mine)', path: `/vacancies?employer_id=${employerId}&per_page=50` },
        { label: 'employers/inactive', path: `/employers/${employerId}/vacancies/inactive?per_page=50` },
      ];
      const results = [];
      for (const a of attempts) {
        const r = await hhGet(a.path, token);
        results.push({ label: a.label, path: a.path, ok: r.ok, status: r.status, foundCount: r.ok ? (r.data.found ?? r.data.items?.length ?? null) : null, items: r.ok ? (r.data.items || []).slice(0, 30).map(v => ({ id: v.id, name: v.name, area: v.area?.name })) : null, error: r.ok ? null : r.data });
      }
      res.status(200).json({ ok: true, results });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика (2026-08-17, шаг 2): полный список архивных вакансий (без обрезки в 30 штук,
  // с постраничной подгрузкой всех 87), фильтр по названию (только «продаж», чтобы отсечь
  // явно нерелевантные вроде «Продакт-менеджер» / «Менеджер по подбору персонала» — те не
  // содержат подстроку «продаж»), и для отфильтрованных — подсчёт числа откликов/переписок
  // по каждой вакансии (per_page=1, интересует только found), чтобы понять реальный масштаб
  // ДО того как что-то отправлять людям.
  // Лёгкая версия: только список (без подсчёта откликов) — быстро, чтобы не упираться в
  // таймаут serverless-функции. Подсчёт откликов — отдельным маршрутом archivedVacCounts
  // небольшими порциями (offset/limit), т.к. каждый счётчик — отдельный HTTP-запрос к hh.ru.
  if (req.query?.archivedVacFull) {
    try {
      const token = await getEmployerToken();
      const employerId = process.env.HH_EMPLOYER_ID || '';
      let all = [];
      let page = 0;
      let found = null;
      for (let i = 0; i < 5; i++) {
        const r = await hhGet(`/employers/${employerId}/vacancies/archived?per_page=50&page=${page}`, token);
        if (!r.ok) { res.status(200).json({ ok: false, step: 'archived', page, status: r.status, error: r.data }); return; }
        found = r.data.found ?? found;
        const items = r.data.items || [];
        all = all.concat(items.map(v => ({ id: v.id, name: v.name, area: v.area?.name || null })));
        if (items.length < 50) break; // последняя страница
        page++;
      }

      const relevant = all.filter(v => /продаж/i.test(v.name || ''));
      const irrelevant = all.filter(v => !/продаж/i.test(v.name || ''));

      res.status(200).json({
        ok: true,
        totalArchived: found,
        fetchedCount: all.length,
        relevantCount: relevant.length,
        relevant,
        irrelevantSample: irrelevant.slice(0, 15).map(v => ({ id: v.id, name: v.name, area: v.area })),
      });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Подсчёт откликов по релевантным архивным вакансиям, порциями (по умолчанию 8 за вызов),
  // чтобы не упираться в таймаут. &offset=N — с какой позиции в отфильтрованном списке начать.
  if (req.query?.archivedVacCounts) {
    try {
      const token = await getEmployerToken();
      const employerId = process.env.HH_EMPLOYER_ID || '';
      let all = [];
      let page = 0;
      for (let i = 0; i < 5; i++) {
        const r = await hhGet(`/employers/${employerId}/vacancies/archived?per_page=50&page=${page}`, token);
        if (!r.ok) { res.status(200).json({ ok: false, step: 'archived', page, status: r.status, error: r.data }); return; }
        const items = r.data.items || [];
        all = all.concat(items.map(v => ({ id: v.id, name: v.name, area: v.area?.name || null })));
        if (items.length < 50) break;
        page++;
      }
      const relevant = all.filter(v => /продаж/i.test(v.name || ''));
      const offset = parseInt(req.query.offset || '0', 10) || 0;
      const limit = parseInt(req.query.limit || '8', 10) || 8;
      const slice = relevant.slice(offset, offset + limit);
      const withCounts = [];
      for (const v of slice) {
        try {
          const nr = await hhGet(`/negotiations/response?vacancy_id=${v.id}&per_page=1`, token);
          withCounts.push({ ...v, negotiations: nr.ok ? (nr.data.found ?? null) : null, error: nr.ok ? null : nr.status });
        } catch (e) {
          withCounts.push({ ...v, negotiations: null, error: e.message });
        }
      }
      res.status(200).json({
        ok: true,
        relevantTotal: relevant.length,
        offset, limit,
        nextOffset: offset + limit < relevant.length ? offset + limit : null,
        items: withCounts,
      });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Строит очередь рассылки старым откликам (2026-08-17, по указанию Sagi), порциями по
  // вакансиям (&offset=N — с какой вакансии в отфильтрованном списке начать, &vlimit=M — сколько
  // вакансий обработать за вызов, по умолчанию 5), чтобы не упереться в таймаут. Внутри каждой
  // вакансии тянет ВСЕ негоциации (с пагинацией, если больше 50). Дедуп по resume_id — если один
  // и тот же человек откликался на несколько перезаливов вакансии за годы, в очередь попадает
  // только первое вхождение. Безопасно вызывать повторно (уже добавленные resume_id пропускаются).
  if (req.query?.buildArchiveQueue) {
    try {
      const token = await getEmployerToken();
      const employerId = process.env.HH_EMPLOYER_ID || '';
      let all = [];
      let page = 0;
      for (let i = 0; i < 5; i++) {
        const r = await hhGet(`/employers/${employerId}/vacancies/archived?per_page=50&page=${page}`, token);
        if (!r.ok) { res.status(200).json({ ok: false, step: 'archived', page, status: r.status, error: r.data }); return; }
        const items = r.data.items || [];
        all = all.concat(items.map(v => ({ id: v.id, name: v.name })));
        if (items.length < 50) break;
        page++;
      }
      const relevant = all.filter(v => /продаж/i.test(v.name || ''));
      const offset = parseInt(req.query.offset || '0', 10) || 0;
      const vlimit = parseInt(req.query.vlimit || '5', 10) || 5;
      const slice = relevant.slice(offset, offset + vlimit);

      // Дедуп держим в памяти одного вызова (SMEMBERS один раз), пишем в конце ОДНИМ RPUSH/SADD
      // на всю порцию — иначе по редис-запросу на каждого из сотен кандидатов упирались в таймаут.
      const queuedSoFar = new Set((await redis(['SMEMBERS', ARCHIVE_QUEUED_KEY])) || []);
      let queued = 0, skippedDup = 0, skippedNoResume = 0;
      const preview = [];
      const newEntries = [];
      const newDedupKeys = [];
      for (const v of slice) {
        let negPage = 0;
        for (let i = 0; i < 4; i++) {
          const nr = await hhGet(`/negotiations/response?vacancy_id=${v.id}&per_page=50&page=${negPage}&order_by=created_at`, token);
          if (!nr.ok) break;
          const items = nr.data.items || [];
          for (const it of items) {
            const negId = String(it.id || '');
            if (!negId) continue;
            const resumeId = it.resume?.id || null;
            const dedupKey = resumeId ? 'r:' + resumeId : 'n:' + negId;
            if (queuedSoFar.has(dedupKey)) { skippedDup++; continue; }
            queuedSoFar.add(dedupKey);
            const name = [it.resume?.first_name, it.resume?.last_name].filter(Boolean).join(' ') || null;
            if (!resumeId) skippedNoResume++;
            const entry = { negId, resumeId, name, vacId: v.id, vacName: v.name };
            newEntries.push(entry);
            newDedupKeys.push(dedupKey);
            queued++;
            if (preview.length < 15) preview.push(entry);
          }
          if (items.length < 50) break;
          negPage++;
        }
      }
      if (!dryRun && newEntries.length) {
        await redis(['RPUSH', ARCHIVE_QUEUE_KEY, ...newEntries.map(e => JSON.stringify(e))]);
        await redis(['SADD', ARCHIVE_QUEUED_KEY, ...newDedupKeys]);
      }
      res.status(200).json({
        ok: true, dryRun,
        relevantTotal: relevant.length,
        offset, vlimit,
        nextOffset: offset + vlimit < relevant.length ? offset + vlimit : null,
        vacanciesProcessed: slice.map(v => ({ id: v.id, name: v.name })),
        queued, skippedDup, skippedNoResume,
        preview,
      });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика: размер очереди рассылки старым откликам и сколько уже реально отправлено.
  if (req.query?.archiveQueueStatus) {
    try {
      const queueLen = await redis(['LLEN', ARCHIVE_QUEUE_KEY]);
      const queuedTotal = await redis(['SCARD', ARCHIVE_QUEUED_KEY]);
      const sentTotal = await redis(['SCARD', ARCHIVE_SENT_KEY]);
      res.status(200).json({ ok: true, queueLen, queuedTotal, sentTotal });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Ежедневная отправка старым откликам (2026-08-17, по указанию Sagi — «в день по 50»).
  // Забирает из очереди до &limit=N (по умолчанию 50) записей и шлёт каждой приглашение на
  // стажировку в ту же переписку на hh.kz. ВАЖНО: вызывать этим маршрутом ТОЛЬКО из отдельного
  // ежедневного scheduled task, НЕ из общего часового прогона — иначе темп «50 в день» будет
  // превышен в разы и это будет выглядеть как спам для hh.kz.
  if (req.query?.archiveOutreach) {
    try {
      const token = await getEmployerToken();
      const limit = parseInt(req.query.limit || '50', 10) || 50;
      let sent = 0, failed = 0;
      const results = [];
      for (let i = 0; i < limit; i++) {
        const raw = await redis(['LPOP', ARCHIVE_QUEUE_KEY]);
        if (!raw) break;
        let entry; try { entry = JSON.parse(raw); } catch (e) { continue; }
        const text = buildArchiveOutreachMessage(entry.name);
        if (dryRun) {
          sent++;
          results.push({ negId: entry.negId, name: entry.name, vacName: entry.vacName, dryRun: true });
          continue;
        }
        const r = await hhReply(entry.negId, token, text);
        if (r.ok) {
          await redis(['SADD', ARCHIVE_SENT_KEY, entry.negId]);
          sent++;
          results.push({ negId: entry.negId, name: entry.name, vacName: entry.vacName });
        } else {
          failed++;
          results.push({ negId: entry.negId, name: entry.name, error: r.status });
        }
      }
      const remaining = await redis(['LLEN', ARCHIVE_QUEUE_KEY]);
      res.status(200).json({ ok: true, dryRun, sent, failed, remainingInQueue: remaining, results });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика (2026-08-17): реальный список активных вакансий на hh.kz + для каждой немного
  // сырых негоциаций как есть от API — чтобы проверить, действительно ли «Менеджер по продажам»
  // (59 карточек без «удалённо») это отдельная вакансия, или просто у части негоциаций hh.kz не
  // возвращает vacancy.name и код подставляет запасной текст по умолчанию.
  if (req.query?.vacList) {
    try {
      const token = await getEmployerToken();
      const employerId = process.env.HH_EMPLOYER_ID || '';
      const vacRes = await hhGet(`/employers/${employerId}/vacancies/active?per_page=50`, token);
      if (!vacRes.ok) { res.status(200).json({ ok: false, step: 'vacancies', status: vacRes.status, data: vacRes.data }); return; }
      const vacancies = (vacRes.data.items || []).map(v => ({ id: v.id, name: v.name }));
      const perVacancy = [];
      for (const v of vacancies) {
        const neg = await hhGet(`/negotiations/response?vacancy_id=${v.id}&per_page=5&order_by=created_at`, token);
        const sampleItems = (neg.ok ? (neg.data.items || []) : []).map(it => ({ negId: it.id, vacancyNamePresent: !!it.vacancy?.name, vacancyName: it.vacancy?.name || null }));
        perVacancy.push({ vacancyId: v.id, vacancyName: v.name, negTotal: neg.ok ? (neg.data.found ?? neg.data.items?.length ?? null) : null, sample: sampleItems, error: neg.ok ? null : { status: neg.status, data: neg.data } });
      }
      res.status(200).json({ ok: true, activeVacancies: vacancies, perVacancy });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика (2026-08-17): срез по всем зарегистрированным стажёрам/менеджерам и их
  // прогрессу обучения — быстро посмотреть, не дёргая пароль руководителя.
  if (req.query?.traineeStatus) {
    try {
      const logins = (await redis(['SMEMBERS', 'hr:users'])) || [];
      const users = [];
      for (const login of logins) {
        const raw = await redis(['GET', 'hr:user:' + login]);
        if (!raw) continue;
        try {
          const u = JSON.parse(raw);
          const doneCount = BASIC_MODULE_IDS.filter(id => u.progress && u.progress[id]).length;
          users.push({ login, name: u.name, role: u.role, doneCount, total: BASIC_MODULE_IDS.length, hhNegId: u.hhNegId || null, mentorName: u.mentorName || null, lastSeen: u.lastSeen || null, createdAt: u.createdAt || null });
        } catch (e) {}
      }
      res.status(200).json({ ok: true, count: users.length, users });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Ручное назначение наставника (2026-08-17, по указанию Sagi) — для случаев, когда Sagi уже
  // сам лично связал стажёра с наставником (звонок/WhatsApp), без сообщения от бота, чтобы не
  // задвоить уведомление. По умолчанию берёт первого из MENTORS (сейчас только Азамат).
  if (req.query?.setMentorManual) {
    try {
      const login = String(req.query.setMentorManual);
      const raw = await redis(['GET', 'hr:user:' + login]);
      if (!raw) { res.status(200).json({ ok: false, error: 'trainee not found: ' + login }); return; }
      const u = JSON.parse(raw);
      const mentor = MENTORS[0];
      if (!dryRun) {
        u.mentorName = mentor.name; u.mentorPhone = mentor.phone; u.mentorAssignedAt = Date.now();
        await redis(['SET', 'hr:user:' + login, JSON.stringify(u)]);
      }
      res.status(200).json({ ok: true, dryRun, login, name: u.name, mentorName: mentor.name, mentorPhone: mentor.phone });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Перевод стажёра в менеджеры (2026-08-17, по указанию Sagi) — тот же логин/пароль/прогресс/
  // наставник остаются, меняется только role. Открывает продвинутые модули (ADV) автоматически.
  // Зеркало action=setRole из users.js (там за паролем руководителя, сюда у меня доступ есть).
  if (req.query?.promoteToManager) {
    try {
      const login = String(req.query.promoteToManager);
      const role = req.query.demote ? 'trainee' : 'manager';
      const raw = await redis(['GET', 'hr:user:' + login]);
      if (!raw) { res.status(200).json({ ok: false, error: 'trainee not found: ' + login }); return; }
      const u = JSON.parse(raw);
      u.role = role;
      if (role === 'manager' && !u.promotedAt) u.promotedAt = Date.now();
      if (!dryRun) await redis(['SET', 'hr:user:' + login, JSON.stringify(u)]);
      res.status(200).json({ ok: true, dryRun, login, name: u.name, role: u.role });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Точная ручная связка стажёра с конкретной карточкой кандидата (по id из hr:candidates) —
  // для случаев, когда автоматический матчинг не справился (нет телефона/hhNegId, имя записано
  // по-другому), но по контексту понятно, что это тот же человек.
  if (req.query?.linkTraineeToCandidate) {
    try {
      const login = String(req.query.linkTraineeToCandidate);
      const candId = String(req.query.candId || '');
      if (!candId) { res.status(200).json({ ok: false, error: 'candId required' }); return; }
      const raw = await redis(['GET', 'hr:user:' + login]);
      if (!raw) { res.status(200).json({ ok: false, error: 'trainee not found' }); return; }
      const u = JSON.parse(raw);
      const candsRaw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const cands = candsRaw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const match = cands.find(c => c.id === candId);
      if (!match) { res.status(200).json({ ok: false, error: 'candidate not found: ' + candId }); return; }
      const answersText = match.replyText || match.resume || (Array.isArray(match.answers) ? match.answers.map(a => `${a.q}: ${a.a}`).join('\n\n') : '') || '';
      if (!dryRun) {
        u.intakeAnswers = answersText.slice(0, 4000);
        u.intakeVacancy = match.vacancy || null;
        await redis(['SET', 'hr:user:' + login, JSON.stringify(u)]);
      }
      res.status(200).json({ ok: true, dryRun, login, candId, vacancy: match.vacancy, answersPreview: answersText.slice(0, 200) });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика: сырая карточка стажёра по логину + похожие по имени кандидаты в пайплайне —
  // чтобы разобраться, почему автоматический матчинг для бэкфилла не сработал.
  // Диагностика: поиск кандидата в пайплайне по части имени (без пароля руководителя) — быстро
  // посмотреть статус конкретного человека, когда он написал Sagi напрямую (WhatsApp/звонок).
  if (req.query?.searchCandidate) {
    try {
      const q = String(req.query.searchCandidate || '').trim().toLowerCase();
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const items = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const found = items.filter(c => (c.name || '').toLowerCase().includes(q))
        .map(c => ({ id: c.id, name: c.name, contact: c.contact, phone: c.phone, vacancy: c.vacancy, stage: c.stage, verdict: c.verdict, score: c.score, source: c.source, ts: c.ts, hasAnswers: !!(c.replyText || c.resume) }));
      res.status(200).json({ ok: true, count: found.length, found });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Ручная коррекция статуса кандидата (2026-08-17, по указанию Sagi) — например, когда
  // авто-отказ был по технической причине (пустая ссылка вместо ответа), а не по существу,
  // и Sagi лично ведёт кандидата дальше в переписке.
  if (req.query?.setCandidateStage) {
    try {
      const id = String(req.query.setCandidateStage);
      const stage = String(req.query.stage || 'Стажировка');
      const patch = { stage };
      if (req.query.clearVerdict) { patch.verdict = null; patch.score = null; }
      const updated = await updateCandidateRecord(id, patch);
      if (!updated) { res.status(200).json({ ok: false, error: 'not found' }); return; }
      res.status(200).json({ ok: true, id, stage: updated.stage, verdict: updated.verdict, score: updated.score });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика: полная карточка кандидата по id (включая текст ответов) — чтобы прочитать,
  // что именно кандидат ответил на вопросы, перед тем как подсказать Sagi текст ответа.
  if (req.query?.candidateDetail) {
    try {
      const id = String(req.query.candidateDetail);
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const items = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const c = items.find(x => x.id === id);
      if (!c) { res.status(200).json({ ok: false, error: 'not found' }); return; }
      const answersText = c.replyText || c.resume || (Array.isArray(c.answers) ? c.answers.map(a => `${a.q}: ${a.a}`).join('\n\n') : '') || '';
      res.status(200).json({
        ok: true,
        candidate: {
          id: c.id, name: c.name, contact: c.contact, phone: c.phone, vacancy: c.vacancy,
          stage: c.stage, verdict: c.verdict, score: c.score, summary: c.summary || null,
          source: c.source, ts: c.ts, answersText: answersText.slice(0, 4000),
        },
      });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  if (req.query?.debugTraineeMatch) {
    try {
      const login = String(req.query.debugTraineeMatch);
      const raw = await redis(['GET', 'hr:user:' + login]);
      if (!raw) { res.status(200).json({ ok: false, error: 'not found' }); return; }
      const u = JSON.parse(raw);
      const candsRaw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const cands = candsRaw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const nameParts = (u.name || '').toLowerCase().split(/\s+/).filter(Boolean);
      const similar = cands.filter(c => nameParts.some(p => p.length > 2 && (c.name || '').toLowerCase().includes(p)))
        .map(c => ({ id: c.id, name: c.name, contact: c.contact, phone: c.phone, vacancy: c.vacancy, hasAnswers: !!(c.replyText || c.resume) }));
      res.status(200).json({ ok: true, user: { login: u.login, name: u.name, phone: u.phone || null, hhNegId: u.hhNegId || null }, similarCandidates: similar });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Бэкфилл (2026-08-17, по указанию Sagi «ответы кандидатов нужно хранить в профайле») —
  // подтягивает исходные ответы на вопросы при отклике (уже сохранены в hr:candidates как
  // resume/replyText/answers) в карточки уже зарегистрированных стажёров, у которых этой связки
  // ещё нет (для новых регистраций это теперь делается автоматически в api/users.js). Матчит по
  // hhNegId, затем по телефону, затем по точному имени. Безопасно вызывать повторно.
  if (req.query?.backfillIntakeAnswers) {
    try {
      const normPhone = s => (s || '').toString().replace(/\D/g, '').slice(-10);
      const normName = s => (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
      const candsRaw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const cands = candsRaw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const logins = (await redis(['SMEMBERS', 'hr:users'])) || [];
      let updated = 0, skipped = 0, notFound = 0;
      const names = [];
      for (const login of logins) {
        const raw = await redis(['GET', 'hr:user:' + login]);
        if (!raw) continue;
        let u; try { u = JSON.parse(raw); } catch (e) { continue; }
        if (u.intakeAnswers) { skipped++; continue; }
        let match = null;
        if (u.hhNegId) match = cands.find(c => c.id === 'hh_' + u.hhNegId);
        if (!match && u.phone) { const p = normPhone(u.phone); match = cands.find(c => normPhone(c.contact) === p || normPhone(c.phone) === p); }
        if (!match && u.name) { const n = normName(u.name); match = cands.find(c => normName(c.name) === n); }
        if (!match) { notFound++; continue; }
        const answersText = match.replyText || match.resume || (Array.isArray(match.answers) ? match.answers.map(a => `${a.q}: ${a.a}`).join('\n\n') : '') || '';
        if (!answersText) { notFound++; continue; }
        if (!dryRun) {
          u.intakeAnswers = answersText.slice(0, 4000);
          u.intakeVacancy = match.vacancy || null;
          await redis(['SET', 'hr:user:' + login, JSON.stringify(u)]);
        }
        updated++;
        names.push({ login, name: u.name, vacancy: match.vacancy });
      }
      res.status(200).json({ ok: true, dryRun, updated, skipped, notFound, names });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика (2026-08-17): срез по всем кандидатам в пайплайне — по стадии, вакансии и
  // каналу — чтобы увидеть, сколько из тех, кто откликнулся ДО сегодняшних изменений, всё ещё
  // висят на «Новый» без приглашения на стажировку (раньше для них не было автоматики).
  if (req.query?.candidateStats) {
    try {
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const items = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const byStage = {}, byVacancy = {}, byChannel = {};
      const backlog = [];
      // Пул для реактивации: отклики на СТАРУЮ офисную вакансию продаж (не удалённую, не
      // техподдержку), у которых нет жёсткого «Отказ» — потенциально стоит предложить им новую
      // удалённую вакансию. Считаем отдельно по каналу, т.к. писать повторно можно надёжно
      // только туда, откуда есть реальный канал (hh.kz — да; Telegram-бот — только если есть
      // сохранённый chat_id, сейчас НЕ сохраняется; форма/WhatsApp без канала — нет).
      const reactivation = { total: 0, byChannel: {}, byVerdict: {}, sample: [] };
      for (const c of items) {
        byStage[c.stage] = (byStage[c.stage] || 0) + 1;
        byVacancy[c.vacancy || '—'] = (byVacancy[c.vacancy || '—'] || 0) + 1;
        const channel = c.id?.startsWith('hh_') ? 'hh.kz' : (c.source || '').startsWith('Telegram-бот') ? 'Telegram-бот' : (c.source || '').startsWith('WhatsApp-бот') ? 'WhatsApp-бот' : (c.source || '').includes('форма отклика') ? 'форма отклика' : 'другое';
        byChannel[channel] = (byChannel[channel] || 0) + 1;
        const isSalesVac = /продаж/i.test(c.vacancy || '');
        if (c.stage === 'Новый' && isSalesVac && c.verdict !== 'Отказ' && !c.id?.startsWith('hh_')) {
          backlog.push({ id: c.id, name: c.name, contact: c.contact, phone: c.phone, vacancy: c.vacancy, source: c.source, verdict: c.verdict, score: c.score, ts: c.ts, channel });
        }
        const isOldOfficeSalesVac = c.vacancy === 'Менеджер по продажам'; // без «удалённо» — старая офисная
        if (isOldOfficeSalesVac && c.verdict !== 'Отказ') {
          reactivation.total++;
          reactivation.byChannel[channel] = (reactivation.byChannel[channel] || 0) + 1;
          reactivation.byVerdict[c.verdict || '—'] = (reactivation.byVerdict[c.verdict || '—'] || 0) + 1;
          if (reactivation.sample.length < 15) reactivation.sample.push({ id: c.id, name: c.name, contact: c.contact, phone: c.phone, stage: c.stage, verdict: c.verdict, score: c.score, channel, ts: c.ts });
        }
      }
      res.status(200).json({ ok: true, total: items.length, byStage, byVacancy, byChannel, backlogCount: backlog.length, backlog: backlog.slice(0, 100), reactivation });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Воронка по hh.kz (2026-08-17, по запросу Sagi): сколько всего откликов пришло на активную
  // вакансию, скольким отправили первое сообщение (SEEN_KEY), сколько из них ответили (REPLIED_KEY),
  // сколько получили приглашение на стажировку и всё ещё под наблюдением (INVITE_WATCH_KEY).
  // negTotal тянем прямо из hh.ru API по каждой активной вакансии — это реальное число откликов
  // на hh.kz, а не то, что у нас уже долетело и сохранилось в hr:candidates.
  if (req.query?.hhFunnelStats) {
    try {
      const [seenIds, repliedIds, watchIds] = await Promise.all([
        redis(['SMEMBERS', SEEN_KEY]),
        redis(['SMEMBERS', REPLIED_KEY]),
        redis(['SMEMBERS', INVITE_WATCH_KEY]),
      ]);
      const seenArr = Array.isArray(seenIds) ? seenIds : [];
      const repliedArr = Array.isArray(repliedIds) ? repliedIds : [];
      const watchArr = Array.isArray(watchIds) ? watchIds : [];
      const repliedSet = new Set(repliedArr);
      const awaitingArr = seenArr.filter(id => !repliedSet.has(id));
      const token = await getEmployerToken();
      const employerId = process.env.HH_EMPLOYER_ID || '';
      const vacRes = await hhGet(`/employers/${employerId}/vacancies/active?per_page=50`, token);
      const vacancies = vacRes.ok ? (vacRes.data.items || []) : [];
      const perVacancy = [];
      let totalResponses = 0;
      let allHhIds = [];
      for (const v of vacancies) {
        // per_page=100 хватает с запасом на текущий масштаб (десятки откликов на вакансию) —
        // и заодно даёт список id, а не только счётчик, чтобы кликом по карточке «Откликов на
        // hh.kz» можно было увидеть КОНКРЕТНО кого, включая совсем свежих, ещё не обработанных.
        const neg = await hhGet(`/negotiations/response?vacancy_id=${v.id}&per_page=100`, token);
        const negTotal = neg.ok ? (neg.data.found ?? null) : null;
        if (typeof negTotal === 'number') totalResponses += negTotal;
        const ids = neg.ok ? (neg.data.items || []).map(it => it.id).filter(Boolean) : [];
        allHhIds = allHhIds.concat(ids);
        perVacancy.push({ vacancyId: v.id, vacancyName: v.name, negTotal, error: neg.ok ? null : { status: neg.status } });
      }
      res.status(200).json({
        ok: true,
        totalResponsesOnHh: totalResponses,
        perVacancy,
        firstMessageSent: seenArr.length,
        repliedToUs: repliedArr.length,
        awaitingReply: awaitingArr.length,
        invitedToInternshipStillWatching: watchArr.length,
        // Списки negId по каждой цифре — фронт сам сматчит их с уже загруженным hr:candidates
        // (id кандидата = 'hh_' + negId) и покажет конкретных людей по клику на цифру.
        negIds: {
          totalResponsesOnHh: allHhIds,
          firstMessageSent: seenArr,
          repliedToUs: repliedArr,
          awaitingReply: awaitingArr,
          invitedToInternshipStillWatching: watchArr,
        },
      });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Разовая миграция (2026-08-17): исправляем ярлык вакансии у уже сохранённых hh.kz-записей,
  // которым при интейке подставилась заглушка «Менеджер по продажам» вместо реального названия
  // (баг, см. ?vacList=1 — hh.kz не всегда возвращает vacancy.name в самой негоциации). Сейчас
  // активна ровно одна вакансия, «Менеджер по продажам (B2B клиенты)», по факту удалённая (без
  // офисных маркеров в названии) — переводим на каноничное «Менеджер по продажам, удалённо»,
  // как у остальных каналов. Трогает только hh_-записи с ТОЧНО заглушечным названием, ничего
  // кандидату не пишет, только правит внутреннюю метку. Безопасно дёргать повторно.
  if (req.query?.fixVacancyLabels) {
    try {
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      let fixed = 0;
      const names = [];
      for (const s of raw) {
        let c; try { c = JSON.parse(s); } catch (e) { continue; }
        if (c.id?.startsWith('hh_') && c.vacancy === 'Менеджер по продажам') {
          if (!dryRun) {
            await updateCandidateRecord(c.id, { vacancy: 'Менеджер по продажам, удалённо', source: (c.source || '').replace('Менеджер по продажам', 'Менеджер по продажам, удалённо') });
          }
          fixed++;
          if (names.length < 20) names.push(c.name);
        }
      }
      res.status(200).json({ ok: true, dryRun, fixed, names });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Разовая миграция (2026-08-17, по прямому указанию Sagi): вакансия «Менеджер техподдержки
  // (удалённо, вечер)» закрыта, автоматики (стажировка/наставник) под неё нет и не будет.
  // Закрываем всех кандидатов, зависших на стадии «Новый» по этой вакансии, переводом в «Отказ» —
  // без отдельного уведомления кандидату (переписки без chat_id, написать всё равно нечем).
  if (req.query?.closeTechSupportBacklog) {
    try {
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const items = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      let closed = 0;
      const names = [];
      for (const c of items) {
        const isTechSupportRemote = !c.vacancy && /техподдержки/i.test(c.source || '');
        if (isTechSupportRemote && c.stage === 'Новый') {
          if (!dryRun) {
            await updateCandidateRecord(c.id, { stage: 'Отказ' });
          }
          closed++;
          if (names.length < 25) names.push({ id: c.id, name: c.name });
        }
      }
      res.status(200).json({ ok: true, dryRun, closed, names });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Разовая миграция (2026-08-17): косметический дубль ярлыка вакансии — «Менеджер по
  // продажам — удалённо» (с длинным тире, попал в канал через Telegram-бота до унификации
  // текстов) переводим в канонiчное «Менеджер по продажам, удалённо», чтобы в аналитике/пайплайне
  // не было двух разных строк для одной и той же вакансии. Правит vacancy и, если есть,
  // упоминание в source. Не трогает ничего кандидато-обращённого, только внутренний ярлык.
  if (req.query?.fixEmDashVacancy) {
    try {
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      let fixed = 0;
      const names = [];
      const OLD = 'Менеджер по продажам — удалённо';
      const NEW = 'Менеджер по продажам, удалённо';
      for (const s of raw) {
        let c; try { c = JSON.parse(s); } catch (e) { continue; }
        if (c.vacancy === OLD) {
          if (!dryRun) {
            await updateCandidateRecord(c.id, { vacancy: NEW, source: (c.source || '').split(OLD).join(NEW) });
          }
          fixed++;
          if (names.length < 20) names.push({ id: c.id, name: c.name });
        }
      }
      res.status(200).json({ ok: true, dryRun, fixed, names });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Диагностика (2026-08-17): кто эти 85 записей без указанной вакансии (vacancy пусто/undefined)?
  // Нужно понять источник и стадию, прежде чем решать, что с ними делать.
  if (req.query?.investigateNoVacancy) {
    try {
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const items = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const noVac = items.filter(c => !c.vacancy);
      const byStage = {}, bySourcePrefix = {};
      for (const c of noVac) {
        byStage[c.stage || '—'] = (byStage[c.stage || '—'] || 0) + 1;
        const pfx = (c.source || '—').split(' · ')[0] || (c.source || '—').slice(0, 30);
        bySourcePrefix[pfx] = (bySourcePrefix[pfx] || 0) + 1;
      }
      res.status(200).json({
        ok: true,
        total: noVac.length,
        byStage,
        bySourcePrefix,
        sample: noVac.slice(0, 25).map(c => ({ id: c.id, name: c.name, stage: c.stage, source: c.source, verdict: c.verdict, ts: c.ts })),
      });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Разовая миграция (2026-08-17): «догоняем» кандидатов, застрявших на стадии «Новый» без
  // приглашения — они пришли ДО того, как унифицировали авто-приглашение на всех каналах.
  // Если есть tgChatId — сразу шлём приглашение через careers-бота и переводим на «Стажировка»,
  // как для всех новых. Если канала нет (contact-only) — просто помечаем в ответе, чтобы Sagi
  // мог написать вручную (номер телефона уже есть в записи).
  if (req.query?.catchUpBacklog) {
    try {
      const BOT = process.env.CAREERS_BOT_TOKEN || '';
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const items = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const invited = [], noChannel = [];
      for (const c of items) {
        const isSalesVac = /продаж/i.test(c.vacancy || '');
        if (c.stage !== 'Новый' || !isSalesVac || c.verdict === 'Отказ' || c.id?.startsWith('hh_')) continue;
        if (c.tgChatId && BOT) {
          const text = `${c.name && c.name !== 'Из Telegram' ? c.name + ', спасибо' : 'Спасибо'} за отклик! Приглашаем вас на стажировку, это первый шаг перед выходом на работу.\n\nЧто нужно сделать:\n1) Перейти на hr.sagibonus.com\n2) Нажать на карточку «🎓 Стажёр» и зарегистрироваться (займёт минуту)\n3) Пройти базовую программу (о продукте, скрипты, тесты, есть ИИ-тренажёр звонков)\n\nПодробные условия по доходу: hr.sagibonus.com/usloviya.html\n\nЕсли появятся вопросы, пишите сюда же или в WhatsApp: +7 707 700 0087.`;
          if (!dryRun) {
            try {
              await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: c.tgChatId, text }) });
            } catch (e) {}
            await updateCandidateRecord(c.id, { stage: 'Стажировка' });
          }
          invited.push({ id: c.id, name: c.name, contact: c.contact });
        } else {
          noChannel.push({ id: c.id, name: c.name, contact: c.contact, phone: c.phone, vacancy: c.vacancy, source: c.source });
        }
      }
      res.status(200).json({ ok: true, dryRun, invitedCount: invited.length, invited, noChannelCount: noChannel.length, noChannel });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Разовая миграция (2026-08-17, по прямому указанию Sagi): раньше ответившие кандидаты
  // попадали на стадию «Ответил» и ждали ручного решения. Теперь — сразу «Стажировка».
  // Этот маршрут переводит УЖЕ существующих кандидатов со стадией «Ответил» на «Стажировка»
  // одним махом (для тех, кто был обработан до смены логики). Безопасно дёргать повторно —
  // если таких не осталось, просто вернёт moved:0.
  if (req.query?.promoteReplied) {
    try {
      const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
      const items = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      let moved = 0;
      const movedNames = [];
      const inviteResults = [];
      let token = null;
      for (const it of items) {
        if (it.stage === 'Ответил') {
          it.stage = 'Стажировка'; moved++; movedNames.push(it.name);
          // Этим кандидатам раньше (до смены логики) ничего не отправляли, кроме внутренней
          // пометки — теперь реально приглашаем их в чат на hh.kz и ставим на наблюдение вопросов.
          if (String(it.id || '').startsWith('hh_')) {
            const negId = it.id.slice(3);
            try {
              if (!token) token = await getEmployerToken();
              const sent = await hhPostForm('/negotiations/' + negId + '/messages', token, { message: buildInviteMessage(it.name, negId) });
              inviteResults.push({ negId, name: it.name, ok: sent.ok });
              if (sent.ok) {
                await redis(['SADD', INVITE_WATCH_KEY, negId]);
                await redis(['SET', 'hh:invite_ts:' + negId, String(Date.now())]);
              }
            } catch (e) {
              inviteResults.push({ negId, name: it.name, ok: false, error: e.message });
            }
          }
        }
      }
      if (moved > 0) {
        await redis(['DEL', CAND_KEY]);
        for (const it of items.slice().reverse()) await redis(['LPUSH', CAND_KEY, JSON.stringify(it)]);
      }
      res.status(200).json({ ok: true, moved, movedNames, inviteResults });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Изолированный тестовый маршрут: пробует отправить сообщение ОДНОЙ негоциации разными
  // способами (JSON / form-urlencoded), НЕ трогая SEEN_KEY/пайплайн — только для диагностики
  // формата запроса к hh.ru, чтобы не спамить реальных кандидатов, пока не найдём рабочий формат.
  if (req.query?.testSend) {
    const negId = String(req.query.testSend);
    const testText = 'Тест доставки сообщения от Sagi HR-бота, можно игнорировать.';
    try {
      const token = await getEmployerToken();
      const asJson = await hhPost('/negotiations/' + negId + '/messages', token, { message: testText });
      if (asJson.ok) { res.status(200).json({ ok: true, method: 'json', result: asJson.data }); return; }
      const asForm = await hhPostForm('/negotiations/' + negId + '/messages', token, { message: testText });
      res.status(200).json({ ok: asForm.ok, jsonAttempt: { status: asJson.status, data: asJson.data }, formAttempt: { status: asForm.status, data: asForm.data } });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  // Маршрут для добора: 10 кандидатов уже помечены "обработано", но реальная отправка сообщения
  // упала (был баг с JSON вместо form-urlencoded) — досылаем им настоящий вопрос-текст.
  if (req.query?.resendPending) {
    const rpLimit = Math.min(parseInt(req.query.resendPending, 10) || 10, 25);
    try {
      const token = await getEmployerToken();
      const raw = (await redis(['LRANGE', CAND_KEY, 0, -1])) || [];
      const pending = [];
      for (const r of raw) {
        try {
          const o = JSON.parse(r);
          if (o.id && o.id.startsWith('hh_') && o.stage === 'Ожидает ответа' && o.messageSent !== true) pending.push(o);
        } catch (e) {}
      }
      const toSend = pending.slice(0, rpLimit);
      const results = [];
      for (const rec of toSend) {
        const negId = rec.id.replace(/^hh_/, '');
        const vacKind = pickVacancyKind(rec.vacancy || '');
        const msgText = buildFirstMessage(vacKind, rec.name);
        const sent = await hhPostForm('/negotiations/' + negId + '/messages', token, { message: msgText });
        if (sent.ok) await updateCandidateRecord(rec.id, { messageSent: true });
        results.push({ negId, name: rec.name, ok: sent.ok, status: sent.status, data: sent.ok ? undefined : sent.data });
      }
      res.status(200).json({ ok: true, pendingTotal: pending.length, sent: toSend.length, results });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  const limitParam = parseInt(req.query?.limit, 10);
  const MAX_NEW_PER_RUN = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 25) : 5;
  const limitRepliesParam = parseInt(req.query?.limitReplies, 10);
  const MAX_REPLIES_PER_RUN = Number.isFinite(limitRepliesParam) && limitRepliesParam > 0 ? Math.min(limitRepliesParam, 25) : 5;
  const errors = [];
  try {
    const token = await getEmployerToken();

    const employerId = process.env.HH_EMPLOYER_ID || '';
    if (!employerId) { res.status(200).json({ ok: false, step: 'config', error: 'HH_EMPLOYER_ID не задан в env' }); return; }
    const vacRes = await hhGet(`/employers/${employerId}/vacancies/active?per_page=50`, token);
    if (!vacRes.ok) { res.status(200).json({ ok: false, step: 'vacancies', status: vacRes.status, data: vacRes.data }); return; }
    const vacancyIds = (vacRes.data.items || []).map(v => v.id).filter(Boolean);
    if (!vacancyIds.length) { res.status(200).json({ ok: true, total: 0, note: 'нет активных вакансий у employerId=' + employerId }); return; }
    // hh.kz часто НЕ возвращает vacancy.name внутри самой негоциации (обнаружено 2026-08-17,
    // видно через ?vacList=1) — держим карту id вакансии -> реальное название, полученную из
    // /vacancies/active, чтобы не подставлять заглушку «Менеджер по продажам» почти всем подряд.
    const vacNameById = new Map((vacRes.data.items || []).map(v => [String(v.id), v.name]));

    let items = [];
    const vacErrors = [];
    for (const vid of vacancyIds) {
      const neg = await hhGet(`/negotiations/response?vacancy_id=${vid}&per_page=50&order_by=created_at`, token);
      if (neg.ok && Array.isArray(neg.data.items)) items.push(...neg.data.items.map(it => ({ ...it, _vacId: vid })));
      else vacErrors.push({ vacancy_id: vid, status: neg.status, data: neg.data });
    }
    if (!items.length && vacErrors.length) { res.status(200).json({ ok: false, step: 'negotiations', vacancyIds, vacErrors }); return; }

    // ==== ФАЗА A: новые отклики — всем сразу отправляем первое сообщение ====
    const newItems = [];
    for (const it of items) {
      const negId = String(it.id || '');
      if (!negId) continue;
      const already = await redis(['SISMEMBER', SEEN_KEY, negId]);
      if (already === 1) continue;
      newItems.push(it);
    }
    const toProcess = newItems.slice(0, MAX_NEW_PER_RUN);
    const remainingNew = newItems.length - toProcess.length;

    let intakeProcessed = 0;
    const intakePreview = [];
    for (const it of toProcess) {
      const negId = String(it.id || '');
      if (!dryRun) await redis(['SADD', SEEN_KEY, negId]);
      intakeProcessed++;
      try {
        const realVacTitle = it.vacancy?.name || vacNameById.get(String(it._vacId)) || 'Менеджер по продажам';
        const vacKind = pickVacancyKind(realVacTitle);
        // Храним каноничное имя (то же, что использует Telegram-бот/apply.js/wa.js), а не сырое
        // hh.kz-название — чтобы фильтр по вакансии в пайплайне группировал их вместе.
        const vacTitle = vacKind === 'sales_remote' ? 'Менеджер по продажам, удалённо' : 'Менеджер по продажам';
        const resumeId = it.resume?.id;
        let resumeFull = null;
        if (resumeId) {
          const rr = await hhGet('/resumes/' + resumeId, token);
          if (rr.ok) resumeFull = rr.data;
        }
        const name = [resumeFull?.first_name || it.resume?.first_name, resumeFull?.last_name || it.resume?.last_name].filter(Boolean).join(' ') || 'Кандидат с hh.kz';
        const phone = extractPhone(resumeFull);
        const resumeText = buildResumeText(resumeFull) || (it.resume?.title || '');
        const msgText = buildFirstMessage(vacKind, name);
        if (dryRun) {
          intakePreview.push({ negId, name, vacancy: vacTitle, vacKind });
        } else {
          const sent = await hhPostForm('/negotiations/' + negId + '/messages', token, { message: msgText });
          if (!sent.ok) errors.push({ negId, step: 'send_first_message', status: sent.status, data: sent.data });
          const rec = {
            id: 'hh_' + negId, name,
            contact: phone || (resumeId ? 'hh.kz резюме ' + resumeId : ''), phone: (phone || '').replace(/\D/g, ''),
            vacancy: vacTitle, source: 'HH.kz отклик · ' + vacTitle,
            resume: resumeText.slice(0, 2000), score: null, verdict: null, summary: '',
            strengths: [], flags: [], stage: 'Ожидает ответа', ts: Date.now(), messageSent: sent.ok,
          };
          await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]);
          await redis(['LTRIM', CAND_KEY, 0, 1999]);
        }
      } catch (e) {
        errors.push({ negId, step: 'intake', error: e.message });
      }
    }

    // ==== ФАЗА B: проверяем, кто уже ответил на наши вопросы ====
    // ВАЖНО: раньше здесь брались всегда первые N элементов awaitingIds (slice(0, N)).
    // SDIFF возвращает элементы в фиксированном порядке, который не меняется, пока состав множества
    // не изменится — то есть каждый прогон проверял ОДНИХ И ТЕХ ЖЕ первых кандидатов, а остальные
    // (условно 6-й и далее) не проверялись вообще, пока кто-то из первых не ответит. Чтобы за несколько
    // прогонов проверить ВСЕХ ожидающих по кругу, используем «карусель» — курсор в Redis, который
    // сдвигается на количество проверенных каждый боевой (не dryRun) прогон.
    const awaitingIds = (await redis(['SDIFF', SEEN_KEY, REPLIED_KEY])) || [];
    const awaitingCount = awaitingIds.length;
    let reviewCursor = parseInt(await redis(['GET', REPLY_CURSOR_KEY]), 10);
    if (!Number.isFinite(reviewCursor) || reviewCursor < 0) reviewCursor = 0;
    const toCheck = [];
    if (awaitingCount > 0) {
      const n = Math.min(MAX_REPLIES_PER_RUN, awaitingCount);
      for (let i = 0; i < n; i++) toCheck.push(awaitingIds[(reviewCursor + i) % awaitingCount]);
    }
    const remainingAwaiting = awaitingCount - toCheck.length;

    // Кандидаты пайплайна загружаются один раз на весь прогон (не по одному внутри цикла) —
    // нужны и для оценки ответа, и для проверки «пора ли напомнить не ответившим».
    const candRawList = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
    const candById = new Map();
    for (const r of candRawList) { try { const o = JSON.parse(r); if (o.id) candById.set(o.id, o); } catch (e) {} }

    let repliesChecked = 0, repliesFound = 0, remindersSent = 0;
    const replyPreview = [];
    for (const negId of toCheck) {
      repliesChecked++;
      try {
        const msgsRes = await hhGet(`/negotiations/${negId}/messages`, token);
        if (!msgsRes.ok) {
          if (debug) errors.push({ negId, step: 'fetch_messages', status: msgsRes.status, data: msgsRes.data });
          continue;
        }
        const messages = msgsRes.data.items || msgsRes.data.messages || (Array.isArray(msgsRes.data) ? msgsRes.data : []);
        const { replyText, debug: replyDebug } = extractCandidateReply(messages);
        if (!replyText) {
          if (dryRun && debug) replyPreview.push({ negId, hasReply: false, debug: replyDebug, rawSample: JSON.stringify(messages).slice(0, 300) });
          // Напоминание: если с первого сообщения прошло больше REMIND_AFTER_MS и мы ещё не
          // напоминали — шлём один короткий пинг. Поднимает долю ответивших без спама.
          try {
            const rec = candById.get('hh_' + negId);
            const alreadyReminded = await redis(['SISMEMBER', REMINDED_KEY, negId]);
            if (rec && rec.ts && alreadyReminded !== 1 && (Date.now() - rec.ts) >= REMIND_AFTER_MS) {
              if (!dryRun) {
                const rem = await hhPostForm('/negotiations/' + negId + '/messages', token, { message: REMINDER_TEXT });
                await redis(['SADD', REMINDED_KEY, negId]);
                if (rem.ok) remindersSent++;
              } else {
                remindersSent++;
              }
            }
          } catch (e) {}
          continue; // ещё не ответил — оставляем в очереди на следующий запуск
        }
        repliesFound++;
        // Нужен vacKind для правильного промпта — берём из уже сохранённой записи, если есть.
        const existingRec = candById.get('hh_' + negId) || null;
        const vacKind = pickVacancyKind(existingRec?.vacancy || '');
        const name = existingRec?.name || 'Кандидат с hh.kz';
        const ev = await evaluateReply(vacKind, name, replyText);

        if (dryRun) {
          replyPreview.push({ negId, hasReply: true, name, replyText: replyText.slice(0, 300), recommend: ev.recommend, summary: ev.summary, evalDebug: ev._debug || '' });
        } else {
          await redis(['SADD', REPLIED_KEY, negId]);
          // По прямому указанию Sagi (2026-08-17): каждый ответивший сразу отправляется на
          // стажировку — не ждём отдельного ручного решения по каждому. Вердикт ИИ и текст
          // ответа сохраняются для контекста, но НЕ блокируют продвижение по воронке.
          const updated = await updateCandidateRecord('hh_' + negId, {
            stage: 'Стажировка', verdict: ev.recommend || 'Уточнить', summary: ev.summary || '',
            strengths: ev.strengths || [], flags: ev.flags || [], replyText: replyText.slice(0, 2000),
          });
          await notifyReplied(updated || { ...existingRec, verdict: ev.recommend, summary: ev.summary }, replyText);
          // Приглашение уходит В ТОТ ЖЕ чат — не спам, продолжение диалога. Дальше несколько
          // дней следим, не появится ли вопрос от кандидата (см. ФАЗА D ниже).
          await hhPostForm('/negotiations/' + negId + '/messages', token, { message: buildInviteMessage(name, negId) });
          await redis(['SADD', INVITE_WATCH_KEY, negId]);
          await redis(['SET', 'hh:invite_ts:' + negId, String(Date.now())]);
        }
      } catch (e) {
        errors.push({ negId, step: 'reply_check', error: e.message });
      }
    }
    if (!dryRun) {
      const nextCursor = awaitingCount > 0 ? (reviewCursor + toCheck.length) % awaitingCount : 0;
      await redis(['SET', REPLY_CURSOR_KEY, String(nextCursor)]);
    }

    // ==== ФАЗА D: следим за вопросами после приглашения на стажировку ====
    // Кандидат уже помечен REPLIED_KEY (фаза B его больше не трогает), но мог задать вопрос
    // В ОТВЕТ на приглашение. Смотрим последние MAX_WATCH_PER_RUN «под наблюдением», ищем
    // сообщения кандидата ПОСЛЕ времени приглашения (или после последнего уже обработанного
    // сообщения). По прямому указанию Sagi (2026-08-17, «старайся всё делать максимально
    // самостоятельно») — сначала пробуем ответить сами (типовые вопросы, см. answerHhFaq),
    // и остаёмся на наблюдении дальше. Только если вопрос не типовой — зовём Sagi и снимаем
    // с наблюдения (дальше уже ручная переписка). Не было вопросов и прошло WATCH_FOR_MS —
    // тоже снимаем (считаем, что вопросов не будет).
    let watchChecked = 0, questionsFound = 0, autoAnswered = 0;
    try {
      const watchIds = (await redis(['SMEMBERS', INVITE_WATCH_KEY])) || [];
      const toWatch = watchIds.slice(0, MAX_WATCH_PER_RUN);
      for (const negId of toWatch) {
        watchChecked++;
        try {
          const inviteTsRaw = await redis(['GET', 'hh:invite_ts:' + negId]);
          const inviteTs = parseInt(inviteTsRaw, 10) || 0;
          if (!inviteTs || (Date.now() - inviteTs) > WATCH_FOR_MS) {
            if (!dryRun) { await redis(['SREM', INVITE_WATCH_KEY, negId]); await redis(['DEL', 'hh:invite_ts:' + negId]); await redis(['DEL', 'hh:invite_lastmsg:' + negId]); }
            continue;
          }
          const lastSeenRaw = await redis(['GET', 'hh:invite_lastmsg:' + negId]);
          const sinceTs = Math.max(inviteTs, parseInt(lastSeenRaw, 10) || 0);
          const msgsRes = await hhGet(`/negotiations/${negId}/messages`, token);
          if (!msgsRes.ok) continue;
          const messages = msgsRes.data.items || msgsRes.data.messages || (Array.isArray(msgsRes.data) ? msgsRes.data : []);
          const withTime = (messages || []).map(m => ({ text: (m.text || m.message || '').trim(), author: m.author?.participant_type || m.author_type || '', ts: new Date(m.created_at || m.createdAt || 0).getTime() }));
          const question = withTime.filter(m => /applicant|candidate|seeker/i.test(m.author) && m.text && m.ts > sinceTs).sort((a, b) => a.ts - b.ts)[0];
          if (question) {
            questionsFound++;
            const faqAnswer = answerHhFaq(question.text);
            if (!dryRun) {
              if (faqAnswer) {
                await hhReply(negId, token, faqAnswer);
                await redis(['SET', 'hh:invite_lastmsg:' + negId, String(question.ts)]);
                autoAnswered++;
              } else {
                const rec = candById.get('hh_' + negId) || null;
                await notifyFollowUp(rec, question.text);
                await redis(['SREM', INVITE_WATCH_KEY, negId]);
                await redis(['DEL', 'hh:invite_ts:' + negId]);
                await redis(['DEL', 'hh:invite_lastmsg:' + negId]);
              }
            } else if (faqAnswer) {
              autoAnswered++;
            }
          }
        } catch (e) {
          errors.push({ negId, step: 'watch_followup', error: e.message });
        }
      }
    } catch (e) {}

    // ==== ФАЗА E: напоминания стажёрам о застрявшем обучении + распределение наставников ====
    // По прямому указанию Sagi (2026-08-17): «они должны обучение пройти, и мы должны подтянуть
    // уже на стажировку» — не просто пригласить, а довести до реального прохождения программы.
    // Работаем напрямую с той же базой пользователей (hr:user:*), что и личный кабинет.
    let traineesChecked = 0, remindersToTrainees = 0, mentorsAssigned = 0, noChannelCount = 0;
    try {
      const logins = (await redis(['SMEMBERS', 'hr:users'])) || [];
      const usersRaw = [];
      for (const login of logins) {
        const raw = await redis(['GET', 'hr:user:' + login]);
        if (!raw) continue;
        try { usersRaw.push({ login, u: JSON.parse(raw) }); } catch (e) {}
      }
      const trainees = usersRaw.filter(x => x.u.role === 'trainee');

      // Самолечение старых записей без привязки к переписке hh.kz — пробуем сопоставить по
      // нормализованному имени с уже приглашёнными на стажировку кандидатами (только если
      // совпадение однозначное, чтобы не ошибиться адресатом).
      const normName = s => (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
      const hhCandidatesByName = new Map(); // normName -> [negId,...]
      for (const [id, rec] of candById.entries()) {
        if (!id.startsWith('hh_') || rec.stage !== 'Стажировка') continue;
        const key = normName(rec.name);
        if (!key) continue;
        if (!hhCandidatesByName.has(key)) hhCandidatesByName.set(key, []);
        hhCandidatesByName.get(key).push(id.slice(3));
      }

      let actionsUsed = 0;
      for (const { login, u } of trainees) {
        if (actionsUsed >= MAX_TRAINEE_ACTIONS_PER_RUN) break;
        traineesChecked++;
        let changed = false;
        if (!u.hhNegId) {
          const matches = hhCandidatesByName.get(normName(u.name));
          if (matches && matches.length === 1) { u.hhNegId = matches[0]; changed = true; }
        }
        const doneCount = BASIC_MODULE_IDS.filter(id => u.progress && u.progress[id]).length;
        const isComplete = doneCount >= BASIC_MODULE_IDS.length;

        if (isComplete && !u.mentorName) {
          if (MENTORS.length > 0) {
            let cursor = parseInt(await redis(['GET', MENTOR_CURSOR_KEY]), 10);
            if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
            const mentor = MENTORS[cursor % MENTORS.length];
            if (!dryRun) await redis(['SET', MENTOR_CURSOR_KEY, String((cursor + 1) % MENTORS.length)]);
            u.mentorName = mentor.name; u.mentorPhone = mentor.phone; u.mentorAssignedAt = Date.now();
            changed = true;
            mentorsAssigned++; actionsUsed++;
            if (!dryRun) {
              if (u.hhNegId) await hhReply(u.hhNegId, token, buildMentorAssignedText(u.name, mentor.name, mentor.phone));
              else noChannelCount++;
              const traineeContact = (u.hhNegId && candById.get('hh_' + u.hhNegId)?.contact) || '—';
              const tok = process.env.TELEGRAM_BOT_TOKEN || '', chat = process.env.TELEGRAM_CHAT_ID || '';
              if (tok && chat) {
                const txt = `🎓 ${u.name} (@${login}) завершил(а) базовую программу обучения.\n👨‍🏫 Наставник: ${mentor.name} (${mentor.phone})\n📞 Контакт стажёра: ${traineeContact}\n\n${u.hhNegId ? 'Стажёру отправлено уведомление в переписку на hh.kz.' : 'Канала для авто-уведомления нет — напиши сам(а).'}`;
                try { await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: txt, disable_web_page_preview: true }) }); } catch (e) {}
              }
            }
          } else {
            noChannelCount++;
          }
        } else if (!isComplete) {
          const lastActivity = u.lastSeen || u.createdAt || 0;
          const stalled = lastActivity && (Date.now() - lastActivity) >= TRAINEE_STALL_MS;
          if (stalled) {
            const remindedRaw = await redis(['GET', 'hr:trainee_reminded:' + login]);
            const cooldownOk = !remindedRaw || (Date.now() - (parseInt(remindedRaw, 10) || 0)) >= TRAINEE_REMIND_COOLDOWN_MS;
            if (cooldownOk) {
              actionsUsed++;
              if (!dryRun) {
                if (u.hhNegId) { await hhReply(u.hhNegId, token, buildTraineeReminderText(u.name, doneCount, BASIC_MODULE_IDS.length)); remindersToTrainees++; }
                else noChannelCount++;
                await redis(['SET', 'hr:trainee_reminded:' + login, String(Date.now())]);
              } else {
                remindersToTrainees++;
              }
            }
          }
        }
        if (changed && !dryRun) await redis(['SET', 'hr:user:' + login, JSON.stringify(u)]);
      }
    } catch (e) {
      errors.push({ step: 'trainee_nudges', error: e.message });
    }

    res.status(200).json({
      ok: true, dryRun,
      intake: { totalResponses: items.length, newTotal: newItems.length, processed: intakeProcessed, remaining: remainingNew, preview: dryRun ? intakePreview : undefined },
      replies: { awaitingTotal: awaitingIds.length, checked: repliesChecked, remaining: remainingAwaiting, found: repliesFound, remindersSent, cursor: reviewCursor, preview: dryRun ? replyPreview : undefined },
      followUps: { checked: watchChecked, questionsFound, autoAnswered },
      trainees: { checked: traineesChecked, remindersSent: remindersToTrainees, mentorsAssigned, noChannel: noChannelCount },
      errors: debug ? errors : errors.length,
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message, errors: debug ? errors : errors.length });
  }
}
