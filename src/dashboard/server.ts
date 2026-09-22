/**
 * Dashboard Server - Express + WebSocket server for real-time monitoring
 *
 * Usage:
 *   import { startDashboard } from './src/dashboard/server.js';
 *   startDashboard(3001);
 *   startDashboard({ port: 3001, host: '127.0.0.1', token: 'secret' });
 *
 * Security defaults: binds 127.0.0.1 (override with the `host` option or
 * DASHBOARD_HOST env) and ALWAYS requires a token on /api/* requests and the
 * WebSocket upgrade (which carries trading commands). The token comes from
 * the `token` option or DASHBOARD_TOKEN; when neither is set a random one is
 * generated for this run and printed once at startup. Browser WebSockets
 * cannot set headers, so the token rides the URL query:
 * ws://host:port/?token=... HTTP clients should prefer the
 * `Authorization: Bearer` header. Static files and /health stay open (the
 * app shell contains no data).
 *
 * When bound to a loopback address the Host header must also be a loopback
 * name, which blocks DNS-rebinding reads from a hostile web page.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { dashboardEmitter } from './state-emitter.js';
import type { WebSocketMessage } from './types.js';
import { loadHistory, getSession, getHistorySummary } from './session-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;

export interface DashboardOptions {
  port?: number;
  /** Bind address. Default 127.0.0.1 (localhost only). Use '0.0.0.0' to expose. */
  host?: string;
  /** Required on /api/* and the WebSocket upgrade. Random per-run token if omitted. */
  token?: string;
}

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MIN_TOKEN_LENGTH = 16;
/** Commands are tiny JSON objects; the ws default (100 MiB) is a memory-exhaustion vector. */
const MAX_WS_PAYLOAD = 64 * 1024;

function isLoopbackBind(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Hostname of a Host header value, without port ("[::1]:3001" -> "[::1]"). */
function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const h = hostHeader.toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/** Constant-time string compare (hashing first equalises lengths). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function broadcast(message: WebSocketMessage): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

export function startDashboard(options: number | DashboardOptions = 3001): http.Server {
  const port = typeof options === 'number' ? options : (options.port ?? 3001);
  const host = (typeof options === 'object' && options.host) || process.env.DASHBOARD_HOST || '127.0.0.1';
  const configuredToken = (typeof options === 'object' && options.token) || process.env.DASHBOARD_TOKEN || null;
  const tokenGenerated = !configuredToken;
  const token = configuredToken ?? randomBytes(24).toString('hex');
  const loopbackBind = isLoopbackBind(host);

  server = http.createServer((req, res) => {
    // Anti-DNS-rebinding: a page on evil.com that re-points its DNS at
    // 127.0.0.1 still sends `Host: evil.com`. Only enforced on loopback
    // binds; a deliberate LAN bind is guarded by the token alone.
    if (loopbackBind && !LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid Host header' }));
      return;
    }

    // The dashboard exposes panic-sell / mode-toggle buttons: refuse framing
    // (clickjacking), sniffing, and Referer leaks of the ?token= URL.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // CORS: reflect localhost origins only (dev on :5173 needs it); remote
    // origins get no CORS header at all instead of the old blanket '*'.
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN_RE.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // Auth: /api/* always requires the token. Static files and /health stay
    // open — the app shell has no data. Exact first-segment match (a
    // startsWith('/api/') gate would let lookalike paths through if future
    // routes are added). The Bearer header wins over the query param so
    // non-browser clients don't need to put the secret in a URL.
    if (url.pathname.split('/')[1] === 'api') {
      res.setHeader('Cache-Control', 'no-store');
      const provided = (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null)
        ?? url.searchParams.get('token');
      if (!provided) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Token required' }));
        return;
      }
      if (!tokenMatches(provided, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
        return;
      }
    }

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getFullData()));
      return;
    }

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getState()));
      return;
    }

    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getConfig()));
      return;
    }

    if (url.pathname === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getLogs()));
      return;
    }

    // History API endpoints
    if (url.pathname === '/api/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadHistory()));
      return;
    }

    if (url.pathname.startsWith('/api/history/')) {
      const sessionId = url.pathname.replace('/api/history/', '');
      const session = getSession(sessionId);
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // Serve static files from dashboard/dist
    const distPath = path.resolve(__dirname, '../../dashboard/dist');
    let filePath = path.join(distPath, url.pathname === '/' ? 'index.html' : url.pathname);

    // Check if file exists
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback - serve index.html for all other routes
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // v3.2 auth: manual upgrade so the token can be checked before the WS
  // handshake completes (browser WebSockets cannot send auth headers).
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    if (loopbackBind && !LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // Cross-site WS hijack guard: browsers always send Origin on WS; a page
    // on another site must not be able to open this socket and send
    // commands. Non-browser clients (no Origin) are allowed through this
    // check and rely on the token when one is configured.
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN_RE.test(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // Token is mandatory: this socket carries trading commands.
    const u = new URL(req.url || '/', `http://localhost:${port}`);
    const provided = u.searchParams.get('token');
    if (!provided || !tokenMatches(provided, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    console.log('[Dashboard] Client connected');

    // Send full state on connect
    ws.send(JSON.stringify({
      type: 'full',
      payload: dashboardEmitter.getFullData(),
    } as WebSocketMessage));

    // Handle incoming messages (commands)
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'command') {
          console.log(`[Dashboard] Command received: ${message.command}`, message.payload);
          dashboardEmitter.emit('command', { command: message.command, payload: message.payload });
        }
      } catch (e) {
        console.error('[Dashboard] Failed to parse message:', e);
      }
    });

    ws.on('close', () => {
      console.log('[Dashboard] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[Dashboard] WebSocket error:', err.message);
    });
  });

  // Subscribe to state changes
  dashboardEmitter.on('state', (state) => {
    broadcast({ type: 'state', payload: state });
  });

  dashboardEmitter.on('log', (entry) => {
    broadcast({ type: 'log', payload: entry });
  });

  dashboardEmitter.on('config', (config) => {
    broadcast({ type: 'config', payload: config });
  });

  server.listen(port, host, () => {
    const shownUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    console.log(`[Dashboard] Server running at ${shownUrl} (API/WS token required)`);
    if (tokenGenerated) {
      // Printed once to the console only — never logged through the
      // dashboard emitter, which would broadcast it to connected clients.
      console.log(`[Dashboard] Random token for this run — open: ${shownUrl}/?token=${token}`);
      console.log('[Dashboard] Set DASHBOARD_TOKEN in .env to use a fixed token instead.');
    } else {
      console.log('[Dashboard] Using DASHBOARD_TOKEN — open the URL with ?token=<your token> appended.');
      if (token.length < MIN_TOKEN_LENGTH) {
        console.log(`[Dashboard] ⚠️  Token is shorter than ${MIN_TOKEN_LENGTH} chars — use a long random string (e.g. \`openssl rand -hex 24\`).`);
      }
    }
    if (host === '0.0.0.0') {
      console.log('[Dashboard] ⚠️  Bound to ALL interfaces — anyone on your network can reach this dashboard.');
    }
  });

  return server;
}

export function stopDashboard(): Promise<void> {
  return new Promise((resolve) => {
    if (wss) {
      wss.close();
      wss = null;
    }
    if (server) {
      server.close(() => {
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export { dashboardEmitter };
