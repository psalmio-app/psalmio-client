const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempFile(bytes, fill = 7) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'psalmio-test-')), 'aufnahme.mp4');
  fs.writeFileSync(file, Buffer.alloc(bytes, fill));
  return file;
}

/** Ein echter Server auf localhost; `run` bekommt eine Adresse wie eine vorsignierte. */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(`${origin}/bucket/obj?sig=abc`, origin);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

module.exports = { tempFile, withServer, readBody };
