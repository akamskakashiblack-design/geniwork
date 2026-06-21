const https = require('https');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function callLLMChat({ systemPrompt, messages, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configuree dans Vercel');

  const payload = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens || 2000,
    system: systemPrompt,
    messages,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
            resolve(text);
          } else {
            reject(new Error('Anthropic ' + resp.statusCode + ': ' + (json.error ? json.error.message : data)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { callLLMChat };
