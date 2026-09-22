// Отправка WhatsApp кандидатам и стажёрам + согласованные тексты (Sagi, 2026-09-10).
//
// Два транспорта, выбираются по env (первый настроенный побеждает):
//   1) СЕРЫЙ (неофициальный, Baileys) — отдельный всегда-включённый воркер(ы) wa-worker/.
//      env: WA_GREY_URL (номер 1), WA_GREY_URL_2, WA_GREY_URL_3 (резервные номера, опционально),
//      один общий WA_GREY_SECRET на все.
//   2) Официальный Meta Cloud API — env: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID.
//
// Если ничего не настроено — sendWA тихо возвращает {ok:false, skipped:'not_configured'}
// и НИКОГДА не роняет вызывающий код. Так код можно деплоить заранее, а включится он
// в момент, когда появится номер.
//
// ── Несколько номеров в резерве (Sagi, 2026-09-22) ──────────────────────────────────────
// Раньше был ровно один номер (WA_GREY_URL) — если WhatsApp его блокировал/отвязывал,
// рассылка вставала совсем, пока кто-то не переподключит вручную. Теперь можно завести до
// нескольких резервных номеров (WA_GREY_URL_2, _3, …, каждый — свой воркер в кластере со своей
// SIM-картой), и здесь мы САМИ выбираем, через какой слать:
//   - для уже переписывающегося контакта стараемся использовать тот же номер, что и раньше
//     (иначе кандидат увидит два разных чата от «нас» — это и есть «прилипание» к номеру,
//     карта телефон->номер лежит в Redis, ключ hr:wa:route);
//   - если этот номер сейчас отключён — берём первый ПОДКЛЮЧЁННЫЙ по порядку (1, 2, 3…) и
//     запоминаем его как новый «домашний» для этого контакта;
//   - если все номера сейчас лежат — используем первый (как и раньше без резерва): встанет
//     в очередь и уйдёт, как только хоть один поднимется.
// Это работает прозрачно для sendWA/enqueueWA — вызывающему коду (hh_poll.js, pipeline.js)
// ничего менять не нужно, номер выбирается внутри.
//
// ВАЖНО про тексты: Sagi просил НЕ использовать двоеточия и длинные тире, чтобы сообщения
// не выглядели как написанные ИИ. Все тексты ниже этому соответствуют — не добавлять «:» и «—».

const GREY_SECRET = process.env.WA_GREY_SECRET || '';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';

// До 5 номеров с запасом на будущее — сейчас в проде обычно 1-3 (WA_GREY_URL, _2, _3).
function getAccounts() {
  const list = [];
  for (let i = 1; i <= 5; i++) {
    const key = i === 1 ? 'WA_GREY_URL' : ('WA_GREY_URL_' + i);
    const url = (process.env[key] || '').replace(/\/+$/, '');
    if (url) list.push({ id: String(i), url });
  }
  return list;
}
const ACCOUNTS = getAccounts();

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
    if (!r.ok) return null;
    return (await r.json()).result;
  } catch (e) { return null; }
}
const ROUTE_KEY = 'hr:wa:route'; // Redis-хеш: телефон -> id номера, за которым он «закреплён»

export async function waAccountStatus(acc) {
  try {
    const r = await fetch(acc.url + '/status', { headers: { 'x-wa-secret': GREY_SECRET } });
    if (!r.ok) return { id: acc.id, configured: true, connected: false, httpError: r.status };
    const d = await r.json();
    return { id: acc.id, configured: true, ...d };
  } catch (e) { return { id: acc.id, configured: true, connected: false, error: e.message }; }
}
export async function waStatusAll() {
  return Promise.all(ACCOUNTS.map(waAccountStatus));
}

// Кэш «кто сейчас подключён» на несколько секунд — чтобы при пачке из сотен сообщений (рассылка,
// followup) не дёргать /status у каждого воркера на каждое сообщение отдельно.
let connCache = { at: 0, map: {} };
async function connectedMap() {
  if (Date.now() - connCache.at < 15000) return connCache.map;
  const map = {};
  await Promise.all(ACCOUNTS.map(async (a) => { map[a.id] = !!(await waAccountStatus(a)).connected; }));
  connCache = { at: Date.now(), map };
  return map;
}
function firstConnected(map) {
  for (const a of ACCOUNTS) if (map[a.id]) return a;
  return ACCOUNTS[0] || null; // все лежат — используем первый, встанет в очередь до восстановления
}
async function accountFor(phone) {
  if (!ACCOUNTS.length) return null;
  if (ACCOUNTS.length === 1) return ACCOUNTS[0];
  const map = await connectedMap();
  const sticky = phone ? await redis(['HGET', ROUTE_KEY, phone]) : null;
  if (sticky && map[sticky]) return ACCOUNTS.find((a) => a.id === sticky) || firstConnected(map);
  const chosen = firstConnected(map);
  if (chosen && phone) redis(['HSET', ROUTE_KEY, phone, chosen.id]); // не ждём ответа, не критично
  return chosen;
}

