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

  // Reconstruct full JSON with our prefill
  const fullJson = '{"fate_message":"' + rawText;

  // Clean up: replace literal newlines inside JSON string values with spaces
  // We need to be careful - only replace newlines that are INSIDE string values
  // Strategy: parse char by char tracking if we're inside a string
  function cleanJson(str) {
    let result = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (escape) {
        result += ch;
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        result += ch;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        result += ch;
        continue;
      }
      if (inString && (ch === '\n' || ch === '\r')) {
        result += ' ';
        continue;
      }
      result += ch;
    }
    return result;
  }

  const cleaned = cleanJson(fullJson);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Last resort: find boundaries and try again
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try { parsed = JSON.parse(cleaned.slice(start, end + 1)); }
      catch { return new Response(JSON.stringify({ error: 'parse_failed', raw: cleaned.slice(0, 500) }), { status: 422, headers: { 'Content-Type': 'application/json' } }); }
    } else {
      return new Response(JSON.stringify({ error: 'parse_failed', raw: cleaned.slice(0, 500) }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  });
}
