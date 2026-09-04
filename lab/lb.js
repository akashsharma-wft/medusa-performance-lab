// Round-robin load balancer for the perf lab.
//
// TARGETS is a comma-separated list of host:port (or bare port, meaning
// 127.0.0.1). Inside the lab network the targets are container names:
//   TARGETS=mpl-app1:9000,mpl-app2:9000 node lb.js
//
// A native Node proxy rather than containerised nginx: in the July runs the
// nginx container collapsed under high connection counts, which turned out to
// be the Windows/WSL2 network boundary rather than nginx itself. Keeping the
// balancer inside the lab network avoids that class of problem entirely.
const http = require('http');

const targets = (process.env.TARGETS || '9000').split(',').map((t) => {
  const s = t.trim();
  return s.includes(':')
    ? { host: s.split(':')[0], port: Number(s.split(':')[1]) }
    : { host: '127.0.0.1', port: Number(s) };
});

const PORT = Number(process.env.LB_PORT || 9020);
let i = 0;

const agent = new http.Agent({ keepAlive: true, maxSockets: 8192, maxFreeSockets: 512 });

const server = http.createServer((req, res) => {
  const t = targets[i++ % targets.length];
  const proxy = http.request(
    { host: t.host, port: t.port, path: req.url, method: req.method, headers: req.headers, agent },
    (pRes) => {
      res.writeHead(pRes.statusCode, pRes.headers);
      pRes.pipe(res);
    }
  );
  proxy.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'lb_upstream', detail: e.code }));
  });
  req.pipe(proxy);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.maxConnections = 20000;
server.listen(PORT, () =>
  console.log(`LB on ${PORT} -> ${targets.map((t) => `${t.host}:${t.port}`).join(', ')}`)
);
