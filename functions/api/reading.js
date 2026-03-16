export async function onRequest(context) {
  const { request, env } = context;

  // ── CORS ──
  const origin = request.headers.get('Origin') || '';
  const allowed = ['https://hiromatija.pages.dev', 'http://localhost:8788', 'http://localhost:3000'];
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];

  const corsHeaders = {
    'Access-Control-Allow-Origin':  corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  // ── RATE LIMIT via IP (Cloudflare KV — optional, graceful skip if not bound) ──
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // ── API KEY ──
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // ── PARSE BODY ──
  let body;
  try {
    // Limit raw body size to 6MB to prevent abuse
    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (contentLength > 6 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'Payload too large. Max 6MB.' }), {
        status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const { prompt, image, image_type } = body;

  // ── VALIDATE PROMPT ──
  if (!prompt || typeof prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'prompt is required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  if (prompt.length > 8000) {
    return new Response(JSON.stringify({ error: 'prompt too long' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // ── VALIDATE IMAGE ──
  if (image !== undefined) {
    if (typeof image !== 'string') {
      return new Response(JSON.stringify({ error: 'image must be base64 string' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // base64 of 5MB = ~6.8M chars
    if (image.length > 7 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'Image too large. Max 5MB.' }), {
        status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (image_type && !validTypes.includes(image_type)) {
      return new Response(JSON.stringify({ error: 'Invalid image type' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  // ── BUILD CLAUDE REQUEST ──
  const content = [];
  if (image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image }
    });
  }
  content.push({ type: 'text', text: prompt });

  const messages = [
    { role: 'user', content },
    { role: 'assistant', content: '{"fate_message":"' }
  ];

  // ── CALL CLAUDE ──
  let claudeResp;
  try {
    claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 3000,
        temperature: 1.0,
        messages
      })
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream unreachable', detail: String(e) }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!claudeResp.ok) {
    const errText = await claudeResp.text().catch(() => '');
    // Don't leak internal details to client
    console.error('Claude error', claudeResp.status, errText);
    return new Response(JSON.stringify({ error: 'Reading service unavailable', status: claudeResp.status }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const claudeJson = await claudeResp.json();
  const rawText = claudeJson.content.map(b => b.text || '').join('');
  const fullJson = '{"fate_message":"' + rawText;

  // ── SANITIZE & PARSE JSON ──
  function sanitizeJson(str) {
    let out = '', inStr = false, esc = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { esc = true; out += c; continue; }
      if (c === '"') { inStr = !inStr; out += c; continue; }
      if (inStr && (c === '\n' || c === '\r' || c === '\t')) { out += ' '; continue; }
      if (inStr && c.charCodeAt(0) < 0x20) { out += ' '; continue; }
      out += c;
    }
    return out;
  }

  const sanitized = sanitizeJson(fullJson);
  let parsed;
  try {
    parsed = JSON.parse(sanitized);
  } catch {
    const last = sanitized.lastIndexOf('}');
    if (last > 0) {
      try { parsed = JSON.parse(sanitized.slice(0, last + 1)); }
      catch { return new Response(JSON.stringify({ error: 'parse_failed' }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
    } else {
      return new Response(JSON.stringify({ error: 'parse_failed' }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }
  });
}
