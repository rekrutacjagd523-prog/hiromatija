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

  // Ask Claude to respond with JSON only, no markdown, no extra text
  // Add a prefill to force JSON start
  const messages = [
    { role: 'user', content },
    { role: 'assistant', content: '{' }  // prefill forces Claude to start JSON immediately
  ];

  let claudeResp;
  try {
    claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1400, temperature: 1.0, messages })
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
  
  // Since we prefilled '{', the full JSON is '{' + rawText
  const fullJson = '{' + rawText;

  let parsed;
  try {
    parsed = JSON.parse(fullJson);
  } catch (e) {
    // Fallback: find { ... } boundaries
    const start = fullJson.indexOf('{');
    const end   = fullJson.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return new Response(JSON.stringify({ error: 'no_json', raw: fullJson.slice(0, 400) }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    }
    try {
      parsed = JSON.parse(fullJson.slice(start, end + 1));
    } catch {
      return new Response(JSON.stringify({ error: 'parse_failed', raw: fullJson.slice(0, 400) }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  });
}
