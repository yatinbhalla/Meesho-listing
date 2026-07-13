import React, { useState, useEffect } from 'react';
import LiveLog from './LiveLog.jsx';
import { useWS } from '../App.jsx';

// Generate mode: upload ONE product photo, pick studio backgrounds, and the
// server cuts out the product + composites it onto each chosen background. Every
// selected background becomes one generated image → one listing. Selection count
// IS the number of listings, so the user sees exactly what they'll get.
//
// On success it lifts the results up via onGenerated({ sessionId, images }) so
// ListingForm can show the review gate + Run button.
export default function BackgroundStudio({ onGenerated, disabled }) {
  const [photo, setPhoto]       = useState(null);   // File
  const [photoUrl, setPhotoUrl] = useState(null);   // dataURL preview
  const [backgrounds, setBackgrounds] = useState([]);
  const [selected, setSelected] = useState([]);     // ordered array of ids
  const [generating, setGenerating] = useState(false);
  const [error, setError]       = useState(null);
  const ws = useWS();

  useEffect(() => {
    fetch('/api/backgrounds')
      .then((r) => r.json())
      .then(setBackgrounds)
      .catch(() => setError('Could not load backgrounds.'));
  }, []);

  function onPickPhoto(e) {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (!f) return;
    setPhoto(f);
    setError(null);
    const reader = new FileReader();
    reader.onload = () => setPhotoUrl(reader.result);
    reader.readAsDataURL(f);
  }

  function toggle(id) {
    setSelected((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }

  const count = selected.length;
  const canGenerate = photo && count > 0 && !generating && !disabled;

  async function onGenerate() {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    ws.clear();

    const form = new FormData();
    form.append('photo', photo);
    form.append('backgroundIds', JSON.stringify(selected));

    try {
      const res = await fetch('/api/generate', { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Generation failed (${res.status})`);
      onGenerated(json);   // { sessionId, images: [{name, url, bgId}] }
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* 1. Source photo */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold mb-1">1 · Your product photo</h3>
        <p className="text-xs text-gray-500 mb-3">
          One clear photo of the product. Its background is removed automatically.
        </p>
        <div className="flex items-center gap-4">
          <label className="flex-1 block border-2 border-dashed border-gray-300 rounded-lg p-5 text-center cursor-pointer hover:border-meesho-pink hover:bg-pink-50 transition">
            <input type="file" accept="image/*" onChange={onPickPhoto} className="hidden" disabled={disabled} />
            <p className="text-3xl mb-1">📷</p>
            <p className="text-sm font-medium text-gray-700">{photo ? 'Choose a different photo' : 'Click to choose a photo'}</p>
            <p className="text-xs text-gray-400 mt-1">JPG, PNG, or WebP · max 15 MB</p>
          </label>
          {photoUrl && (
            <img src={photoUrl} alt="source" className="w-24 h-24 object-cover rounded-lg border border-gray-200 flex-shrink-0" />
          )}
        </div>
      </div>

      {/* 2. Backgrounds */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-semibold">2 · Pick backgrounds</h3>
          {count > 0 && (
            <button onClick={() => setSelected([])} className="text-sm text-red-600 hover:bg-red-50 px-3 py-1 rounded transition-colors">
              Clear ({count})
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Each background you pick becomes one listing. Selected: <strong>{count}</strong>.
        </p>
        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 max-h-80 overflow-y-auto pr-1">
          {backgrounds.map((bg) => {
            const isSel = selected.includes(bg.id);
            const order = selected.indexOf(bg.id) + 1;
            return (
              <button
                key={bg.id}
                onClick={() => toggle(bg.id)}
                disabled={disabled}
                title={bg.name}
                className={`relative rounded-lg overflow-hidden border-2 aspect-square transition
                  ${isSel ? 'border-meesho-pink ring-2 ring-pink-200' : 'border-gray-200 hover:border-gray-400'}`}
              >
                <img src={bg.url} alt={bg.name} className="w-full h-full object-cover" loading="lazy" />
                {isSel && (
                  <span className="absolute top-0.5 right-0.5 w-5 h-5 bg-meesho-pink text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {order}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-900 rounded-lg p-4 text-sm">{error}</div>
      )}

      <button
        onClick={onGenerate}
        disabled={!canGenerate}
        className="w-full py-4 bg-meesho-pink text-white rounded-xl font-bold text-lg hover:bg-meesho-dark transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {generating
          ? '⏳ Generating… (first run loads the model — this can take a minute)'
          : `🎨 Generate ${count || ''} image${count === 1 ? '' : 's'}`}
      </button>

      {generating && <LiveLog topic="generate" height="h-48" emptyText="Starting generation…" />}
    </div>
  );
}
