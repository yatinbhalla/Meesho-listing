import React, { useState } from 'react';
import LiveLog from './LiveLog.jsx';
import { useWS } from '../App.jsx';

// Two-step wizard:
//   Step 1 — intro + "Start Recording" button
//   Step 2 — recording in progress (live log). The App auto-jumps to PathConfig
//            once the WS event 'recording_complete' arrives.
export default function RecordWizard({ onCancel }) {
  const [phase, setPhase] = useState('intro');     // intro | recording
  const [error, setError] = useState(null);
  const ws = useWS();

  async function start() {
    setError(null);
    ws.clear();
    setPhase('recording');
    try {
      const res = await fetch('/api/record', { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Server returned ${res.status}`);
      }
    } catch (err) {
      setError(err.message);
      setPhase('intro');
    }
  }

  if (phase === 'intro') {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Record New Path</h2>
          <p className="text-gray-500 text-sm mt-1">
            Walk through Meesho's listing form once. The app will remember every step.
          </p>
        </div>

        <ol className="space-y-4 bg-white rounded-xl border border-gray-200 p-6">
          <li className="flex gap-4">
            <span className="w-7 h-7 rounded-full bg-meesho-light text-meesho-dark font-bold flex items-center justify-center flex-shrink-0">1</span>
            <div>
              <p className="font-medium">Click <strong>Start Recording</strong> below.</p>
              <p className="text-sm text-gray-500">A Chromium browser window will open and log into Meesho automatically.</p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="w-7 h-7 rounded-full bg-meesho-light text-meesho-dark font-bold flex items-center justify-center flex-shrink-0">2</span>
            <div>
              <p className="font-medium">Walk through the listing form once.</p>
              <p className="text-sm text-gray-500">Navigate to "Add New Catalog", fill in fields, select dropdowns, upload sample images. The pink panel in the corner records every action.</p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="w-7 h-7 rounded-full bg-meesho-light text-meesho-dark font-bold flex items-center justify-center flex-shrink-0">3</span>
            <div>
              <p className="font-medium">Click <strong>Save &amp; Finish</strong> in the panel.</p>
              <p className="text-sm text-gray-500">Enter a path name, SKU pattern (like <code className="bg-gray-100 px-1 rounded">WH_FURR/X</code>), and product description.</p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="w-7 h-7 rounded-full bg-meesho-light text-meesho-dark font-bold flex items-center justify-center flex-shrink-0">4</span>
            <div>
              <p className="font-medium">Configure fields &amp; upload shared images.</p>
              <p className="text-sm text-gray-500">After saving, you'll mark which fields use AI generation and upload 3 reusable images.</p>
            </div>
          </li>
        </ol>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
            ❌ {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={start}
            className="flex-1 py-3 bg-meesho-pink text-white rounded-lg font-medium hover:bg-meesho-dark transition-colors"
          >
            Start Recording
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-3 text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // phase === 'recording'
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse"></span>
          Recording in Progress
        </h2>
        <p className="text-gray-500 text-sm mt-1">
          Switch to the Chromium window. Walk through the form, then click "Save &amp; Finish" in the pink panel.
        </p>
      </div>

      <LiveLog topic="record" height="h-96" emptyText="Waiting for the browser to open..." />
    </div>
  );
}
