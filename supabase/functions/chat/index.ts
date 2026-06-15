const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

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
      generationConfig: { maxOutputTokens: (body.max_tokens as number) || 1024 },
    };
    if (body.system) geminiBody.system_instruction = { parts: [{ text: body.system as string }] };

    if (!streaming) {
      const gRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) },
      );
      const data = await gRes.json();
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('');
      // Antwort im Anthropic-Format zurückgeben, damit der Client unverändert bleibt
      return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
        status: gRes.ok ? 200 : gRes.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Streaming: Gemini-SSE in Anthropic-SSE (content_block_delta) übersetzen
    const gRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) },
    );
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
            const text = parts.map((p: { text?: string }) => p.text || '').join('');
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

  // ── CLAUDE (Default) ──
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
