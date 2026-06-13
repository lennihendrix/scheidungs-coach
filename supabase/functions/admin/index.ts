// Admin-Funktion: listet alle User, löscht und upgradet Accounts.
// Zugriff nur für ADMIN_EMAIL — serverseitig erzwungen.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ADMIN_EMAIL = 'h.lennarz+test@gmail.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function svc(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  // 1) Anfragenden User verifizieren
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': authHeader, 'apikey': ANON_KEY },
  });
  const me = await userRes.json();
  if (!me?.email || me.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    return json({ error: 'Forbidden — kein Admin' }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action as string;

  // ── LIST: alle User mit Metriken ──
  if (action === 'list') {
    // alle Auth-User (paginiert, bis 1000)
    const usersRes = await svc('/auth/v1/admin/users?per_page=1000');
    const usersData = await usersRes.json();
    const users = usersData.users || [];

    // alle chat_sessions + subscriptions
    const csRes = await svc('/rest/v1/chat_sessions?select=user_id,messages,message_count,updated_at');
    const sessions = await csRes.json();
    const subRes = await svc('/rest/v1/subscriptions?select=user_id,status,current_period_end');
    const subs = await subRes.json();

    const now = Date.now();
    const d7 = now - 7 * 24 * 3600 * 1000;
    const d1 = now - 24 * 3600 * 1000;

    const sessByUser: Record<string, any> = {};
    for (const s of sessions) sessByUser[s.user_id] = s;
    const subByUser: Record<string, any> = {};
    for (const s of subs) subByUser[s.user_id] = s;

    const rows = users.map((u: any) => {
      const sess = sessByUser[u.id];
      const msgs: any[] = Array.isArray(sess?.messages) ? sess.messages : [];
      // message_count = echte Gesamtzahl (unabhängig vom 60er-Cap); Fallback auf Array-Länge
      let total = (typeof sess?.message_count === 'number') ? sess.message_count : msgs.length;
      let last7 = 0, last24 = 0;
      for (const m of msgs) {
        if (m.ts) {
          const t = new Date(m.ts).getTime();
          if (!isNaN(t)) {
            if (t >= d7) last7++;
            if (t >= d1) last24++;
          }
        }
      }
      const sub = subByUser[u.id];
      let membership = 'trial';
      if (sub?.status === 'active' && sub?.current_period_end && new Date(sub.current_period_end).getTime() > now) {
        membership = 'active';
      } else if (sub?.status) {
        membership = sub.status; // past_due, canceled, ...
      } else {
        // kein Sub-Eintrag → Trial-Check anhand created_at (7 Tage)
        const trialEnd = new Date(u.created_at).getTime() + 7 * 24 * 3600 * 1000;
        membership = now <= trialEnd ? 'trial' : 'expired';
      }
      return {
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        membership,
        msgTotal: total,
        msg7d: last7,
        msg24h: last24,
        lastActive: sess?.updated_at || null,
      };
    });

    rows.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return json({ users: rows, adminEmail: ADMIN_EMAIL });
  }

  // ── DELETE: User löschen (chat_sessions/subscriptions via FK cascade) ──
  if (action === 'delete') {
    const targetId = body.user_id as string;
    if (!targetId) return json({ error: 'user_id fehlt' }, 400);
    const delRes = await svc(`/auth/v1/admin/users/${targetId}`, { method: 'DELETE' });
    if (!delRes.ok) return json({ error: 'Löschen fehlgeschlagen', detail: await delRes.text() }, 500);
    return json({ ok: true });
  }

  // ── UPGRADE: kostenlos auf Paid setzen (1 Jahr) ──
  if (action === 'upgrade') {
    const targetId = body.user_id as string;
    if (!targetId) return json({ error: 'user_id fehlt' }, 400);
    const periodEnd = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const upRes = await svc('/rest/v1/subscriptions?on_conflict=user_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: targetId,
        status: 'active',
        current_period_end: periodEnd,
        stripe_customer_id: 'admin_comp',
        stripe_subscription_id: 'admin_comp',
        updated_at: new Date().toISOString(),
      }),
    });
    if (!upRes.ok) return json({ error: 'Upgrade fehlgeschlagen', detail: await upRes.text() }, 500);
    return json({ ok: true });
  }

  return json({ error: 'Unbekannte Aktion' }, 400);
});
