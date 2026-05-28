import React, { useState } from 'react';

// Reused for two flows:
//  • mode="configure" — right after recording: fresh path needs field types + images.
//  • mode="edit"      — user is updating an existing path: same fields, optional image swap.
//
// User can:
//  1. Mark each captured field as AI / Fixed / SKU / Image.
//  2. Edit product description, name, and SKU pattern.
//  3. Upload (or replace) the 3 shared images.
//  4. Save — PATCH /api/paths/:name + optional POST /api/paths/:name/images.
export default function PathConfig({ path, onDone, onCancel, mode = 'configure' }) {
  const isEdit = mode === 'edit';
  const [name, setName]               = useState(path.name);
  const [skuPattern, setSku]          = useState(path.skuPattern || '');
  const [description, setDescription] = useState(path.productDescription || '');
  const [fields, setFields]           = useState(path.fields || []);
  const [images, setImages]           = useState({ img2: null, img3: null, img4: null });
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState(null);

  function setFieldType(idx, type) {
    setFields((prev) => prev.map((f, i) => i === idx ? { ...f, type } : f));
  }

  function setFieldFixed(idx, value) {
    setFields((prev) => prev.map((f, i) => i === idx ? { ...f, fixedValue: value } : f));
  }

  function setFieldPrompt(idx, prompt) {
    setFields((prev) => prev.map((f, i) => i === idx ? { ...f, aiPrompt: prompt } : f));
  }

  function setImage(slot, file) {
    setImages((prev) => ({ ...prev, [slot]: file }));
  }

  async function save() {
    // Validation — these used to be enforced in the browser overlay; now the
    // app owns it since path details are entered here.
    if (!name.trim()) { setError('Please enter a path name.'); return; }
    if (!skuPattern.includes('X')) {
      setError('SKU pattern must contain X (it gets replaced with a random 5-digit number).');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // 1. Update field config & metadata
      const patchRes = await fetch(`/api/paths/${path._folder}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, skuPattern, productDescription: description, fields }),
      });
      if (!patchRes.ok) throw new Error('Failed to save field config.');

      // 2. Upload shared images (only if user picked them — could be a re-edit)
      const hasAllImages = images.img2 && images.img3 && images.img4;
      if (hasAllImages) {
        const fd = new FormData();
        fd.append('img2', images.img2);
        fd.append('img3', images.img3);
        fd.append('img4', images.img4);
        const upRes = await fetch(`/api/paths/${path._folder}/images`, { method: 'POST', body: fd });
        if (!upRes.ok) throw new Error('Failed to upload shared images.');
      }

      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const skuPreview = skuPattern.replace('X', '12345');

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{isEdit ? 'Edit Path' : 'Configure Path'}</h2>
        <p className="text-gray-500 text-sm mt-1">
          {isEdit
            ? 'Update path details, field configuration, or replace shared images. Steps and selectors are managed by recording / AI nav / recovery.'
            : 'Mark which fields use AI generation, then upload the 3 shared images for this product type.'}
        </p>
      </div>

      {!isEdit && !skuPattern && (
        <div className="bg-meesho-light border border-pink-200 text-meesho-dark rounded-lg p-4 text-sm">
          🎬 <strong>Recording captured.</strong> Give this path a name, a SKU pattern, and a product description below — then mark which fields the AI should generate and upload your 3 shared images.
        </div>
      )}

      {/* Metadata */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 className="font-semibold">Path details</h3>

        <div>
          <label className="block text-sm font-medium mb-1">Path name</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">SKU pattern</label>
          <input value={skuPattern} onChange={(e) => setSku(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono" />
          <p className="text-xs text-gray-500 mt-1">
            Use <code className="bg-gray-100 px-1 rounded">X</code> as placeholder. Preview:{' '}
            <code className="bg-gray-100 px-1 rounded">{skuPreview}</code>
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Product description (used by AI)</label>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
        </div>
      </section>

      {/* Fields */}
      <section className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold mb-3">Captured fields ({fields.length})</h3>
        {fields.length === 0 && (
          <p className="text-sm text-gray-500">No fields were captured during recording.</p>
        )}
        <div className="space-y-3">
          {fields.map((f, idx) => (
            <div key={idx} className="border border-gray-200 rounded-lg p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{f.fieldName}</p>
                  <p className="text-xs text-gray-400 font-mono truncate">{f.selector}</p>
                </div>
                <select
                  value={f.type}
                  onChange={(e) => setFieldType(idx, e.target.value)}
                  className="px-2 py-1 border border-gray-300 rounded text-sm"
                  disabled={f.type === 'image'}
                >
                  <option value="fixed">Fixed value</option>
                  <option value="ai">AI generated</option>
                  <option value="sku">SKU</option>
                  <option value="image">Image</option>
                </select>
              </div>

              {f.type === 'fixed' && (
                <input
                  value={f.fixedValue || ''}
                  onChange={(e) => setFieldFixed(idx, e.target.value)}
                  placeholder="Fixed value"
                  className="mt-2 w-full px-2 py-1 border border-gray-200 rounded text-sm"
                />
              )}
              {f.type === 'ai' && (
                <textarea
                  rows={2}
                  value={f.aiPrompt || ''}
                  onChange={(e) => setFieldPrompt(idx, e.target.value)}
                  placeholder="Optional custom AI prompt — leave blank to auto-infer from field name."
                  className="mt-2 w-full px-2 py-1 border border-gray-200 rounded text-sm"
                />
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Shared images */}
      <section className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold mb-1">Shared images</h3>
        <p className="text-xs text-gray-500 mb-4">Used as images 2, 3, and 4 for every listing under this path. Upload once — reused forever.</p>

        <div className="grid grid-cols-3 gap-3">
          {['img2', 'img3', 'img4'].map((slot, i) => (
            <ImagePicker key={slot} label={`Image ${i + 2}`} file={images[slot]} onChange={(f) => setImage(slot, f)} />
          ))}
        </div>
        {path._sharedImagesReady && !images.img2 && !images.img3 && !images.img4 && (
          <p className="text-xs text-green-700 mt-3">✓ Shared images already uploaded. Pick new ones to replace them.</p>
        )}
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
          ❌ {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="flex-1 py-3 bg-meesho-pink text-white rounded-lg font-medium hover:bg-meesho-dark transition-colors disabled:bg-gray-300"
        >
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Save & Done')}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            disabled={saving}
            className="px-5 py-3 text-gray-600 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function ImagePicker({ label, file, onChange }) {
  const [preview, setPreview] = React.useState(null);

  function pick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    onChange(f);
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result);
    reader.readAsDataURL(f);
  }

  return (
    <label className="block border-2 border-dashed border-gray-300 rounded-lg p-3 text-center cursor-pointer hover:border-meesho-pink hover:bg-pink-50 transition">
      <input type="file" accept="image/*" onChange={pick} className="hidden" />
      {preview ? (
        <img src={preview} alt={label} className="max-h-24 mx-auto rounded" />
      ) : (
        <div className="py-4">
          <p className="text-2xl">📷</p>
          <p className="text-xs font-medium mt-1">{label}</p>
        </div>
      )}
      {file && <p className="text-xs text-gray-500 mt-1 truncate">{file.name}</p>}
    </label>
  );
}
