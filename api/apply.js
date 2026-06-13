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

const SCREEN_SYS = `Ты — HR-скринер компании Sagi (loyalty-платформа для B2B МСБ, sagi.kz). Оцениваешь кандидата на позицию менеджера по ХОЛОДНЫМ продажам (хантер): холодный аутрич и звонки, поиск ЛПР, обход блокировок, выявление боли, работа с возражениями, закрытие на демо/встречу.

Оцени присланное резюме/анкету строго по профилю хантера. Критерии: опыт холодных продаж/аутрича, навык письма (офферы/сообщения), стрессоустойчивость и работа с отказом, нацеленность на результат и CTA, релевантность рынку Казахстана/МСБ, стабильность (как часто менял работу).

Верни ТОЛЬКО валидный JSON, без markdown и пояснений:
{"score": <число 0-10>, "verdict": "Брать на интервью" | "Резерв" | "Отказ", "summary": "<2-3 предложения по сути>", "strengths": ["<сильная сторона>", ...], "flags": ["<красный флаг>", ...]}`;

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
    if (!name || !contact || !resume) { res.status(400).json({ error: 'Заполните имя, контакт и резюме.' }); return; }

    let evaln = { score: null, verdict: 'Резерв', summary: '', strengths: [], flags: [] };
    try {
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 800, system: SCREEN_SYS,
          messages: [{ role: 'user', content: `Кандидат: ${name}\nИсточник: ${source || '—'}\n\nРезюме/анкета:\n${resume}` }],
        }),
      });
      const ad = await ar.json();
      if (ar.ok) {
        const txt = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { try { const o = JSON.parse(m[0]); evaln = { score: o.score ?? null, verdict: o.verdict || 'Резерв', summary: o.summary || '', strengths: o.strengths || [], flags: o.flags || [] }; } catch (e) {} }
      }
    } catch (e) {}

    const rec = {
      name, contact, source: source || '—',
      resume: resume.slice(0, 2000),
      score: evaln.score, verdict: evaln.verdict, summary: evaln.summary,
      strengths: evaln.strengths, flags: evaln.flags, ts: Date.now(),
    };
    try { await redis(['LPUSH', CAND_KEY, JSON.stringify(rec)]); await redis(['LTRIM', CAND_KEY, 0, 999]); } catch (e) {}

    res.status(200).json({ ok: true, score: evaln.score, verdict: evaln.verdict, summary: evaln.summary });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
