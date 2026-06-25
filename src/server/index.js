import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import pathsRouter from './routes/paths.js';
import runRouter from './routes/run.js';
import skusRouter from './routes/skus.js';
import recordRouter from './routes/record.js';
import settingsRouter from './routes/settings.js';
import profilesRouter from './routes/profiles.js';
import { ensureProfilesInit } from './profiles.js';

const app = express();
const server = createServer(app);

// ─── WebSocket ──────────────────────────────────────────────────────────────────
// WHY: Attached to the same HTTP server so Vite's proxy can forward /ws → 3001
// without any extra config.
const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * Broadcast a message to every connected browser tab.
 *
 * @param {{ type: 'info'|'success'|'error'|'event', text?: string, event?: string, [key: string]: any }} message
 */
export function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) client.send(payload);
  });
}

wss.on('connection', () => {
  broadcast({ type: 'info', text: 'Connected to Meesho Lister server.' });
});

// ─── Active-session lock ────────────────────────────────────────────────────────
// WHY: Only one Playwright session can run at a time (recording or executing).
// The lock prevents the user from clicking Run while a Record is still going.
let activeSession = null;        //  'recording' | 'running' | null

export function getActiveSession()   { return activeSession; }
export function setActiveSession(s)  { activeSession = s; }
export function clearActiveSession() { activeSession = null; }

// ─── Middleware ──────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/paths',  pathsRouter);
app.use('/api/run',    runRouter);
app.use('/api/skus',   skusRouter);
app.use('/api/record', recordRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/profiles', profilesRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, activeSession }));

// ─── Start ───────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
// Seed/migrate the profiles store (moves any legacy single-account paths + session
// under the "Yatin Bhalla" profile) BEFORE accepting requests.
ensureProfilesInit()
  .catch((err) => console.error('Profile init failed:', err.message))
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`\n✅  Meesho Lister server running on http://localhost:${PORT}`);
      console.log(`   Open http://localhost:5173 in your browser (Vite dev server)\n`);
    });
  });
