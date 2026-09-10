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
  // 1. Сразу после заполнения анкеты.
  afterForm(name) {
    return hi(firstName(name)) + ' Спасибо, что заполнили анкету в Sagi, мы её получили и посмотрели. Приглашаем вас на обучение, это первый шаг.\n\n' +
      'Зарегистрируйтесь по ссылке hr.sagibonus.com/?start=1 и пройдите базовую программу, обычно это около часа. Там есть ИИ-тренажёр, чтобы сразу отработать звонки.\n\n' +
      'Почему стоит начать. У нас нет потолка по доходу, есть фикс, проценты с продаж и бонусы за KPI. География большая, есть зарубежные клиенты, часть дохода можно получать в долларах. Всему учим с нуля, первое время рядом наставник.\n\n' +
      'Если нужна помощь или что-то непонятно, просто напишите мне здесь, помогу с любым шагом.';
  },
  // 2. Зарегистрировался, но не начал программу.
  notStarted(name) {
    return hi(firstName(name)) + ' Вы зарегистрировались на обучение, но ещё не открыли программу. Давайте начнём сегодня, это займёт около часа и сильно повышает шансы дойти до стажировки. Ссылка hr.sagibonus.com/?start=1\n\n' +
      'Если удобнее в другое время, просто скажите, подстроимся. И если нужна помощь, я рядом.';
  },
  // 3. Начал, но не закончил (до дедлайна).
  notFinished(name, done, total) {
    const prog = (done != null && total) ? ' Сейчас пройдено ' + done + ' из ' + total + ' модулей.' : '';
    return hi(firstName(name)) + ' Заметил, что обучение пока не закончено.' + prog + ' Материалы короткие, обычно всё проходится за час.\n\n' +
      'Откройте hr.sagibonus.com/?start=1 и продолжите с того места, где остановились. Если что-то мешает или нужна помощь, напишите здесь, помогу.';
  },
  // 4. Вернуть тех, у кого истекло время на базовую программу.
  returnAfterDeadline(name) {
    return hi(firstName(name)) + ' Вижу, обучение осталось незаконченным, но это совсем не проблема, многие спокойно проходят со второй попытки. Давайте я верну доступ и помогу дойти до конца.\n\n' +
      'Условия у нас сильные. Есть фикс, проценты с продаж и бонусы за KPI, большая география и возможность зарабатывать в долларах. Напишите здесь, и продолжим.';
  },
  // 5. Холодная база (обзвон контактов, которые ещё не откликнулись).
  coldBase(name) {
    return hi(firstName(name)) + ' Это команда найма Sagi. Мы ищем менеджеров по продажам, работа с холодными звонками и клиентами, можно удалённо.\n\n' +
      'Коротко по условиям. Есть фикс, проценты с продаж и бонусы за KPI, потолка по доходу нет. География большая, часть клиентов зарубежные, можно зарабатывать в долларах. Всему учим с нуля, начинающим помогает наставник.\n\n' +
      'Если интересно, заполните короткую анкету, это пара минут, и я сразу напишу вам. Ссылка hr.sagibonus.com/apply.html\n\n' +
      'Если не актуально, ответьте «стоп», больше писать не буду.';
  },
};

// Отправка сообщения. transport возвращает, куда реально ушло (для логов/отладки).
export async function sendWA(to, text) {
  const digits = waDigits(to);
  if (!digits) return { ok: false, skipped: 'no_phone' };
  if (!text) return { ok: false, skipped: 'no_text' };

  if (GREY_URL) {
    try {
      const r = await fetch(GREY_URL + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wa-secret': GREY_SECRET },
        body: JSON.stringify({ to: digits, text }),
      });
      return { ok: r.ok, transport: 'grey', status: r.status };
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
