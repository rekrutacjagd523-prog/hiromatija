export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { prompt, image, image_type } = body;
  if (!prompt) return new Response(JSON.stringify({ error: 'prompt required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image } });
  content.push({ type: 'text', text: prompt });

  const messages = [
    { role: 'user', content },
    { role: 'assistant', content: '{"fate_message":"' }
  ];

  let claudeResp;
  try {
    claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 3000,  // increased from 1400
        temperature: 1.0,
        messages
      })
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'upstream error', detail: String(e) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  if (!claudeResp.ok) {
    const errText = await claudeResp.text().catch(() => '');
    return new Response(JSON.stringify({ error: 'claude_error', status: claudeResp.status, detail: errText }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const claudeJson = await claudeResp.json();
  const rawText = claudeJson.content.map(b => b.text || '').join('');
  const fullJson = '{"fate_message":"' + rawText;

  function sanitizeJson(str) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { esc = true; out += c; continue; }
      if (c === '"') { inStr = !inStr; out += c; continue; }
      if (inStr) {
        if (c === '\n' || c === '\r' || c === '\t') { out += ' '; continue; }
        if (c.charCodeAt(0) < 0x20) { out += ' '; continue; }
      }
      out += c;
    }
    return out;
  }

  const sanitized = sanitizeJson(fullJson);

  let parsed;
  try {
    parsed = JSON.parse(sanitized);
  } catch (e) {
    const lastBrace = sanitized.lastIndexOf('}');
    if (lastBrace > 0) {
      try { parsed = JSON.parse(sanitized.slice(0, lastBrace + 1)); }
      catch { return new Response(JSON.stringify({ error: 'parse_failed', raw: sanitized.slice(0, 600) }), { status: 422, headers: { 'Content-Type': 'application/json' } }); }
    } else {
      return new Response(JSON.stringify({ error: 'parse_failed', raw: sanitized.slice(0, 600) }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  });
}
