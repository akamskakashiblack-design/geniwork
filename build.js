const fs = require('fs');
const version = Date.now();
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace(/\?v=\d+/g, '?v=' + version);
fs.writeFileSync('index.html', html);
console.log('[Build] Version cache-busting →', version);
