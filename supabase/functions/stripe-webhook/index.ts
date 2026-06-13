import Stripe from 'https://esm.sh/stripe@14?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' });
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, stripe-signature' };

async function upsertSubscription(userId: string, data: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ user_id: userId, ...data, updated_at: new Date().toISOString() }),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const signature = req.headers.get('stripe-signature');
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, WEBHOOK_SECRET);
  } catch (e) {
    return new Response(`Webhook Error: ${(e as Error).message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.client_reference_id!;
    const subscriptionId = session.subscription as string;
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    await upsertSubscription(userId, {
      stripe_customer_id: session.customer as string,
      stripe_subscription_id: subscriptionId,
      status: 'active',
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    });
  }

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionId = invoice.subscription as string;
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const customer = await stripe.customers.retrieve(invoice.customer as string) as Stripe.Customer;
    const userId = customer.metadata?.user_id;
    if (userId) {
      await upsertSubscription(userId, {
        stripe_customer_id: invoice.customer as string,
        stripe_subscription_id: subscriptionId,
        status: 'active',
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
      });
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as Stripe.Invoice;
    const customer = await stripe.customers.retrieve(invoice.customer as string) as Stripe.Customer;
    const userId = customer.metadata?.user_id;
    if (userId) await upsertSubscription(userId, { status: 'past_due' });
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    const customer = await stripe.customers.retrieve(sub.customer as string) as Stripe.Customer;
    const userId = customer.metadata?.user_id;
    if (userId) await upsertSubscription(userId, { status: 'canceled' });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
