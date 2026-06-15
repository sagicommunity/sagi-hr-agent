// Vercel Serverless Function — рекрутинг-пайплайн (для РОПа/рекрутера).
// POST { action, password, ... }. Защищено DASHBOARD_PASSWORD. Данные — Redis list hr:candidates.
// actions: 'list' | 'add' | 'stage' | 'delete'

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CAND_KEY = 'hr:candidates';
const STAGES = ['Новый', 'На связи', 'Квалификация', 'Интервью', 'Оффер', 'Стажировка', 'Отказ'];

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
async function loadAll() {
  const arr = await redis(['LRANGE', CAND_KEY, 0, 999]);
  if (!Array.isArray(arr)) return [];
  return arr.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}
async function saveAll(items) {
  await redis(['DEL', CAND_KEY]);
  for (const x of items.slice().reverse()) await redis(['LPUSH', CAND_KEY, JSON.stringify(x)]);
}

function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }
function extractPhone(...sources) {
  for (const s of sources) {
    const m = String(s || '').match(/(\+?7|8)?[\s\-(]*\d{3}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/);
    if (m) { let d = digits(m[0]); if (d.length === 10) d = '7' + d; if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1); return d; }
  }
  return '';
}
function waMessage(name) {
  const n = (name || '').trim().split(/\s+/)[0] || '';
  return `Здравствуйте${n ? ', ' + n : ''}! 👋 Меня зовут [ваше имя], я из компании Sagi (платформа лояльности для бизнеса). Мы расширяем отдел продаж и заинтересовались вашим опытом. Можете уделить пару минут — задам 3 коротких вопроса по позиции менеджера по продажам?`;
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

const SCREEN_SYS = `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ). Оцениваешь кандидата на менеджера по ХОЛОДНЫМ продажам (хантер): аутрич, звонки, поиск ЛПР, работа с возражениями, закрытие на встречу. Работа: офис в Астане.
КЛЮЧЕВОЙ ФИЛЬТР: кандидат ОБЯЗАН быть готов САМОСТОЯТЕЛЬНО искать ЛПР и делать ХОЛОДНЫЕ звонки/обзвоны. Если видно, что он НЕ хочет/не готов к холодным звонкам и самостоятельному поиску клиентов (только тёплые/входящие лиды, «не люблю звонить», только переписка) — ставь «Отказ» и низкий балл, укажи это в summary.
Верни ТОЛЬКО валидный JSON без markdown:
{"score": <0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения>", "strengths": ["..."], "flags": ["..."]}`;

async function screen(name, resume) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let out = { score: null, verdict: 'Резерв', summary: '', strengths: [], flags: [] };
  if (!apiKey || !resume) return out;
  try {
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 700, system: SCREEN_SYS, messages: [{ role: 'user', content: `Кандидат: ${name}\n\nРезюме:\n${resume.slice(0, 7000)}` }] }),
    });
    const ad = await ar.json();
    if (ar.ok) {
      const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { const o = JSON.parse(m[0]); out = { score: o.score ?? null, verdict: o.verdict || 'Резерв', summary: o.summary || '', strengths: o.strengths || [], flags: o.flags || [] }; }
    }
  } catch (e) {}
  return out;
}

function normalize(c) {
  return {
    id: c.id || newId(),
    name: c.name || '—',
    contact: c.contact || '',
    phone: c.phone || extractPhone(c.contact, c.resume),
    source: c.source || '—',
    score: c.score ?? null,
    verdict: c.verdict || 'Резерв',
    summary: c.summary || '',
    strengths: c.strengths || [],
    flags: c.flags || [],
    stage: STAGES.includes(c.stage) ? c.stage : 'Новый',
    waMessage: c.waMessage || waMessage(c.name),
    ts: c.ts || Date.now(),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const PASS = process.env.DASHBOARD_PASSWORD || '';
    if (!PASS || (body?.password || '') !== PASS) { res.status(403).json({ error: 'Неверный пароль РОПа' }); return; }
    if (!R_URL || !R_TOK) { res.status(500).json({ error: 'Хранилище не подключено' }); return; }

    const action = body?.action;

    if (action === 'list') {
      const items = (await loadAll()).map(normalize);
      res.status(200).json({ ok: true, stages: STAGES, items });
      return;
    }

    if (action === 'add') {
      const name = (body?.name || '').toString().slice(0, 80).trim();
      const phoneIn = (body?.phone || '').toString().trim();
      const contact = (body?.contact || '').toString().slice(0, 160).trim() || phoneIn;
      const source = (body?.source || 'ручное добавление').toString().slice(0, 80).trim();
      const resume = (body?.resume || '').toString().slice(0, 8000).trim();
      if (!name && !phoneIn && !resume) { res.status(400).json({ error: 'Нужно имя, телефон или резюме' }); return; }
      const ev = await screen(name, resume);
      const rec = normalize({
        id: newId(), name: name || 'Без имени', contact, phone: phoneIn ? digits(phoneIn) : extractPhone(contact, resume),
        source, resume: resume.slice(0, 2000), ...ev, stage: 'Новый', waMessage: waMessage(name), ts: Date.now(),
      });
      await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]);
      await redis(['LTRIM', CAND_KEY, 0, 1999]);
      res.status(200).json({ ok: true, item: rec });
      return;
    }

    if (action === 'stage') {
      const id = (body?.id || '').toString();
      const stage = (body?.stage || '').toString();
      if (!STAGES.includes(stage)) { res.status(400).json({ error: 'Неизвестная стадия' }); return; }
      const items = (await loadAll()).map(normalize);
      const idx = items.findIndex(x => x.id === id);
      if (idx < 0) { res.status(404).json({ error: 'Кандидат не найден' }); return; }
      items[idx].stage = stage;
      await saveAll(items);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'delete') {
      const id = (body?.id || '').toString();
      const items = (await loadAll()).map(normalize).filter(x => x.id !== id);
      await saveAll(items);
      res.status(200).json({ ok: true, remaining: items.length });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
