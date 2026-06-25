import express from 'express';
import { recordPath } from '../../browser/recorder.js';
import { broadcast, getActiveSession, setActiveSession, clearActiveSession } from '../index.js';
import { getActiveProfile } from '../profiles.js';

const router = express.Router();

/**
 * POST /api/record  →  start a new recording session.
 *
 * Returns 202 immediately — the recorder runs in the background and streams
 * progress over WebSocket. The final `recording_complete` event carries the
 * saved path name so the UI can switch to the configure-fields screen.
 */
router.post('/', async (_req, res) => {
  if (getActiveSession()) {
    return res.status(409).json({
      error: `Another session is already active (${getActiveSession()}). ` +
             `Wait for it to finish or close the browser window.`,
    });
  }

  setActiveSession('recording');
  res.status(202).json({ ok: true, message: 'Recording started — watch the browser window.' });

  // WHY: We don't await this — recording can take 5-15 minutes while the user
  // walks through the form. The HTTP response is already sent; progress flows
  // via WebSocket only.
  recordPath((type, text) => broadcast({ type, text, topic: 'record' }), getActiveProfile())
    .then(({ pathConfig }) => {
      broadcast({
        type: 'event',
        event: 'recording_complete',
        topic: 'record',
        pathName: pathConfig.name,
        pathConfig,
        text: `✓ Recording saved with ${pathConfig.steps.length} steps and ${pathConfig.fields.length} fields. Name & configure it below.`,
      });
    })
    .catch((err) => {
      broadcast({ type: 'error', topic: 'record', text: `Recording failed: ${err.message}` });
    })
    .finally(() => clearActiveSession());
});

export default router;
