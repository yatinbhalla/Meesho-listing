import React, { useState, useEffect, useRef } from 'react';
import LiveLog from './LiveLog.jsx';
import { useWS } from '../App.jsx';

// Daily-use screen: pick a path → upload N hero images → click Run.
// Each image becomes its own listing; everything else (description, AI text,
// shared images 2-4) is reused across the batch.
export default function ListingForm({ path, onRefresh, onEdit, activeProfileName }) {
  const [heroFiles, setHeroFiles]   = useState([]);     // File[]
  const [previews, setPreviews]     = useState([]);     // dataURL[]
  const [running, setRunning]       = useState(false);
  const [batchStatus, setBatchStatus] = useState(null); // { current, total, sku } | null
  const [completedSkus, setCompletedSkus] = useState([]);
  const [failedAt, setFailedAt]     = useState(null);   // { index, sku, error } | null
  const ws = useWS();

  // Track only NEW messages so we don't reprocess on every render.
  const lastSeenIndex = useRef(0);

  // React to fresh WS messages.
  useEffect(() => {
    for (let i = lastSeenIndex.current; i < ws.messages.length; i++) {
      const msg = ws.messages[i];
      if (msg.type !== 'event') continue;

      switch (msg.event) {
        case 'batch_start':
          setBatchStatus({ current: 0, total: msg.total, sku: '' });
          setCompletedSkus([]);
          setFailedAt(null);
          break;
        case 'batch_item_start':
          setBatchStatus({ current: msg.index, total: msg.total, sku: msg.sku });
          break;
        case 'batch_item_complete':
          setCompletedSkus((prev) => [...prev, msg.sku].filter(Boolean));
          break;
        case 'batch_complete':
          setRunning(false);
          setBatchStatus(null);
          break;
        case 'batch_failed':
          setRunning(false);
          setBatchStatus(null);
          setFailedAt({ index: msg.index, sku: msg.sku, error: msg.error });
          break;
      }
    }
    lastSeenIndex.current = ws.messages.length;
  }, [ws.messages.length]);

  if (!path) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <div className="text-center">
          <p className="text-5xl mb-4">👈</p>
          <p className="text-lg font-medium">Select a saved path from the sidebar</p>
        </div>
      </div>
    );
  }

  const ready    = path._sharedImagesReady;
  const hasAi    = (path.fields || []).some((f) => f.type === 'ai');
  const blocking = !ready;

  function onFilePick(e) {
    const newFiles = Array.from(e.target.files || []);
    if (newFiles.length === 0) return;

    // Accumulate so the user can pick from multiple folders.
    const allFiles = [...heroFiles, ...newFiles];
    setHeroFiles(allFiles);

    // Build previews for the newly added files only, then merge.
    Promise.all(
      newFiles.map(
        (f) => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(f);
        })
      )
    ).then((newPreviews) => {
      setPreviews((prev) => [...prev, ...newPreviews]);
    });

    // Reset the input so picking the same file again still triggers onChange.
    e.target.value = '';

    setCompletedSkus([]);
    setFailedAt(null);
  }

  function removeAt(idx) {
    setHeroFiles((f) => f.filter((_, i) => i !== idx));
    setPreviews((p) => p.filter((_, i) => i !== idx));
  }

  function clearAll() {
    setHeroFiles([]);
    setPreviews([]);
    setCompletedSkus([]);
    setFailedAt(null);
  }

  async function onRun() {
    if (heroFiles.length === 0) return;
    setRunning(true);
    setCompletedSkus([]);
    setFailedAt(null);
    ws.clear();

    const form = new FormData();
    form.append('pathName', path._folder);
    for (const f of heroFiles) form.append('heroImages', f);

    try {
      const res = await fetch('/api/run', { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Run failed (${res.status})`);
      }
    } catch (err) {
      setRunning(false);
      alert(err.message);
    }
  }

  const count = heroFiles.length;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold truncate">{path.name}</h2>
          <p className="text-sm text-gray-500 mt-1">
            SKU pattern: <code className="bg-gray-100 px-1 rounded">{path.skuPattern}</code>
            <span className="mx-2">·</span>
            {path.steps?.length || 0} steps · {path.fields?.length || 0} fields
          </p>
        </div>
        {onEdit && !running && (
          <button
            onClick={onEdit}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0"
            title="Edit path name, description, SKU pattern, fields, and shared images"
          >
            ✏️ Edit path
          </button>
        )}
      </div>

      {blocking && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4 text-sm">
          <strong>⚠ Setup incomplete.</strong>{' '}
          {!ready && 'Upload 3 shared images in the configure screen.'}
        </div>
      )}

      {!hasAi && !blocking && (
        <div className="bg-blue-50 border border-blue-200 text-blue-800 rounded-lg p-4 text-sm">
          ℹ No fields are marked as AI-generated. Each run uses values captured during recording.
        </div>
      )}

      {/* Hero images — multi-file upload */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold">Hero Images</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              One listing per image. All listings reuse this path's shared images 2-4.
            </p>
          </div>
          {count > 0 && (
            <button onClick={clearAll} className="text-sm text-red-600 hover:bg-red-50 px-3 py-1 rounded transition-colors">
              Clear all
            </button>
          )}
        </div>

        <label className="block border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-meesho-pink hover:bg-pink-50 transition mb-4">
          <input type="file" accept="image/*" multiple onChange={onFilePick} className="hidden" />
          <p className="text-3xl mb-2">📸</p>
          <p className="text-sm font-medium text-gray-700">
            {count === 0 ? 'Click to choose hero images' : 'Click to add more images'}
          </p>
          <p className="text-xs text-gray-400 mt-1">JPG, PNG, or WebP · max 10 MB each · up to 50</p>
        </label>

        {count > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-2">
              {count} listing{count === 1 ? '' : 's'} queued
            </p>
            <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-3">
              {previews.map((src, i) => {
                const isDone   = batchStatus && i < batchStatus.current - 1;
                const isActive = batchStatus && i === batchStatus.current - 1;
                const isFailed = failedAt && i === failedAt.index - 1;
                return (
                  <div key={i} className={`relative rounded border-2 overflow-hidden
                      ${isFailed ? 'border-red-500' :
                        isActive ? 'border-meesho-pink ring-2 ring-pink-200' :
                        isDone   ? 'border-green-500' :
                                   'border-gray-200'}`}>
                    <img src={src} alt={`hero ${i+1}`} className="w-full h-24 object-cover" />
                    {!running && (
                      <button
                        onClick={() => removeAt(i)}
                        className="absolute top-1 right-1 w-5 h-5 bg-white/90 rounded-full text-gray-700 hover:bg-red-500 hover:text-white text-xs leading-none"
                        title="Remove"
                      >×</button>
                    )}
                    <span className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 text-white text-[10px] rounded">
                      {i + 1}{isDone ? ' ✓' : isActive ? ' …' : isFailed ? ' ✗' : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {activeProfileName && (
        <p className="text-center text-sm text-gray-500 mb-2">
          Uploading to account: <span className="font-semibold text-meesho-dark">{activeProfileName}</span>
        </p>
      )}

      <button
        onClick={onRun}
        disabled={count === 0 || running || blocking}
        className="w-full py-4 bg-meesho-pink text-white rounded-xl font-bold text-lg hover:bg-meesho-dark transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {running
          ? (batchStatus
              ? `⏳ Listing ${batchStatus.current} of ${batchStatus.total}${batchStatus.sku ? ` · ${batchStatus.sku}` : ''}`
              : '⏳ Starting...')
          : `🚀 Run for ${count} listing${count === 1 ? '' : 's'}`}
      </button>

      {failedAt && (
        <div className="bg-red-50 border border-red-200 text-red-900 rounded-lg p-4">
          <p className="font-semibold">✗ Batch halted at listing {failedAt.index}</p>
          {failedAt.sku && <p className="text-sm mt-1">SKU: <code className="bg-white px-1.5 py-0.5 rounded">{failedAt.sku}</code></p>}
          <p className="text-sm mt-2">{failedAt.error}</p>
          <p className="text-xs text-red-700 mt-2">Fix the issue (use the recovery overlay if a selector broke), remove already-completed images, and run again.</p>
        </div>
      )}

      {completedSkus.length > 0 && !running && !failedAt && (
        <div className="bg-green-50 border border-green-200 text-green-900 rounded-lg p-4">
          <p className="font-semibold">✓ {completedSkus.length} listing{completedSkus.length === 1 ? '' : 's'} created</p>
          <div className="font-mono text-xs mt-2 space-y-0.5 max-h-32 overflow-y-auto">
            {completedSkus.map((sku) => <div key={sku}>{sku}</div>)}
          </div>
        </div>
      )}

      <LiveLog topic="run" emptyText="Click Run to start the batch automation." />
    </div>
  );
}