// Нормализуем номер в международный формат без плюса (для wa.me и Cloud API): 8XXXXXXXXXX -> 7XXXXXXXXXX,
// 10 цифр -> добавляем 7. Возвращает '' если номер не похож на телефон.
export function waDigits(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  else if (d.length === 10) d = '7' + d;
  return d.length >= 11 && d.length <= 15 ? d : '';
}

// Пытаемся вытащить телефон из свободного поля контакта (там бывает «+7 ...», Telegram и т.п.).
export function extractPhone(...sources) {
  for (const s of sources) {
    const m = String(s || '').match(/(\+?7|8)?[\s\-(]*\d{3}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/);
    if (m) { const d = waDigits(m[0]); if (d) return d; }
  }
  return '';
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// ── Согласованные тексты (Sagi подтвердил 2026-09-10) ──
function hi(n) { return 'Здравствуйте' + (n ? ', ' + n : '') + '!'; }

export const HR_WA = {
  // 1. Сразу после заполнения анкеты. Заканчивается вопросом — чтобы человек ответил,
  // это и полезно, и снижает риск, что сообщение примут за рассылку.
  afterForm(name) {
    return hi(firstName(name)) + ' Спасибо, что заполнили анкету в Sagi, мы её получили и посмотрели. Хотим пригласить вас на обучение, это первый шаг.\n\n' +
      'Удобно ли вам начать сегодня? Регистрация здесь hr.sagibonus.com/?start=1, базовая программа обычно занимает около часа, есть ИИ-тренажёр для звонков. По доходу нет потолка, есть фикс, проценты с продаж и бонусы за KPI, география большая, часть дохода можно получать в долларах.\n\n' +
      'Напишите, пожалуйста, получилось ли открыть обучение, и если что-то непонятно, я помогу.';
  },
  // 2. Зарегистрировался, но не начал программу.
  notStarted(name) {
    return hi(firstName(name)) + ' Вы зарегистрировались на обучение, но программу пока не открыли. Подскажите, удобно ли начать сегодня?\n\n' +
      'Обычно хватает около часа, и это сильно повышает шансы дойти до стажировки. Ссылка hr.sagibonus.com/?start=1. Напишите, если нужна помощь, помогу с первым шагом.';
  },
  // 3. Начал, но не закончил (до дедлайна).
  notFinished(name, done, total) {
    const prog = (done != null && total) ? ' Сейчас пройдено ' + done + ' из ' + total + ' модулей.' : '';
    return hi(firstName(name)) + ' Заметил, что обучение пока не закончено.' + prog + ' Скажите, что помешало, не хватило времени или что-то непонятно?\n\n' +
      'Могу подсказать по любому модулю, и вместе дойдём до конца. Продолжить можно здесь hr.sagibonus.com/?start=1';
  },
  // 4. Вернуть тех, у кого истекло время на базовую программу.
  returnAfterDeadline(name) {
    return hi(firstName(name)) + ' Обучение осталось незаконченным, но это совсем не проблема, многие спокойно проходят со второй попытки. Хотите, открою доступ снова и помогу дойти до конца?\n\n' +
      'Напишите просто «да», и продолжим. Условия сильные, фикс, проценты с продаж и бонусы за KPI, большая география и возможность зарабатывать в долларах.';
  },
  // 5. Холодная база (контакты, которые ещё не откликнулись).
  coldBase(name) {
    return hi(firstName(name)) + ' Пишу из команды найма Sagi. Мы ищем менеджеров по продажам, работа с холодными звонками и клиентами, можно удалённо.\n\n' +
      'Условия сильные, есть фикс, проценты с продаж и бонусы за KPI, потолка по доходу нет. География большая, часть клиентов зарубежные, можно зарабатывать в долларах. Всему учим с нуля, начинающим помогает наставник.\n\n' +
      'Скажите, интересно ли вам обсудить? Если да, заполните короткую анкету здесь hr.sagibonus.com/apply.html, это пара минут, и я сразу напишу вам. Если не актуально, ответьте «стоп».';
  },
  // 6. Повторный догон (Sagi, 2026-09-15) — если первое напоминание (afterForm/coldBase/notStarted)
  // осталось без ответа и без прогресса ещё через несколько дней. Мягче по тону, короче, без
  // повтора всех деталей вакансии (их уже отправляли).
  nudgeAgain(name) {
    return hi(firstName(name)) + ' Писал вам на днях про обучение в Sagi, пока не увидел ответа. Актуально ли ещё?\n\n' +
      'Если да, ссылка та же hr.sagibonus.com/?start=1, помогу с любым шагом. Если пока не подходит, дайте знать, чтобы не писать зря.';
  },
  // 7. Финальный догон (последний, после чего человек больше не тревожится по этой цепочке).
  nudgeFinal(name) {
    return hi(firstName(name)) + ' Пишу в последний раз по поводу обучения в Sagi, не хочу навязываться.\n\n' +
      'Если сейчас не время, ничего страшного, вакансия открыта, вернуться можно в любой момент по той же ссылке hr.sagibonus.com/?start=1. Если больше не актуально, просто не отвечайте, писать больше не буду.';
  },
  // 8. Реактивация старой базы (Sagi, 2026-09-15) — кандидаты, которым раньше отказали или кто
  // не подошёл на тот момент, но вакансия открыта постоянно, а обстоятельства у людей меняются.
  reactivateOld(name) {
    return hi(firstName(name)) + ' Пишу из команды найма Sagi, вы откликались у нас раньше на менеджера по продажам.\n\n' +
      'Вакансия у нас открыта постоянно, набор идёт непрерывно, поэтому решил уточнить, актуально ли сейчас. Условия те же, фикс, проценты с продаж и бонусы за KPI, можно удалённо. Если интересно, напишите «да» и я подскажу дальнейшие шаги, если нет, извините за беспокойство и ответьте «стоп».';
  },
};

// Отправка сообщения. Для серого транспорта НЕ шлёт сразу, а ставит в очередь воркера
// (он выдерживает темп один раз в 2 минуты, чтобы номер не улетел в бан). Для официального
// Cloud API шлёт сразу.
export async function sendWA(to, text) {
  const digits = waDigits(to);
  if (!digits) return { ok: false, skipped: 'no_phone' };
  if (!text) return { ok: false, skipped: 'no_text' };

  if (ACCOUNTS.length) {
    const acc = await accountFor(digits);
    if (!acc) return { ok: false, skipped: 'not_configured' };
    try {
      const r = await fetch(acc.url + '/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wa-secret': GREY_SECRET },
        body: JSON.stringify({ to: digits, text }),
      });
      return { ok: r.ok, transport: 'grey-queue', account: acc.id, status: r.status };
    } catch (e) {
      return { ok: false, transport: 'grey', account: acc.id, error: e.message };
    }
  }

  if (WA_TOKEN && WA_PHONE_ID) {
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + WA_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: text, preview_url: false } }),
      });
      return { ok: r.ok, transport: 'cloud', status: r.status };
    } catch (e) {
      return { ok: false, transport: 'cloud', error: e.message };
    }
  }

  return { ok: false, skipped: 'not_configured' };
}

