import Stripe from 'https://esm.sh/stripe@14?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401, headers: CORS });

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': authHeader, 'apikey': SUPABASE_SERVICE_KEY },
  });
  const userData = await userRes.json();
  const userId: string = userData?.id;
  if (!userId) return new Response('Unauthorized', { status: 401, headers: CORS });

  const subRes = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=stripe_subscription_id&limit=1`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const subRows = await subRes.json();
  const subscriptionId = subRows[0]?.stripe_subscription_id;
  if (!subscriptionId) return new Response('No subscription found', { status: 404, headers: CORS });

  await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
