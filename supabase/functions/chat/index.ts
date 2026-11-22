const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Nachrichten-Limits (nur echte Chat-Nachrichten / streaming)
const ANON_LIMIT = 3;       // Gäste: 3 Fragen, dann Konto nötig
const EASY_LIMIT = 150;     // Mentor Easy: 150 / Monat
// Intensiv + laufender 7-Tage-Trial = unbegrenzt; abgelaufener Trial = gesperrt

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

// Serverseitige Limit-Prüfung: identifiziert den User, ermittelt Tarif + Zähler,
// blockiert bei Überschreitung und zählt sonst hoch. Gibt null zurück = erlaubt.
async function checkAndCountLimit(authHeader: string | null): Promise<{ reason: string } | null> {
  try {
    if (!authHeader) return { reason: 'unauthorized' };
    // 1) User aus Token
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: ANON_KEY } });
    if (!uRes.ok) return { reason: 'unauthorized' };
    const u = await uRes.json();
    const uid: string = u?.id;
    if (!uid) return { reason: 'unauthorized' };
    const isAnon = !!u.is_anonymous;
    const createdAt = new Date(u.created_at).getTime();
    const now = Date.now();

    // 2) Abo
    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${uid}&select=status,plan,current_period_end&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const sub = (await sRes.json())?.[0];
    const active = sub?.status === 'active' && sub?.current_period_end && new Date(sub.current_period_end).getTime() > now;

    // 3) Limit bestimmen (null = unbegrenzt)
    let limit: number | null;
    if (isAnon) {
      limit = ANON_LIMIT;
    } else if (active && sub.plan === 'intensiv') {
      limit = null;
    } else if (active && sub.plan === 'easy') {
      limit = EASY_LIMIT;
    } else if (active) {
      limit = null; // aktives Abo ohne bekannten Plan → durchlassen
    } else {
      // kein aktives Abo → Trial-Fenster prüfen
      const trialEnd = createdAt + 7 * 24 * 3600 * 1000;
      if (now <= trialEnd) limit = null; // laufender Trial = voller Zugang
      else return { reason: 'trial_expired' };
    }

    // 4) Zähler lesen (für begrenzte Tarife) + hochzählen
    const cRes = await fetch(`${SUPABASE_URL}/rest/v1/chat_sessions?user_id=eq.${uid}&select=period_count,period_start&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const row = (await cRes.json())?.[0];
    let periodCount = row?.period_count || 0;
    let periodStart = row?.period_start ? new Date(row.period_start).getTime() : 0;

    // Monatsfenster zurücksetzen (nicht bei anon — dort ist es ein Lifetime-Zähler)
    if (!isAnon && (!periodStart || now - periodStart > 30 * 24 * 3600 * 1000)) {
      periodCount = 0; periodStart = now;
    }

    if (limit !== null && periodCount >= limit) {
      return { reason: isAnon ? 'anon' : 'monthly' };
    }

    // hochzählen (upsert über user_id)
    await fetch(`${SUPABASE_URL}/rest/v1/chat_sessions?on_conflict=user_id`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: uid, period_count: periodCount + 1, period_start: new Date(periodStart || now).toISOString() }),
    });
    return null; // erlaubt
  } catch {
    return null; // im Zweifel durchlassen (keine User-Blockade bei Infra-Fehler)
  }
}

// Globalen LLM-Provider aus app_settings lesen (Default: claude)
async function getProvider(): Promise<'claude' | 'gemini'> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?select=llm_provider&id=eq.1`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
    });
    const rows = await r.json();
    return rows?.[0]?.llm_provider === 'gemini' ? 'gemini' : 'claude';
  } catch {
    return 'claude';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const streaming = body.stream === true;

  // Nur echte Chat-Nachrichten (streaming) limitieren; interne Calls (Zusammenfassung) nicht
  if (streaming) {
    const limited = await checkAndCountLimit(req.headers.get('Authorization'));
    if (limited) {
      return new Response(JSON.stringify({ error: 'limit_reached', reason: limited.reason }), {
        status: 429, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  const provider = await getProvider();

  // ── GEMINI ──
  if (provider === 'gemini' && GEMINI_API_KEY) {
    const msgs = (body.messages as Array<{ role: string; content: string }>) || [];
    const contents = msgs.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const geminiBody: Record<string, unknown> = {
      contents,
      generationConfig: {
        // großzügiges Limit + Thinking aus, damit die Antwort nicht abgeschnitten wird
        maxOutputTokens: Math.max((body.max_tokens as number) || 1024, 8192),
        thinkingConfig: { thinkingBudget: 0 },
      },
      // Sicherheitsfilter aus — sonst bricht Gemini bei sensiblen Trennungs-/Krisenthemen
      // mitten in der Antwort ab. Die Krisen-Logik steckt in unserem System-Prompt.
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    };
    if (body.system) geminiBody.system_instruction = { parts: [{ text: body.system as string }] };

    if (!streaming) {
      try {
        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) },
        );
        if (gRes.ok) {
          const data = await gRes.json();
          const text = (data?.candidates?.[0]?.content?.parts || [])
            .filter((p: { thought?: boolean }) => !p.thought)
            .map((p: { text?: string }) => p.text || '').join('');
          if (text) {
            // Antwort im Anthropic-Format zurückgeben, damit der Client unverändert bleibt
            return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
              headers: { ...CORS, 'Content-Type': 'application/json' },
            });
          }
        }
      } catch { /* Gemini-Fehler → unten auf Claude zurückfallen */ }
      // Fällt durch zu Claude (z. B. bei 429 Rate-Limit oder leerer Antwort)
    } else {
    // Streaming: Gemini-SSE in Anthropic-SSE (content_block_delta) übersetzen
    const gRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) },
    );
    if (gRes.ok && gRes.body) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = gRes.body!.getReader();
    let buffer = '';
    const out = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'content_block_stop' })}\n\n`));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const parts = j?.candidates?.[0]?.content?.parts || [];
            const text = parts
              .filter((p: { thought?: boolean }) => !p.thought)
              .map((p: { text?: string }) => p.text || '').join('');
            if (text) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`,
              ));
            }
          } catch { /* Teilzeile, ignorieren */ }
        }
      },
      cancel() { reader.cancel(); },
    });
    return new Response(out, {
      status: gRes.status,
      headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
    });
    }
    // Gemini-Stream fehlgeschlagen (z. B. 429 Rate-Limit) → unten auf Claude zurückfallen
    }
  }

  // ── CLAUDE (Default / Fallback) ──
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'X-Api-Key': ANTHROPIC_API_KEY,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ ...body, stream: streaming }),
  });

  if (!streaming) {
    const data = await anthropicRes.json();
    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(anthropicRes.body, {
    status: anthropicRes.status,
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});