export function waConfigured() {
  return !!(ACCOUNTS.length || (WA_TOKEN && WA_PHONE_ID));
}

// Батч-постановка в очередь серого воркера одним HTTP-запросом (для рассылок/догона —
// чтобы не делать сотни отдельных вызовов). Группируем по выбранному для каждого контакта
// номеру (обычно все уйдут через один и тот же активный номер, но контакты, «прилипшие» к
// другому ещё живому номеру, уйдут через него). Для Cloud API просто шлёт по одному.
export async function enqueueWA(items) {
  const clean = (items || [])
    .map((it) => ({ to: waDigits(it && it.to), text: it && it.text }))
    .filter((x) => x.to && x.text);
  if (!clean.length) return { ok: true, queued: 0 };

  if (ACCOUNTS.length) {
    const byAccount = new Map();
    for (const it of clean) {
      const acc = await accountFor(it.to);
      if (!acc) continue;
      if (!byAccount.has(acc.id)) byAccount.set(acc.id, { acc, items: [] });
      byAccount.get(acc.id).items.push(it);
    }
    let queued = 0;
    const byAccountResult = [];
    for (const { acc, items: its } of byAccount.values()) {
      try {
        const r = await fetch(acc.url + '/enqueue', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-wa-secret': GREY_SECRET },
          body: JSON.stringify({ items: its }),
        });
        if (r.ok) queued += its.length;
        byAccountResult.push({ account: acc.id, count: its.length, status: r.status });
      } catch (e) {
        byAccountResult.push({ account: acc.id, count: its.length, error: e.message });
      }
    }
    return { ok: queued > 0, queued, byAccount: byAccountResult };
  }

  if (WA_TOKEN && WA_PHONE_ID) {
    let n = 0;
    for (const it of clean) { const r = await sendWA(it.to, it.text); if (r.ok) n++; }
    return { ok: true, queued: n, transport: 'cloud' };
  }
  return { ok: false, queued: 0, skipped: 'not_configured' };
}
