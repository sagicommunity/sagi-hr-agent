// Vercel Serverless Function — чек-лист адаптации новичка (сейлз/успех/поддержка).
// 2026-08-24, по указанию Sagi: у сейлзов есть аккаунт на hr.sagibonus.com (api/users.js,
// регистрация + 10 модулей обучения), но success- и support-кандидатов туда НЕ зовут —
// в их приглашениях (inviteTextSuccess/inviteTextSupport, api/apply.js) нет ни слова про
// hr.sagibonus.com/регистрацию, только «свяжемся в WhatsApp» (см. комментарий в apply.js:
// «hr.sagibonus.com для техподдержки НЕТ»). Значит общего логина на все три роли нет и
// пристёгивать чек-лист к api/users.js нельзя — часть новичков туда никогда не попадёт.
// Поэтому чек-лист — отдельная сущность без логина/пароля, привязанная к случайному id в
// ссылке (как reset-ссылка): человек открывает onboarding.html, вводит имя и роль один раз,
// получает свою персональную ссылку (?id=...) и дальше просто открывает её и отмечает пункты.
// POST { action, ... }. Данные — Redis HASH hr:onboarding (field=id, value=JSON записи).
// actions:
//   get   { id }                                   -> { ok, item }  (item=null, если не начат)
//   save  { id, name, role, checked }               -> { ok, item }  (создаёт при первом save)
//   list  { password }  (password = DASHBOARD_PASSWORD) -> { ok, items:[...] } — для Sagi

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HKEY = 'hr:onboarding';

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

// Канонический список пунктов чек-листа — ТОЧНО в формулировках, утверждённых Sagi
// (см. задачу от 2026-08-24). Ничего не добавлять и не убирать без нового указания.
// common — применяется ко всем трём ролям, остальные группы — только к своей роли.
const ITEMS = {
  common: [
    ['common1', 'Личный кабинет в Sagi Business / Sagi Bonus'],
    ['common2', 'Документ с условиями оплаты и KPI (usloviya.html)'],
    ['common3', 'WhatsApp Business настроен и готов к работе'],
    ['common5', 'Доступ к внутреннему чату техподдержки (по своим вопросам, не клиентским)'],
  ],
  sales: [
    ['sales1', 'Доступ к тестовому аккаунту Sagi'],
    ['sales2', 'База знаний по функционалу платформы'],
    ['sales3', 'Обучающие видео-материалы'],
    ['sales4', 'Список целевых клиентов для холодных звонков'],
    ['sales5', 'Скрипты звонков и работы с возражениями'],
    ['sales6', 'Доступ и обучение по видеовстречам с клиентами (как назначать и проводить демо — Zoom / Google Meet)'],
    ['sales7', 'СИП-телефония — доступ и настройка для исходящих звонков'],
    ['sales8', 'Список текущих клиентов по городам'],
    ['sales9', 'Доступ к Битрикс24 / CRM'],
    ['sales10', 'Инструкция по рассылкам и звонкам через 2ГИС + готовые тексты для WhatsApp-рассылок'],
    ['sales11', 'Ссылка на приложение / сайт Sagi для показа клиенту'],
  ],
  success: [
    ['success1', 'Доступ к Битрикс24 / CRM с базой текущих клиентов'],
    ['success2', 'Список текущих клиентов со сроками продления (1 / 3 / 6 / 12 мес)'],
    ['success3', 'Материалы по продлению и допродаже (как показать клиенту неиспользуемые функции)'],
    ['success4', 'Доступ и обучение по ИИ-инструментам компании (черновики сообщений, сводки перед звонком)'],
    ['success5', 'WhatsApp Business настроен'],
    ['success6', 'Ссылка на приложение / сайт Sagi для показа клиенту'],
  ],
  support: [
    ['support1', 'Доступ к тестовому аккаунту Sagi'],
    ['support2', 'База знаний по функционалу платформы + FAQ'],
    ['support3', 'Обучающие видео-материалы'],
    ['support4', 'Доступ к Битрикс24 / CRM с обращениями клиентов'],
    ['support5', 'Инструкция по типовым техническим проблемам (вход в аккаунт, начисление/списание бонусов и т.п.)'],
    ['support6', 'Инструкция по проведению интеграций клиентам (в т.ч. кассовые системы: iiko, r-keeper, 1С, МойСклад)'],
    ['support7', 'Доступ и обучение по ИИ-инструментам (диагностика, черновики ответов клиентам)'],
    ['support8', 'Ссылка на приложение / сайт Sagi для тестирования'],
  ],
};
const ROLES = ['sales', 'success', 'support'];
const ROLE_LABEL = { sales: 'Менеджер по продажам', success: 'Работа с текущими клиентами', support: 'Техподдержка' };

function itemsForRole(role) {
  return ITEMS.common.concat(ITEMS[role] || []);
}

