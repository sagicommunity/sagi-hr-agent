// Отправка WhatsApp кандидатам и стажёрам + согласованные тексты (Sagi, 2026-09-10).
//
// Два транспорта, выбираются по env (первый настроенный побеждает):
//   1) СЕРЫЙ (неофициальный, Baileys) — отдельный всегда-включённый воркер wa-worker/.
//      env: WA_GREY_URL (например http://127.0.0.1:8790), WA_GREY_SECRET.
//   2) Официальный Meta Cloud API — env: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID.
//
// Если ничего не настроено — sendWA тихо возвращает {ok:false, skipped:'not_configured'}
// и НИКОГДА не роняет вызывающий код. Так код можно деплоить заранее, а включится он
// в момент, когда появится номер.
//
// ВАЖНО про тексты: Sagi просил НЕ использовать двоеточия и длинные тире, чтобы сообщения
// не выглядели как написанные ИИ. Все тексты ниже этому соответствуют — не добавлять «:» и «—».

const GREY_URL = (process.env.WA_GREY_URL || '').replace(/\/+$/, '');
const GREY_SECRET = process.env.WA_GREY_SECRET || '';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';

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
};

// Отправка сообщения. Для серого транспорта НЕ шлёт сразу, а ставит в очередь воркера
// (он выдерживает темп один раз в 2 минуты, чтобы номер не улетел в бан). Для официального
// Cloud API шлёт сразу.
export async function sendWA(to, text) {
  const digits = waDigits(to);
  if (!digits) return { ok: false, skipped: 'no_phone' };
  if (!text) return { ok: false, skipped: 'no_text' };

  if (GREY_URL) {
    try {
      const r = await fetch(GREY_URL + '/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wa-secret': GREY_SECRET },
        body: JSON.stringify({ to: digits, text }),
      });
      return { ok: r.ok, transport: 'grey-queue', status: r.status };
    } catch (e) {
      return { ok: false, transport: 'grey', error: e.message };
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
  return !!(GREY_URL || (WA_TOKEN && WA_PHONE_ID));
}

// Батч-постановка в очередь серого воркера одним HTTP-запросом (для рассылок/догона —
// чтобы не делать сотни отдельных вызовов). Для Cloud API просто шлёт по одному.
export async function enqueueWA(items) {
  const clean = (items || [])
    .map((it) => ({ to: waDigits(it && it.to), text: it && it.text }))
    .filter((x) => x.to && x.text);
  if (!clean.length) return { ok: true, queued: 0 };
  if (GREY_URL) {
    try {
      const r = await fetch(GREY_URL + '/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wa-secret': GREY_SECRET },
        body: JSON.stringify({ items: clean }),
      });
      return { ok: r.ok, queued: clean.length, status: r.status };
    } catch (e) {
      return { ok: false, queued: 0, error: e.message };
    }
  }
  if (WA_TOKEN && WA_PHONE_ID) {
    let n = 0;
    for (const it of clean) { const r = await sendWA(it.to, it.text); if (r.ok) n++; }
    return { ok: true, queued: n, transport: 'cloud' };
  }
  return { ok: false, queued: 0, skipped: 'not_configured' };
}
