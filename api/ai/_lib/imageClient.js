const https = require('https');

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

function generateImage({ prompt, size }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuree dans Vercel');

  const payload = JSON.stringify({
    model: IMAGE_MODEL,
    prompt,
    size: size || '1024x1024',
    n: 1,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            resolve(json.data[0].b64_json);
          } else {
            reject(new Error('OpenAI ' + resp.statusCode + ': ' + (json.error ? json.error.message : data)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { generateImage };