// Уведомление в Telegram (2026-08-24, по указанию Sagi: «как с откликами», но НЕ по каждой
// галочке — иначе спам). Шлём только на два перехода: чек-лист начат (первый save по этому id)
// и чек-лист закрыт на 100% (впервые). Флаги notifiedStarted/notifiedDone в самой записи не
// дают продублировать уведомление при повторных save (галочку сняли/поставили обратно и т.п.).
async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (e) {}
}

function computeProgress(role, checked) {
  const items = itemsForRole(role);
  const total = items.length;
  let done = 0;
  for (const [key] of items) if (checked && checked[key] === true) done++;
  return { done, total };
}

function withProgress(rec) {
  if (!rec) return rec;
  const { done, total } = computeProgress(rec.role, rec.checked);
  return { ...rec, done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

async function loadRecord(id) {
  const raw = await redis(['HGET', HKEY, id]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function loadAll() {
  const flat = await redis(['HGETALL', HKEY]); // [field, value, field, value, ...]
  if (!Array.isArray(flat)) return [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push(JSON.parse(flat[i + 1])); } catch (e) {}
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!R_URL || !R_TOK) { res.status(500).json({ error: 'Хранилище не подключено' }); return; }

    const action = body?.action;

    if (action === 'get') {
      const id = (body?.id || '').toString().trim();
      if (!id) { res.status(400).json({ error: 'Нет id' }); return; }
      const rec = await loadRecord(id);
      res.status(200).json({ ok: true, item: withProgress(rec) });
      return;
    }

    if (action === 'save') {
      const id = (body?.id || '').toString().trim();
      if (!id) { res.status(400).json({ error: 'Нет id' }); return; }
      let rec = await loadRecord(id);
      const isNew = !rec;
      const name = (body?.name || '').toString().slice(0, 120).trim();
      const roleIn = (body?.role || '').toString().trim();
      const role = ROLES.includes(roleIn) ? roleIn : (rec?.role || '');
      if (!role) { res.status(400).json({ error: 'Нужна роль (sales/success/support)' }); return; }
      if (isNew && !name) { res.status(400).json({ error: 'Нужно имя' }); return; }

      const checkedIn = (body?.checked && typeof body.checked === 'object') ? body.checked : {};
      const validKeys = new Set(itemsForRole(role).map(x => x[0]));
      const checked = {};
      for (const k of Object.keys(checkedIn)) if (validKeys.has(k) && checkedIn[k] === true) checked[k] = true;

      const now = Date.now();
      const prevDone = rec ? computeProgress(rec.role, rec.checked).done : 0;
      const prevTotal = rec ? computeProgress(rec.role, rec.checked).total : 0;
      const wasComplete = rec ? (prevTotal > 0 && prevDone >= prevTotal) : false;

      rec = {
        id,
        name: name || rec?.name || '',
        role,
        checked,
        startedAt: rec?.startedAt || now,
        updatedAt: now,
        notifiedStarted: !!rec?.notifiedStarted,
        notifiedDone: !!rec?.notifiedDone,
      };

      const { done, total } = computeProgress(role, checked);
      const nowComplete = total > 0 && done >= total;

      await redis(['HSET', HKEY, id, JSON.stringify(rec)]);

      // Уведомления — best-effort, не блокируют ответ.
      if (isNew && !rec.notifiedStarted) {
        rec.notifiedStarted = true;
        await redis(['HSET', HKEY, id, JSON.stringify(rec)]);
        notifyTelegram(
          `🆕 Новичок начал чек-лист адаптации — Sagi\n\n` +
          `👤 ${rec.name || '—'}\n` +
          `🧩 Роль: ${ROLE_LABEL[role] || role}\n\n` +
          `Статус: https://hr.sagibonus.com/onboarding-status.html`
        );
      }
      if (nowComplete && !wasComplete && !rec.notifiedDone) {
        rec.notifiedDone = true;
        await redis(['HSET', HKEY, id, JSON.stringify(rec)]);
        notifyTelegram(
          `✅ Чек-лист адаптации закрыт на 100% — Sagi\n\n` +
          `👤 ${rec.name || '—'}\n` +
          `🧩 Роль: ${ROLE_LABEL[role] || role}\n` +
          `Готов(а) к работе.\n\n` +
          `Статус: https://hr.sagibonus.com/onboarding-status.html`
        );
      }

      res.status(200).json({ ok: true, item: withProgress(rec) });
      return;
    }

    if (action === 'list') {
      const PASS = process.env.DASHBOARD_PASSWORD || '';
      if (!PASS || (body?.password || '') !== PASS) { res.status(403).json({ error: 'Неверный пароль' }); return; }
      const all = (await loadAll()).map(withProgress);
      all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      // Отдаём и сами группы пунктов (по ролям) — чтобы onboarding-status.html не дублировал
      // формулировки вручную и не разъезжался с api/onboarding.js при будущих правках списка.
      const itemsByRole = {};
      for (const r of ROLES) itemsByRole[r] = itemsForRole(r);
      res.status(200).json({ ok: true, items: all, itemsByRole, roleLabels: ROLE_LABEL });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
