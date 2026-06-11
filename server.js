import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env'), override: true });
const app = express();

// Resolve auth: prefer ANTHROPIC_API_KEY, fall back to Claude Code OAuth token
function getAuth() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { header: 'X-Api-Key', value: process.env.ANTHROPIC_API_KEY };
  }
  try {
    const creds = JSON.parse(readFileSync(resolve(homedir(), '.claude/.credentials.json'), 'utf8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (token) return { header: 'Authorization', value: `Bearer ${token}`, beta: 'oauth-2025-04-20' };
  } catch {}
  throw new Error('No API key found. Set ANTHROPIC_API_KEY in .env');
}

const BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

async function callAPI(body) {
  const auth = getAuth();
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    [auth.header]: auth.value,
  };
  if (auth.beta) headers['anthropic-beta'] = auth.beta;

  return fetch(`${BASE_URL}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
}

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

function buildSystemPrompt(profile) {
  const gender = profile.gender === 'male' ? 'Mann' : 'Frau';
  const status = {
    'trennung': 'in der Trennungsphase',
    'ausgezogen': 'bereits ausgezogen',
    'scheidung': 'im laufenden Scheidungsverfahren',
    'geschieden': 'bereits geschieden'
  }[profile.status] || 'in einer Trennungssituation';

  const since = profile.since ? `seit ${profile.since}` : '';
  const children = profile.children === 'yes'
    ? `hat ${profile.childrenCount || 'ein oder mehrere'} Kind(er)`
    : 'hat keine Kinder';

  return `Du bist ein einfühlsamer, professioneller Scheidungs-Coach. Du hilfst Menschen dabei, die emotionalen, praktischen und rechtlichen Herausforderungen einer Trennung oder Scheidung zu bewältigen.

Über den Nutzer:
- Geschlecht: ${gender}
- Situation: ${status}${since ? ', ' + since : ''}
- Kinder: ${children}
${profile.concerns?.length ? `- Hauptanliegen: ${Array.isArray(profile.concerns) ? profile.concerns.join(', ') : profile.concerns}` : ''}

Deine Rolle:
- Sei empathisch, verständnisvoll und unterstützend
- Gib praktische, konkrete Ratschläge
- Beachte die spezifische Situation des Nutzers
- Weise bei rechtlichen Fragen auf die Notwendigkeit eines Anwalts hin
- Antworte auf Deutsch, klar und in angemessener Länge
- Fasse dich nicht zu kurz aber auch nicht zu lang (2-5 Sätze für einfache Fragen, mehr wenn nötig)
- Duze den Nutzer IMMER — niemals siezen, kein "Sie" oder "Ihnen"

Wichtig: Du bist kein Anwalt und kein Therapeut. Bei ernsten psychischen Krisen oder komplexen Rechtsfragen weise auf professionelle Hilfe hin.`;
}

app.post('/api/chat', async (req, res) => {
  const { messages, profile } = req.body;
  if (!messages || !profile) return res.status(400).json({ error: 'Missing messages or profile' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const apiRes = await callAPI({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      stream: true,
      system: buildSystemPrompt(profile),
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    });

    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
          } else if (event.type === 'error') {
            res.write(`data: ${JSON.stringify({ error: event.error?.message || 'API-Fehler' })}\n\n`);
          }
        } catch {}
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.post('/api/suggestions', async (req, res) => {
  const { messages, profile } = req.body;

  const gender = profile.gender === 'male' ? 'Mann' : 'Frau';
  const status = {
    'trennung': 'Trennungsphase',
    'ausgezogen': 'ausgezogen',
    'scheidung': 'Scheidungsverfahren',
    'geschieden': 'geschieden'
  }[profile.status] || 'Trennung';
  const children = profile.children === 'yes' ? 'mit Kindern' : 'ohne Kinder';
  const recentContext = messages.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');

  try {
    const apiRes = await callAPI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Generiere 5 kurze, relevante Fragen (max. 8 Wörter je Frage) für einen ${gender} in der ${status} ${children}.

Bisheriger Chatverlauf:
${recentContext || '(noch kein Chat)'}

Gib NUR die 5 Fragen aus, eine pro Zeile, ohne Nummerierung oder Erklärungen. Fragen sollen zum Kontext passen und noch nicht besprochene Themen abdecken. Nutze immer die Du-Form (duzen), niemals Sie.`
      }]
    });

    const data = await apiRes.json();
    const suggestions = (data.content?.[0]?.text || '')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 5 && s.length < 80)
      .slice(0, 5);

    res.json({ suggestions });
  } catch (err) {
    console.error(err);
    res.json({ suggestions: [] });
  }
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`Scheidungs-Coach läuft auf http://localhost:${PORT}`));
