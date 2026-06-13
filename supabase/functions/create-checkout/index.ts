import Stripe from 'https://esm.sh/stripe@14?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401, headers: CORS });

  // Get user from JWT
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': authHeader, 'apikey': SUPABASE_SERVICE_KEY },
  });
  const userData = await userRes.json();
  const userId: string = userData?.id;
  const userEmail: string = userData?.email;
  if (!userId) return new Response('Unauthorized', { status: 401, headers: CORS });

  // Check for existing Stripe customer
  const subRes = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=stripe_customer_id&limit=1`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const subRows = await subRes.json();
  let customerId: string;

  if (subRows[0]?.stripe_customer_id) {
    customerId = subRows[0].stripe_customer_id;
  } else {
    const customer = await stripe.customers.create({ email: userEmail, metadata: { user_id: userId } });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    client_reference_id: userId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: {
          name: 'Scheidungsmentor – Monatliches Abo',
          description: 'Unbegrenzter Zugang zu deinem persönlichen Mentor',
        },
        unit_amount: 1900,
        recurring: { interval: 'month' },
      },
      quantity: 1,
    }],
    success_url: 'https://scheidungsmentor.de/index.html?subscribed=1',
    cancel_url: 'https://scheidungsmentor.de/index.html',
    locale: 'de',
  });

  return new Response(JSON.stringify({ url: session.url }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
