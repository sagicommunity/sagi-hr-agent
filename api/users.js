// Vercel Serverless Function — аккаунты сотрудников и прогресс обучения.
// POST { action, ... }. Данные — Redis (Upstash). Ключи: hr:user:<login>, set hr:users.
// actions:
//   register { name, login, password, role }      -> { ok, user, token }
//   login    { login, password }                  -> { ok, user, token }
//   me       { login, token }                      -> { ok, user }
//   progress { login, token, moduleId, done }      -> { ok, user }
//   leaderboard { login, token }                    -> { ok, board:[{login,name,role,points}] }
//            — публичный (для залогиненных) рейтинг по баллам, обе группы trainee/manager вместе
//   list     { password }  (password = DASHBOARD_PASSWORD руководителя) -> { ok, users:[...] }
//   setRole  { password, login, role }  role: 'manager'|'trainee' -> { ok, user } — перевод стажёра
//            в менеджеры (или обратно), тот же аккаунт/логин/прогресс, ничего не создаётся заново
//   setStatus { password, login, status, comment } status: см. HIRE_STATUSES ниже -> { ok, user }
//            — статус найма/работы (не путать с role), с комментарием-причиной
//   setLogin    { password, login, newLogin }     -> { ok, user } — смена логина (см. ниже про
//            перенос чек-листа адаптации и истории ИИ-тренажёра)
//   setPassword { password, login, newPassword }  -> { ok, user } — смена пароля без знания старого
//            (это же экран РОПа, а не самого стажёра) — например, если стажёр забыл пароль

import crypto from 'crypto';

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

const uKey = login => 'hr:user:' + login;
const norm = s => (s || '').toString().trim().toLowerCase();

function hashPass(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }

