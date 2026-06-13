const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const { user_id, profile, messages } = await req.json();
  if (!user_id) return new Response('missing user_id', { status: 400, headers: CORS });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const res = await fetch(`${supabaseUrl}/rest/v1/chat_sessions?on_conflict=user_id`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ user_id, profile, messages, updated_at: new Date().toISOString() }),
  });

  return new Response(res.ok ? 'ok' : await res.text(), {
    status: res.ok ? 200 : res.status,
    headers: { ...CORS, 'Content-Type': 'text/plain' },
  });
});
