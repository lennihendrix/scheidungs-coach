const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

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