async function getUser(login) {
  const raw = await redis(['GET', uKey(login)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function putUser(u) {
  await redis(['SET', uKey(u.login), JSON.stringify(u)]);
  await redis(['SADD', 'hr:users', u.login]);
}
// безопасное представление (без хэша/соли/токена)
function safe(u) {
  return { name: u.name, login: u.login, role: u.role, progress: u.progress || {}, points: u.points || 0, lastSeen: u.lastSeen, createdAt: u.createdAt, mentorName: u.mentorName || null, mentorPhone: u.mentorPhone || null, hhNegId: u.hhNegId || null, candId: u.candId || null, phone: u.phone || null, intakeAnswers: u.intakeAnswers || null, intakeVacancy: u.intakeVacancy || null, howFound: u.howFound || null, age: (typeof u.age === 'number') ? u.age : null, ageOutOfRange: !!u.ageOutOfRange, promotedAt: u.promotedAt || null, quizAttempts: u.quizAttempts || {}, quizBest: u.quizBest || {}, hireStatus: u.hireStatus || 'Активен', statusComment: u.statusComment || '', statusUpdatedAt: u.statusUpdatedAt || null };
}

// Статусы сотрудника/стажёра (отдельно от role trainee/manager — role определяет доступный
// контент обучения, hireStatus описывает реальную ситуацию с человеком). Добавлено 2026-08-18
// по просьбе Sagi — нужен способ пометить «не подходит» с комментарием (пример: стажёр оказался
// несовершеннолетним, 17 лет/11 класс), не удаляя аккаунт и не путая это со сменой role.
const HIRE_STATUSES = ['Активен', 'Не подходит', 'Не выходит на связь', 'На паузе', 'Уволен', 'Ушёл сам'];
function checkBoss(body, res) {
  const PASS = process.env.DASHBOARD_PASSWORD || '';
  if (!PASS || (body.password || '').toString() !== PASS) { res.status(403).json({ error: 'Неверный пароль руководителя' }); return false; }
  return true;
}

// 2026-08-17, по указанию Sagi: «ответы, которые кандидаты отвечают нам на вопросы, их нужно
// тоже хранить в профайле» — при отклике человек уже отвечает на вопросы (hh.kz/Telegram-бот/
// форма/WhatsApp), и этот текст сохраняется в hr:candidates (поля resume/replyText/answers).
// Но карточка стажёра (hr:user) — отдельная запись, до сих пор не связанная с этим текстом.
// Ищем совпадение по телефону (самый надёжный признак), затем по hhNegId, затем по точному
// имени — и копируем найденный текст ответов в профиль стажёра, чтобы Sagi видел его в кабинете.
function normPhone(s) { return (s || '').toString().replace(/\D/g, '').slice(-10); }
async function findCandidateAnswers(u) {
  const raw = (await redis(['LRANGE', CAND_KEY, 0, 1999])) || [];
  const cands = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  const uPhone = normPhone(u.phone);
  const uName = norm(u.name);
  let match = null;
  if (u.hhNegId) match = cands.find(c => c.id === 'hh_' + u.hhNegId);
  if (!match && uPhone) match = cands.find(c => normPhone(c.contact) === uPhone || normPhone(c.phone) === uPhone);
  if (!match && uName) match = cands.find(c => norm(c.name) === uName);
  if (!match) return null;
  const answersText = match.replyText || match.resume || (Array.isArray(match.answers) ? match.answers.map(a => `${a.q}: ${a.a}`).join('\n\n') : '') || '';
  if (!answersText) return null;
  return { text: answersText.slice(0, 4000), vacancy: match.vacancy || null, source: match.source || null, candId: match.id, howFound: match.howFound || null, age: (typeof match.age === 'number') ? match.age : null, ageOutOfRange: !!match.ageOutOfRange };
}

// 2026-08-18: двигает стадию кандидата в hr:candidates вперёд по воронке, но только если он
// сейчас на одной из fromStages — никогда не перезаписывает «Отказ» или более позднюю ручную
// стадию (например, если Sagi уже сам взял его на интервью в обход обычного потока).
async function bumpCandidateStage(candId, fromStages, toStage) {
  if (!candId) return false;
  const raw = await redis(['LRANGE', CAND_KEY, 0, 1999]);
  if (!Array.isArray(raw)) return false;
  for (let i = 0; i < raw.length; i++) {
    let rec;
    try { rec = JSON.parse(raw[i]); } catch (e) { continue; }
    if (rec && rec.id === candId) {
      if (!fromStages.includes(rec.stage)) return false;
      rec.stage = toStage;
      await redis(['LSET', CAND_KEY, i, JSON.stringify(rec)]);
      return true;
    }
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!R_URL || !R_TOK) { res.status(500).json({ error: 'База не подключена' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const action = body?.action;

    // ── ДИАГНОСТИЧЕСКИЙ ПОИСК (2026-08-18, разбор жалоб «логин уже занят» без пароля РОПа) ──
    // Секрет — тот же HH_POLL_SECRET, что и у /api/hh_poll (безопасно для серверных диагностик,
    // но не даёт доступа к паролям/хэшам — safe() их и так не отдаёт).
    if (action === 'adminFind') {
      const secret = (body.secret || '').toString();
      if (!process.env.HH_POLL_SECRET || secret !== process.env.HH_POLL_SECRET) { res.status(403).json({ error: 'forbidden' }); return; }
      const q = norm(body.q || '');
      const logins = (await redis(['SMEMBERS', 'hr:users'])) || [];
      const arr = Array.isArray(logins) ? logins : [];
      const matches = [];
      for (const lg of arr) {
        const u = await getUser(lg);
        if (!u) continue;
        const hay = norm(u.name) + ' ' + norm(u.login) + ' ' + normPhone(u.phone);
        if (!q || hay.includes(q) || hay.includes(normPhone(q))) matches.push(safe(u));
      }
      res.status(200).json({ ok: true, totalUsers: arr.length, matches });
      return;
    }

    // ── СБРОС ПАРОЛЯ (тем же секретом, что и adminFind) — на случай, если стажёр реально забыл
    // пароль, а не просто перепутал «войти»/«зарегистрироваться» ──
    if (action === 'adminResetPassword') {
      const secret = (body.secret || '').toString();
      if (!process.env.HH_POLL_SECRET || secret !== process.env.HH_POLL_SECRET) { res.status(403).json({ error: 'forbidden' }); return; }
      const login = norm(body.login);
      const newPassword = (body.newPassword || '').toString();
      if (!login || newPassword.length < 4) { res.status(400).json({ error: 'login и newPassword (мин. 4 символа) обязательны' }); return; }
      const u = await getUser(login);
      if (!u) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
      const salt = crypto.randomBytes(8).toString('hex');
      u.passHash = hashPass(newPassword, salt);
      u.salt = salt;
      await putUser(u);
      res.status(200).json({ ok: true, login: u.login });
      return;
    }

    // ── РЕГИСТРАЦИЯ ──
    if (action === 'register') {
      const name = (body.name || '').toString().trim();
      const login = norm(body.login);
      const password = (body.password || '').toString();
      const role = body.role === 'manager' ? 'manager' : 'trainee';
      if (!name || !login || !password) { res.status(400).json({ error: 'Заполните все поля.' }); return; }
      if (password.length < 4) { res.status(400).json({ error: 'Пароль слишком короткий (мин. 4 символа).' }); return; }
      if (await getUser(login)) { res.status(409).json({ error: 'Такой логин уже занят. Войдите.' }); return; }
      const salt = crypto.randomBytes(8).toString('hex');
      const token = newToken();
      // hhNegId — id переписки на hh.kz, если человек пришёл по персональной ссылке из
      // приглашения на стажировку (?hh=...). Нужен, чтобы напоминания об обучении и
      // уведомление о наставнике могли прийти автоматически в тот же чат.
      const hhNegId = (body.hh || '').toString().replace(/\D/g, '').slice(0, 30) || null;
      const phone = (body.phone || '').toString().trim().slice(0, 30) || null;
      const u = { name, login, role, salt, passHash: hashPass(password, salt), token, progress: {}, points: 0, createdAt: Date.now(), lastSeen: Date.now(), hhNegId, phone };
      try {
        const found = await findCandidateAnswers(u);
        if (found) {
          u.intakeAnswers = found.text; u.intakeVacancy = found.vacancy; u.candId = found.candId; u.howFound = found.howFound; u.age = found.age; u.ageOutOfRange = found.ageOutOfRange;
          // 2026-08-18, по замечанию Sagi: «Стажировка» — это когда человек реально стажируется
          // (закончил обучение, есть наставник), а не просто приглашён. Регистрация на
          // hr.sagibonus.com — это начало ОБУЧЕНИЯ, ставим кандидату именно эту стадию (если он
          // ещё не дальше по воронке, например уже не отказан вручную).
          try { await bumpCandidateStage(found.candId, ['Новый', 'Ответил', 'Приглашён'], 'Обучение'); } catch (e) {}
        }
      } catch (e) {}
      await putUser(u);
      res.status(200).json({ ok: true, user: safe(u), token });
      return;
    }

    // ── ВХОД ──
    if (action === 'login') {
      const login = norm(body.login);
      const password = (body.password || '').toString();
      const u = await getUser(login);
      if (!u) { res.status(404).json({ error: 'Пользователь не найден. Зарегистрируйтесь.' }); return; }
      if (hashPass(password, u.salt) !== u.passHash) { res.status(403).json({ error: 'Неверный пароль.' }); return; }
      u.token = newToken(); u.lastSeen = Date.now();
      await putUser(u);
      res.status(200).json({ ok: true, user: safe(u), token: u.token });
      return;
    }

    // ── ВОССТАНОВЛЕНИЕ СЕССИИ ──
    if (action === 'me') {
      const login = norm(body.login);
      const u = await getUser(login);
      if (!u || u.token !== body.token) { res.status(401).json({ error: 'Сессия истекла' }); return; }
      res.status(200).json({ ok: true, user: safe(u) });
      return;
    }

    // ── СОХРАНЕНИЕ ПРОГРЕССА ──
    if (action === 'progress') {
      const login = norm(body.login);
      const u = await getUser(login);
      if (!u || u.token !== body.token) { res.status(401).json({ error: 'Сессия истекла' }); return; }
      u.progress = u.progress || {};
      const id = (body.moduleId || '').toString();
      if (!id) { res.status(400).json({ error: 'moduleId required' }); return; }
      if (body.done) u.progress[id] = true; else delete u.progress[id];

      // Реальные результаты теста (2026-08-18, задача Sagi «чтобы обучение было качественно») —
      // раньше хранили только да/нет прошёл модуль. Теперь сохраняем КАЖДУЮ попытку (в том числе
      // неудачную) — сколько верно из скольки, какие вопросы промахнул, и лучший результат.
      // Так видно, кто проходит тесты с трудом (даже если в итоге прошёл) — это как раз кандидаты
      // на усиленное внимание наставника, а не просто «прошёл/не прошёл».
      const qScore = body.quizScore, qTotal = body.quizTotal;
      if (typeof qScore === 'number' && typeof qTotal === 'number' && qTotal > 0) {
        u.quizAttempts = u.quizAttempts || {};
        const attempts = Array.isArray(u.quizAttempts[id]) ? u.quizAttempts[id] : [];
        const missed = Array.isArray(body.quizMissed) ? body.quizMissed.slice(0, 20).map(s => String(s).slice(0, 300)) : [];
        attempts.push({ score: qScore, total: qTotal, passed: !!body.done, missed, ts: Date.now() });
        u.quizAttempts[id] = attempts.slice(-10); // последние 10 попыток, не растим бесконечно
        u.quizBest = u.quizBest || {};
        const pct = qScore / qTotal;
        const bestPct = u.quizBest[id] ? (u.quizBest[id].score / u.quizBest[id].total) : -1;
        if (pct > bestPct) u.quizBest[id] = { score: qScore, total: qTotal };
      }

      u.points = Object.keys(u.progress).length * 10;
      u.lastSeen = Date.now();
      await putUser(u);
      res.status(200).json({ ok: true, user: safe(u) });
      return;
    }

    // ── РЕЙТИНГ (публичный лидерборд стажёров/стажировки, 2026-08-26 по указанию Sagi —
    //    «может рейтинг сделаем», по аналогии с лидербордом на фитнес-занятиях) ──
    // Требует валидной сессии (login+token), как 'me'/'progress' — не полностью публичный
    // роут, чтобы имена и баллы нельзя было утащить без входа в кабинет. Возвращает ОБЕ группы
    // (role: 'trainee'/'manager') одним списком — фронтенд сам фильтрует по вкладке, т.к. группы
    // маленькие (десятки записей), лишний туда-обратно запрос не нужен.
    if (action === 'leaderboard') {
      const login = norm(body.login);
      const me = await getUser(login);
      if (!me || me.token !== body.token) { res.status(401).json({ error: 'Сессия истекла' }); return; }
      const logins = await redis(['SMEMBERS', 'hr:users']);
      const arr = Array.isArray(logins) ? logins : [];
      const board = [];
      for (const lg of arr) {
        const u = await getUser(lg);
        if (!u) continue;
        // Выбывших/отказников/уволенных в рейтинге не показываем — как и в остальной системе,
        // это hireStatus, а не role (см. safe() выше).
        if ((u.hireStatus || 'Активен') !== 'Активен') continue;
        // Тестовые аккаунты — та же конвенция, что и везде в системе (api/data.js, pipeline.html).
        if (/тест|test|проверка/i.test(u.name || '')) continue;
        board.push({ login: u.login, name: u.name, role: u.role, points: u.points || 0 });
      }
      board.sort((a, b) => b.points - a.points);
      res.status(200).json({ ok: true, board });
      return;
    }

    // ── СПИСОК ДЛЯ РУКОВОДИТЕЛЯ ──
    if (action === 'list') {
      if (!checkBoss(body, res)) return;
      const logins = await redis(['SMEMBERS', 'hr:users']);
      const arr = Array.isArray(logins) ? logins : [];
      const users = [];
      for (const lg of arr) { const u = await getUser(lg); if (u) users.push(safe(u)); }
      res.status(200).json({ ok: true, users });
      return;
    }

    // ── УДАЛЕНИЕ (только руководитель, например тестовые/дублирующие аккаунты) ──
    if (action === 'delete') {
      if (!checkBoss(body, res)) return;
      const login = norm(body.login);
      if (!login) { res.status(400).json({ error: 'login required' }); return; }
      await redis(['DEL', uKey(login)]);
      await redis(['SREM', 'hr:users', login]);
      res.status(200).json({ ok: true });
      return;
    }

    // ── РУЧНОЕ РЕДАКТИРОВАНИЕ КОНТАКТА (только руководитель) — например, если сотрудник
    // зарегистрировался не по персональной ссылке из hh.kz и телефон нужно вписать вручную ──
    if (action === 'setContact') {
      if (!checkBoss(body, res)) return;
      const login = norm(body.login);
      const u = await getUser(login);
      if (!u) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
      u.phone = (body.phone || '').toString().trim().slice(0, 30) || null;
      await putUser(u);
      res.status(200).json({ ok: true, user: safe(u) });
      return;
    }

    // ── РУЧНОЕ НАЗНАЧЕНИЕ НАСТАВНИКА (только руководитель) — например, если Sagi уже сам
    // связал стажёра с наставником лично (звонок/WhatsApp), без автоматического уведомления,
    // чтобы избежать дублирующего сообщения от бота ──
    if (action === 'setMentor') {
      if (!checkBoss(body, res)) return;
      const login = norm(body.login);
      const u = await getUser(login);
      if (!u) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
      u.mentorName = (body.mentorName || '').toString().trim() || null;
      u.mentorPhone = (body.mentorPhone || '').toString().trim() || null;
      u.mentorAssignedAt = Date.now();
      await putUser(u);
      res.status(200).json({ ok: true, user: safe(u) });
      return;
    }

    // ── ПЕРЕВОД СТАЖЁРА В МЕНЕДЖЕРЫ (только руководитель, 2026-08-17 по указанию Sagi) —
    // после того как наставник провёл стажировку и решил, что человек готов, аккаунт НЕ
    // пересоздаётся: тот же логин/пароль/прогресс/наставник/история остаются, меняется только
    // role на 'manager'. Это сразу открывает 9 продвинутых модулей (ADV) и меняет бейдж в
    // панели руководителя с «Стажёр» на «Менеджер». Можно и обратно перевести в 'trainee',
    // если понадобится (role передаётся явно).
    if (action === 'setRole') {
      if (!checkBoss(body, res)) return;
      const login = norm(body.login);
      const role = body.role === 'trainee' ? 'trainee' : (body.role === 'manager' ? 'manager' : null);
      if (!role) { res.status(400).json({ error: 'role должен быть manager или trainee' }); return; }
      const u = await getUser(login);
      if (!u) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
      u.role = role;
      if (role === 'manager' && !u.promotedAt) u.promotedAt = Date.now();
      await putUser(u);
      res.status(200).json({ ok: true, user: safe(u) });
      return;
    }

    // ── СТАТУС СОТРУДНИКА/СТАЖЁРА (только руководитель, 2026-08-18) — например «Не подходит»
    // с комментарием-причиной (несовершеннолетний и т.п.), не трогая role и не удаляя аккаунт.
    if (action === 'setStatus') {
      if (!checkBoss(body, res)) return;
      const login = norm(body.login);
      const status = (body.status || '').toString().trim();
      if (!HIRE_STATUSES.includes(status)) { res.status(400).json({ error: 'status должен быть одним из: ' + HIRE_STATUSES.join(', ') }); return; }
      const u = await getUser(login);
      if (!u) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
      u.hireStatus = status;
      u.statusComment = (body.comment || '').toString().trim().slice(0, 1000);
      u.statusUpdatedAt = Date.now();
      await putUser(u);
      res.status(200).json({ ok: true, user: safe(u) });
      return;
    }

    // ── СМЕНА ЛОГИНА (только руководитель, 2026-09-04, по указанию Sagi: «некоторые теряют,
    // забывают», нужно уметь поменять прямо из панели, не пересоздавая аккаунт). Логин — это и
    // есть ключ записи (hr:user:<login>, set hr:users), плюс на него завязаны ещё два места ВНЕ
    // этого файла: чек-лист адаптации (api/onboarding.js, hr:onboarding, id записи = login — см.
    // index.html, ссылка /onboarding.html?id=login) и история практики с ИИ-тренажёром
    // (api/chat.js, список hr:events, у каждого события есть своё поле login). При переименовании
    // переносим оба, иначе прогресс по чек-листу и вся история тренировок «потеряются» под старым
    // логином, хотя по факту никуда не делись.
    if (action === 'setLogin') {
      if (!checkBoss(body, res)) return;
      const oldLogin = norm(body.login);
      const newLogin = norm(body.newLogin).slice(0, 60);
      if (!oldLogin || !newLogin) { res.status(400).json({ error: 'login и newLogin обязательны' }); return; }
      const u = await getUser(oldLogin);
      if (!u) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
      if (newLogin !== oldLogin) {
        if (await getUser(newLogin)) { res.status(409).json({ error: 'Такой логин уже занят' }); return; }
        u.login = newLogin;
        // Новый токен — старая сессия на устройстве стажёра всё равно ссылалась на прежний login
        // (localStorage хранит login+token вместе), при следующем открытии кабинета она перестанет
        // проходить и просто попросит войти заново под новым логином — это ожидаемо и безопасно.
        u.token = newToken();
        await putUser(u);
        await redis(['DEL', uKey(oldLogin)]);
        await redis(['SREM', 'hr:users', oldLogin]);
        try {
          const obRaw = await redis(['HGET', 'hr:onboarding', oldLogin]);
          if (obRaw) {
            let ob; try { ob = JSON.parse(obRaw); } catch (e) { ob = null; }
            if (ob) {
              ob.id = newLogin;
              await redis(['HSET', 'hr:onboarding', newLogin, JSON.stringify(ob)]);
              await redis(['HDEL', 'hr:onboarding', oldLogin]);
            }
          }
        } catch (e) {}
        try {
          const events = await redis(['LRANGE', 'hr:events', 0, 999]);
          if (Array.isArray(events)) {
            for (let i = 0; i < events.length; i++) {
              let ev; try { ev = JSON.parse(events[i]); } catch (e) { continue; }
              if (ev && ev.login === oldLogin) {
                ev.login = newLogin;
                await redis(['LSET', 'hr:events', i, JSON.stringify(ev)]);
              }
            }
          }
        } catch (e) {}
      }
      res.status(200).json({ ok: true, user: safe(u) });
      return;
    }

    // ── СМЕНА ПАРОЛЯ (только руководитель, 2026-09-04, по указанию Sagi) — не требует знания
    // старого пароля, потому что вызывается из панели РОПа, а не самим стажёром. Токен тоже
    // обнуляем, чтобы уже открытая сессия на телефоне стажёра сразу потребовала новый пароль,
    // а не продолжала молча работать по старому.
    if (action === 'setPassword') {
      if (!checkBoss(body, res)) return;
      const login = norm(body.login);
      const newPassword = (body.newPassword || '').toString();
      if (newPassword.length < 4) { res.status(400).json({ error: 'Пароль слишком короткий (мин. 4 символа)' }); return; }
      const u = await getUser(login);
      if (!u) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
      const salt = crypto.randomBytes(8).toString('hex');
      u.passHash = hashPass(newPassword, salt);
      u.salt = salt;
      u.token = newToken();
      await putUser(u);
      res.status(200).json({ ok: true, user: safe(u) });
      return;
    }

    // ── ОДНОРАЗОВЫЙ БЭКФИЛЛ (только руководитель) — подтягивает ответы кандидата в уже
    // существующие карточки стажёров, зарегистрированных до того, как это стало сохраняться
    // автоматически при регистрации. Безопасно вызывать повторно (пропускает у кого уже есть).
    if (action === 'backfillIntake') {
      if (!checkBoss(body, res)) return;
      const logins = (await redis(['SMEMBERS', 'hr:users'])) || [];
      let updated = 0, skipped = 0, notFound = 0;
      const names = [];
      for (const login of logins) {
        const u = await getUser(login);
        if (!u) continue;
        if (u.intakeAnswers) { skipped++; continue; }
        try {
          const found = await findCandidateAnswers(u);
          if (found) {
            u.intakeAnswers = found.text; u.intakeVacancy = found.vacancy; u.howFound = found.howFound; u.age = found.age; u.ageOutOfRange = found.ageOutOfRange;
            await putUser(u);
            updated++;
            names.push(u.name);
          } else notFound++;
        } catch (e) { notFound++; }
      }
      res.status(200).json({ ok: true, updated, skipped, notFound, names });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
