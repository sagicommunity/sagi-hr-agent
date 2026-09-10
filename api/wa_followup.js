// Vercel Serverless Function — догон по WhatsApp (Sagi, 2026-09-10).
// GET /api/wa_followup?secret=<HH_POLL_SECRET>[&dryrun=1][&cap=300]
//
// Отдельный лёгкий эндпоинт (а не фаза внутри hh_poll — тот и так близок к лимиту времени).
// Ставит ОДНИМ батч-запросом в очередь серого WhatsApp-воркера сообщения тем, кто:
//   1) откликнулся и заполнил, но не дошёл до обучения (стадии Новый/Ожидает ответа/Ответил/Приглашён);
//   2) у кого истекло время на базовую программу (hireStatus На паузе или авто-«Не подходит»).
// Темп отправки держит сам воркер (1 сообщение в 2 минуты). Каждый человек получает не больше
// одного сообщения — отметки в Redis-сетах hr:wa_followup_done / hr:wa_return_done.
//
// Запускается по расписанию через GitHub Action (.github/workflows/wa_followup.yml).

import { enqueueWA, extractPhone, HR_WA } from './_wa.js';

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CAND_KEY = 'hr:candidates';
const FOLLOW_DONE_KEY = 'hr:wa_followup_done';
const RETURN_DONE_KEY = 'hr:wa_return_done';
const NUDGE_STAGES = ['Новый', 'Ожидает ответа', 'Ответил', 'Приглашён'];

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) return null;
  return (await r.json()).result;
}
async function redisBatch(cmds) {
  if (!R_URL || !R_TOK || !cmds.length) return cmds.map(() => null);
  const r = await fetch(R_URL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) return cmds.map(() => null);
  const d = await r.json();
  return Array.isArray(d) ? d.map((x) => x.result) : cmds.map(() => null);
}

export default async function handler(req, res) {
  const secret = process.env.HH_POLL_SECRET || '';
  if (!secret || (req.query?.secret || '') !== secret) { res.status(403).json({ error: 'forbidden' }); return; }
  if (!R_URL || !R_TOK) { res.status(500).json({ error: 'Хранилище не подключено' }); return; }

  const dryRun = req.query?.dryrun === '1';
  const cap = Math.min(1000, Math.max(1, parseInt(req.query?.cap, 10) || 300));

  const candRaw = await redis(['LRANGE', CAND_KEY, 0, 1999]);
  const candidates = (Array.isArray(candRaw) ? candRaw : []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);

  const logins = (await redis(['SMEMBERS', 'hr:users'])) || [];
  const userRaws = await redisBatch((Array.isArray(logins) ? logins : []).map((l) => ['GET', 'hr:user:' + l]));
  const users = [];
  (Array.isArray(logins) ? logins : []).forEach((login, i) => { try { if (userRaws[i]) users.push({ login, u: JSON.parse(userRaws[i]) }); } catch (e) {} });

  const followDone = new Set((await redis(['SMEMBERS', FOLLOW_DONE_KEY])) || []);
  const returnDone = new Set((await redis(['SMEMBERS', RETURN_DONE_KEY])) || []);

  const items = [];
  const followIds = [];
  let byStage = {};
  for (const c of candidates) {
    if (items.length >= cap) break;
    const st = c.stage || 'Новый';
    if (!NUDGE_STAGES.includes(st)) continue;
    const to = extractPhone(c.phone, c.contact);
    if (!to) continue;
    if (followDone.has(String(c.id))) continue;
    byStage[st] = (byStage[st] || 0) + 1;
    items.push({ to, text: (st === 'Новый' || st === 'Ожидает ответа') ? HR_WA.coldBase(c.name) : HR_WA.afterForm(c.name) });
    followIds.push(String(c.id));
  }
  const returnLogins = [];
  for (const { login, u } of users) {
    if (items.length >= cap) break;
    const autoExpired = (u.hireStatus === 'На паузе') || (u.hireStatus === 'Не подходит' && /^Авто/.test(u.statusComment || ''));
    if (!autoExpired) continue;
    const to = extractPhone(u.phone);
    if (!to) continue;
    if (returnDone.has(login)) continue;
    items.push({ to, text: HR_WA.returnAfterDeadline(u.name) });
    returnLogins.push(login);
  }

  let queued = 0;
  if (!dryRun && items.length) {
    const r = await enqueueWA(items);
    if (r && r.ok && r.queued) {
      queued = r.queued;
      if (followIds.length) await redis(['SADD', FOLLOW_DONE_KEY, ...followIds]);
      if (returnLogins.length) await redis(['SADD', RETURN_DONE_KEY, ...returnLogins]);
    }
  } else {
    queued = items.length;
  }

  res.status(200).json({
    ok: true, dryRun, cap,
    candidatesChecked: candidates.length,
    usersChecked: users.length,
    byStage,
    toReturn: returnLogins.length,
    queued,
  });
}
