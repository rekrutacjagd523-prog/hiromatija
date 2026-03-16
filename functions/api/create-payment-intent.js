export async function onRequest(context) {
  const { request, env } = context;

  const origin = request.headers.get('Origin') || '';
  const allowed = ['https://hiromatija.pages.dev', 'http://localhost:8788', 'http://localhost:3000'];
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });

  const stripeSecret = env.STRIPE_SECRET_KEY;
  if (!stripeSecret) {
    return new Response(JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Create PaymentIntent via Stripe API
  const params = new URLSearchParams({
    amount: '299',          // $2.99 in cents
    currency: 'usd',
    'automatic_payment_methods[enabled]': 'true',
    description: 'Palm reading — Hiromatija',
  });

  let stripeResp;
  try {
    stripeResp = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + stripeSecret,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Stripe unreachable' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const data = await stripeResp.json();
  if (!stripeResp.ok) {
    return new Response(JSON.stringify({ error: data.error?.message || 'Stripe error' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ client_secret: data.client_secret }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
