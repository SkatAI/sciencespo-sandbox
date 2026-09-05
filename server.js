const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function emptySession() {
  return {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    phase: 'waiting',
    durationMinutes: 5,
    startedAt: null,
    writingEndsAt: null,
    graceEndsAt: null,
    revealAt: null,
    participants: {},
    report: null,
    analysisModel: null,
    analysisCreatedAt: null
  };
}

function loadSession() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(SESSION_FILE)) {
      const initial = emptySession();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(initial, null, 2));
      return initial;
    }
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return { ...emptySession(), ...parsed, participants: parsed.participants || {} };
  } catch (err) {
    console.error('Failed to load session; starting a new one:', err);
    return emptySession();
  }
}

let state = loadSession();
let saveTimer = null;

function saveState(immediate = false) {
  const write = () => {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
    saveTimer = null;
  };
  if (immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    write();
  } else if (!saveTimer) {
    saveTimer = setTimeout(write, 120);
  }
}

function normalizeTicket(ticket, index) {
  return {
    id: String(ticket?.id || crypto.randomUUID()),
    text: String(ticket?.text || '').slice(0, 200),
    impact: Math.max(-5, Math.min(5, Number.isFinite(Number(ticket?.impact)) ? Number(ticket.impact) : 0)),
    order: index,
    topic: ticket?.topic ? String(ticket.topic).slice(0, 40) : null,
    updatedAt: new Date().toISOString()
  };
}

function importanceForTickets(tickets) {
  let points = 5;
  return tickets.map((ticket) => {
    const filled = ticket.text.trim().length > 0;
    const importance = filled ? points-- : null;
    return { ...ticket, importance };
  });
}

function getAllTickets({ includeNames = false } = {}) {
  const rows = [];
  for (const [participantId, p] of Object.entries(state.participants)) {
    const ranked = importanceForTickets(p.tickets || []);
    for (const ticket of ranked) {
      if (!ticket.text.trim()) continue;
      rows.push({
        id: ticket.id,
        participantId,
        ...(includeNames ? { displayName: p.anonymous ? null : p.displayName, anonymous: !!p.anonymous } : {}),
        text: ticket.text,
        impact: ticket.impact,
        importance: ticket.importance,
        topic: ticket.topic || null,
        updatedAt: ticket.updatedAt
      });
    }
  }
  return rows;
}

function advanceTimer() {
  const now = Date.now();
  let changed = false;
  if (state.phase === 'writing' && state.writingEndsAt && now >= state.writingEndsAt) {
    state.phase = 'grace';
    changed = true;
  }
  if (state.phase === 'grace' && state.graceEndsAt && now >= state.graceEndsAt) {
    state.phase = 'countdown';
    changed = true;
  }
  if (state.phase === 'countdown' && state.revealAt && now >= state.revealAt) {
    state.phase = 'results';
    changed = true;
  }
  if (changed) saveState(true);
}

setInterval(advanceTimer, 250);

function publicState() {
  advanceTimer();
  return {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    phase: state.phase,
    durationMinutes: state.durationMinutes,
    startedAt: state.startedAt,
    writingEndsAt: state.writingEndsAt,
    graceEndsAt: state.graceEndsAt,
    revealAt: state.revealAt,
    participantCount: Object.keys(state.participants).length,
    ticketCount: getAllTickets({ includeNames: false }).length,
    tickets: state.phase === 'results' ? getAllTickets({ includeNames: false }) : [],
    report: state.report,
    analysisModel: state.analysisModel,
    analysisCreatedAt: state.analysisCreatedAt,
    serverNow: Date.now()
  };
}

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(data);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON request body.')); }
    });
    req.on('error', reject);
  });
}

function isEditable() {
  advanceTimer();
  return state.phase === 'writing' || state.phase === 'grace';
}

