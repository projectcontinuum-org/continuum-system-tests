// Streaming reverse proxy for the UI suites (no response buffering, so the run viewer's live updates work).
//   node suites/ui/proxy.mjs            # listens on 3013 (PROXY_PORT), forwards to the workbench (WORKBENCH_UPSTREAM, default
//                                       # http://127.0.0.1:3003); /api-server/* -> API_SERVER_URL, /credentials-server/* -> CREDENTIALS_URL
// Then run a suite with: WORKBENCH_URL=http://127.0.0.1:3013 PASSTHROUGH=1 node suites/ui/loops-dialog.mjs
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PROXY_PORT || 3013);
const WB = new URL(process.env.WORKBENCH_UPSTREAM || 'http://127.0.0.1:3003');
const API = new URL(process.env.API_SERVER_URL || 'http://127.0.0.1:8080');
const CRED = new URL(process.env.CREDENTIALS_URL || 'http://127.0.0.1:8083');
const MQTT = new URL(process.env.MQTT_WS_URL || 'http://127.0.0.1:31884'); // mosquitto WebSocket listener, served at /mqtt (the viewer's live updates)

function route(url) {
  if (/^\/mqtt(\?|$|\/)/.test(url)) return { t: MQTT, path: url };
  const m = url.match(/^\/(api-server|credentials-server)(\/.*)?$/);
  if (m) return { t: m[1] === 'api-server' ? API : CRED, path: m[2] || '/' };
  return { t: WB, path: url };
}

const server = http.createServer((req, res) => {
  const { t, path } = route(req.url);
  const headers = { ...req.headers, host: t.host };
  delete headers.origin; delete headers.referer;
  const up = http.request({ host: t.hostname, port: t.port, path, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res); // streamed, never buffered
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  if (process.env.PROXY_DEBUG) console.log('upgrade', req.url);
  const { t, path } = route(req.url);
  const up = net.connect(Number(t.port), t.hostname, () => {
    up.write(`${req.method} ${path} HTTP/1.1\r\n` + Object.entries({ ...req.headers, host: t.host }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on('data', (d) => { if (process.env.PROXY_DEBUG) console.log('up<-', d.toString().slice(0, 120)); });
  up.on('error', (e) => { if (process.env.PROXY_DEBUG) console.log('uperr', e.message); socket.destroy(); }); socket.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`proxy on ${PORT}`));
