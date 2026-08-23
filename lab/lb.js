// Minimal native round-robin load balancer for the perf lab.
// Runs directly on the Windows host so the request path never crosses the
// Docker Desktop/WSL2 network boundary (which was found to collapse under
// high connection counts when nginx ran containerized).
// Usage: node lb.js   (listens on 9020, balances across 9000/9002/9003)
const http = require('http');

const targets = (process.env.TARGETS || "9000").split(",").map(Number);
let i = 0;

const agent = new http.Agent({ keepAlive: true, maxSockets: 4096 });

const server = http.createServer((req, res) => {
  const port = targets[i++ % targets.length];
  const proxy = http.request(
    { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers, agent },
    (pRes) => {
      res.writeHead(pRes.statusCode, pRes.headers);
      pRes.pipe(res);
    }
  );
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxy);
});

server.maxConnections = 20000;
server.listen(9020, () => console.log('LB on 9020 -> ' + targets.join(',')));