function extractJson(value) {
  let textValue = value;
  if (Array.isArray(value)) {
    textValue = value.map(x => typeof x === 'string' ? x : (x?.text || '')).join('\n');
  }
  const trimmed = String(textValue || '').trim();
  try { return JSON.parse(trimmed); } catch (_) {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
  throw new Error('The model did not return valid JSON.');
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/state') {
    return json(res, 200, publicState());
  }

  if (req.method === 'POST' && pathname === '/api/join') {
    const payload = await readBody(req);
    const participantId = String(payload.participantId || crypto.randomUUID());
    const existing = state.participants[participantId];
    const anonymous = !!payload.anonymous;
    const displayName = anonymous ? '' : String(payload.displayName || '').trim().slice(0, 50);

    if (!existing) {
      state.participants[participantId] = {
        id: participantId,
        displayName,
        anonymous,
        joinedAt: new Date().toISOString(),
        tickets: Array.from({ length: 5 }, (_, i) => ({
          id: crypto.randomUUID(), text: '', impact: 0, order: i, topic: null, updatedAt: new Date().toISOString()
        }))
      };
    } else {
      existing.displayName = displayName;
      existing.anonymous = anonymous;
    }
    saveState();
    return json(res, 200, { ok: true, participantId, sessionId: state.sessionId, participant: state.participants[participantId] });
  }

  if (req.method === 'POST' && pathname === '/api/tickets') {
    const payload = await readBody(req);
    if (!isEditable()) return json(res, 409, { ok: false, error: 'Submissions are locked.' });
    const participantId = String(payload.participantId || '');
    const participant = state.participants[participantId];
    if (!participant) return json(res, 404, { ok: false, error: 'Participant not found.' });

    const incoming = Array.isArray(payload.tickets) ? payload.tickets.slice(0, 5) : [];
    const normalized = incoming.map(normalizeTicket);
    while (normalized.length < 5) normalized.push(normalizeTicket({}, normalized.length));
    const oldById = Object.fromEntries((participant.tickets || []).map(t => [t.id, t]));
    participant.tickets = normalized.map((t, i) => {
      const old = oldById[t.id];
      return { ...t, order: i, topic: old && old.text === t.text ? old.topic : null };
    });
    saveState();
    return json(res, 200, { ok: true, savedAt: Date.now() });
  }

  if (req.method === 'POST' && pathname === '/api/start') {
    const payload = await readBody(req);
    advanceTimer();
    if (state.phase !== 'waiting') return json(res, 409, { ok: false, error: 'Timer has already started.' });
    const minutes = Math.max(1, Math.min(60, Math.round(Number(payload.minutes) || 5)));
    const startedAt = Date.now();
    state.durationMinutes = minutes;
    state.startedAt = startedAt;
    state.writingEndsAt = startedAt + minutes * 60 * 1000;
    state.graceEndsAt = state.writingEndsAt + 20 * 1000;
    state.revealAt = state.graceEndsAt + 5 * 1000;
    state.phase = 'writing';
    state.report = null;
    state.analysisModel = null;
    state.analysisCreatedAt = null;
    for (const p of Object.values(state.participants)) for (const t of (p.tickets || [])) t.topic = null;
    saveState(true);
    return json(res, 200, { ok: true, state: publicState() });
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    state = emptySession();
    saveState(true);
    return json(res, 200, { ok: true, sessionId: state.sessionId });
  }

  if (req.method === 'GET' && pathname === '/api/models') {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/models');
      if (!r.ok) throw new Error(`OpenRouter models returned ${r.status}`);
      const body = await r.json();
      const models = (body.data || [])
        .filter(m => /nemotron\s*3/i.test(m.name || '') || /nemotron-3/i.test(m.id || ''))
        .filter(m => !/embed|rerank|asr/i.test(`${m.id} ${m.name}`))
        .map(m => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { models });
    } catch (err) {
      console.error('Could not load OpenRouter models:', err.message);
      return json(res, 200, {
        models: [
          { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'NVIDIA: Nemotron 3 Super 120B A12B' },
          { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'NVIDIA: Nemotron 3 Nano Omni (free)' }
        ],
        fallback: true
      });
    }
  }

  if (req.method === 'GET' && pathname === '/api/export.json') {
    const exportData = {
      session: {
        sessionId: state.sessionId,
        createdAt: state.createdAt,
        phase: state.phase,
        durationMinutes: state.durationMinutes,
        startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
        writingEndsAt: state.writingEndsAt ? new Date(state.writingEndsAt).toISOString() : null,
        participantCount: Object.keys(state.participants).length
      },
      tickets: getAllTickets({ includeNames: true }),
      report: state.report,
      analysisModel: state.analysisModel,
      analysisCreatedAt: state.analysisCreatedAt
    };
    return text(res, 200, JSON.stringify(exportData, null, 2), 'application/json; charset=utf-8', {
      'Content-Disposition': `attachment; filename="ai-opinions-${state.sessionId}.json"`
    });
  }

  if (req.method === 'GET' && pathname === '/api/report.md') {
    if (!state.report) return text(res, 404, 'No analysis report has been generated yet.');
    return text(res, 200, state.report, 'text/markdown; charset=utf-8', {
      'Content-Disposition': `attachment; filename="ai-opinions-report-${state.sessionId}.md"`
    });
  }

  if (req.method === 'POST' && pathname === '/api/analyze') {
    advanceTimer();
    if (state.phase !== 'results') return json(res, 400, { error: 'Analysis is available after the board is revealed.' });
    const payload = await readBody(req);
    const apiKey = String(payload.apiKey || '').trim();
    const model = String(payload.model || '').trim();
    if (!apiKey) return json(res, 400, { error: 'OpenRouter API key is required.' });
    if (!model) return json(res, 400, { error: 'Select a model.' });

    const tickets = getAllTickets({ includeNames: false });
    if (!tickets.length) return json(res, 400, { error: 'There are no submitted tickets.' });

    const prompt = `You are analyzing an anonymous classroom sprint-retrospective about students' opinions on AI.\n\nEvery ticket has:\n- id: stable identifier\n- text: the student's opinion\n- impact: -5 (very negative AI impact) to +5 (very positive AI impact)\n- importance: 1 to 5, where 5 is most important to that student\n\nTasks:\n1. Assign EACH ticket exactly one concise topic label (2-5 words). Prefer consistent labels across similar tickets.\n2. Write a concise Markdown report for a classroom discussion. Include:\n   - Main takeaways\n   - What stood out\n   - Major opportunities / positive expectations\n   - Major concerns / negative expectations\n   - Tensions or disagreements in the class\n   - 5 discussion questions\n3. Weight high-importance tickets more heavily, but do not imply statistical certainty from this small group.\n4. Do not identify or infer individual students.\n\nReturn ONLY valid JSON in this exact shape:\n{\n  "ticketTopics": [{"id":"ticket-id","topic":"short label"}],\n  "reportMarkdown":"# AI Opinion Retro — Class Analysis\\n..."\n}\n\nTickets:\n${JSON.stringify(tickets)}`;

    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': req.headers.origin || `http://localhost:${PORT}`,
          'X-Title': 'AI Opinion Retro'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Return strict JSON only. Do not include markdown fences around the JSON.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.25
        })
      });
      const body = await r.json();
      if (!r.ok) {
        const message = body?.error?.message || `OpenRouter returned HTTP ${r.status}`;
        return json(res, r.status, { error: message });
      }
      const content = body?.choices?.[0]?.message?.content;
      const parsed = extractJson(content);
      const topicMap = new Map((parsed.ticketTopics || []).map(x => [String(x.id), String(x.topic || '').slice(0, 40)]));
      for (const p of Object.values(state.participants)) {
        for (const t of (p.tickets || [])) if (topicMap.has(t.id)) t.topic = topicMap.get(t.id);
      }
      state.report = String(parsed.reportMarkdown || '').trim();
      state.analysisModel = model;
      state.analysisCreatedAt = new Date().toISOString();
      saveState(true);
      return json(res, 200, { ok: true, report: state.report, model });
    } catch (err) {
      console.error('Analysis failed:', err);
      return json(res, 500, { error: err.message || 'Analysis failed.' });
    }
  }

  return json(res, 404, { error: 'Not found.' });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return text(res, 403, 'Forbidden');

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      const index = path.join(PUBLIC_DIR, 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      fs.createReadStream(index).pipe(res);
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message || 'Internal server error.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Opinion Retro running at http://localhost:${PORT}`);
});
