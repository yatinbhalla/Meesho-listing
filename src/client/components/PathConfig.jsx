import React, { useState } from 'react';

// Reused for two flows:
//  • mode="configure" — right after recording: a fresh path needs naming + field types.
//  • mode="edit"      — updating an existing path.
//
// Everything the automation does is shown in ONE unified, editable list:
//   - text fields  → edit the value
//   - dropdowns    → edit the selected value/text
//   - clicks       → classify as: plain Click · Checkbox · or a missed Field (+value)
//   - navigations  → edit the URL
// plus path metadata and the 3 shared images.
export default function PathConfig({ path, onDone, onCancel, mode = 'configure' }) {
  const isEdit = mode === 'edit';
  const [name, setName]               = useState(path.name || '');
  const [skuPattern, setSku]          = useState(path.skuPattern || '');
  const [description, setDescription] = useState(path.productDescription || '');
  const [fields, setFields]           = useState(path.fields || []);
  const [steps, setSteps]             = useState(path.steps || []);
  const [images, setImages]           = useState({ img2: null, img3: null, img4: null });
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState(null);
  const [filter, setFilter]           = useState('');

  // ─── Field (fieldRef) editors ───────────────────────────────────────────────
  const setFieldType  = (i, type)  => setFields((p) => p.map((f, k) => k === i ? { ...f, type } : f));
  const setFieldFixed = (i, value) => setFields((p) => p.map((f, k) => k === i ? { ...f, fixedValue: value } : f));
  const setFieldPrompt= (i, prompt)=> setFields((p) => p.map((f, k) => k === i ? { ...f, aiPrompt: prompt } : f));
  const setFieldImageRole = (i, role) => setFields((p) => p.map((f, k) => k === i ? { ...f, imageRole: role } : f));

  // ─── Step editors ───────────────────────────────────────────────────────────
  const patchStep = (i, patch) => setSteps((p) => p.map((s, k) => k === i ? { ...s, ...patch } : s));
  const deleteStep = (i) => setSteps((p) => p.filter((_, k) => k !== i));

  // Insert a new blank CLICK action right after index i (the user then fills in
  // its selector). Used to add a step the recorder missed — e.g. the dropzone
  // click that reveals a file input before an image upload.
  function insertStepAfter(i) {
    const blank = { action: 'click', selector: '', label: 'New click', kind: 'click' };
    setSteps((p) => {
      const next = p.slice();
      next.splice(i + 1, 0, blank);
      return next;
    });
  }

  // Re-classify an action.
  //  • 'field'  → convert into a real fill field (full Fixed/AI/SKU/Image options,
  //               participates in AI generation just like a recorded field).
  //  • 'click'  → plain click (button / option).
  //  • 'checkbox' → click, tagged as a toggle.
  function setClickKind(i, kind) {
    if (kind === 'field') {
      const step = steps[i];
      const newIndex = fields.length;
      setFields([
        ...fields,
        {
          fieldName: step.label || step.selector || `Field ${newIndex + 1}`,
          selector: step.selector,
          type: 'fixed',
          fixedValue: '',
        },
      ]);
      setSteps(steps.map((s, k) =>
        k === i ? { ...s, action: 'fill', kind: 'field', fieldRef: newIndex, valueType: undefined, value: undefined } : s
      ));
    } else {
      setSteps(steps.map((s, k) => {
        if (k !== i) return s;
        const { valueType, value, fieldRef, ...rest } = s;
        return { ...rest, action: 'click', kind };
      }));
    }
  }

  // Read/write the visible text inside a text="..." selector.
  const textOf = (sel) => {
    const m = /^text="([\s\S]*)"$/.exec(sel || '');
    return m ? m[1].replace(/\\"/g, '"') : null;
  };

  async function save() {
    if (!name.trim()) { setError('Please enter a path name.'); return; }
    if (!skuPattern.includes('X')) {
      setError('SKU pattern must contain X (it gets replaced with a random 5-digit number).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const patchRes = await fetch(`/api/paths/${path._folder}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, skuPattern, productDescription: description, fields, steps }),
      });
      if (!patchRes.ok) throw new Error('Failed to save configuration.');

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
  const q = filter.trim().toLowerCase();
  const visibleSteps = steps
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !q || (s.label || '').toLowerCase().includes(q) || (s.selector || '').toLowerCase().includes(q));

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{isEdit ? 'Edit Path' : 'Configure Path'}</h2>
        <p className="text-gray-500 text-sm mt-1">
          {isEdit
            ? 'Edit any recorded action below — values, dropdowns, clicks, selectors — or fix path details and images.'
            : 'Name the path, set the SKU pattern, then review the recorded actions and upload your 3 shared images.'}
        </p>
      </div>

      {!isEdit && !skuPattern && (
        <div className="bg-meesho-light border border-pink-200 text-meesho-dark rounded-lg p-4 text-sm">
          🎬 <strong>Recording captured.</strong> Give this path a name, a SKU pattern, and a product description below, then review the recorded actions.
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

      {/* Unified recorded actions */}
      <section className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between gap-3 mb-1">
          <h3 className="font-semibold">Recorded actions ({steps.length})</h3>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="px-2 py-1 border border-gray-300 rounded text-sm w-40"
          />
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Each row is one action the automation replays, in order. Edit any value or selector,
          set field types, classify clicks, or delete an action.
        </p>

        <div className="space-y-2">
          {visibleSteps.length === 0 && (
            <p className="text-sm text-gray-400">No actions match.</p>
          )}
          {visibleSteps.map(({ s, idx }) => {
            const field = s.action === 'fill' && s.fieldRef != null ? fields[s.fieldRef] : null;
            return (
              <ActionRow
                key={idx}
                step={s}
                index={idx}
                field={field}
                textOf={textOf}
                onLabel={(v) => patchStep(idx, { label: v })}
                onSelector={(v) => patchStep(idx, { selector: v })}
                onStepValue={(v) => patchStep(idx, { value: v })}
                onClickKind={(k) => setClickKind(idx, k)}
                onFieldType={(t) => field && setFieldType(s.fieldRef, t)}
                onFieldFixed={(v) => field && setFieldFixed(s.fieldRef, v)}
                onFieldPrompt={(v) => field && setFieldPrompt(s.fieldRef, v)}
                onFieldImageRole={(r) => field && setFieldImageRole(s.fieldRef, r)}
                onInsertAfter={() => insertStepAfter(idx)}
                onDelete={() => deleteStep(idx)}
              />
            );
          })}
        </div>
      </section>

      {/* Shared images */}
      <section className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold mb-1">Shared images</h3>
        <p className="text-xs text-gray-500 mb-4">Used as images 2, 3, and 4 for every listing under this path. Upload once — reused forever.</p>
        <div className="grid grid-cols-3 gap-3">
          {['img2', 'img3', 'img4'].map((slot, i) => (
            <ImagePicker key={slot} label={`Image ${i + 2}`} file={images[slot]} onChange={(f) => setImages((p) => ({ ...p, [slot]: f }))} />
          ))}
        </div>
        {path._sharedImagesReady && !images.img2 && !images.img3 && !images.img4 && (
          <p className="text-xs text-green-700 mt-3">✓ Shared images already uploaded. Pick new ones to replace them.</p>
        )}
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">❌ {error}</div>
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

// ─── One editable action row ──────────────────────────────────────────────────
function ActionRow({
  step, index, field, textOf,
  onLabel, onSelector, onStepValue, onClickKind,
  onFieldType, onFieldFixed, onFieldPrompt, onFieldImageRole, onInsertAfter, onDelete,
}) {
  const icon = { navigate: '📍', click: '👆', select: '📋', fill: '📝', wait: '⏱' }[step.action] || '•';
  const text = textOf(step.selector);   // non-null if selector is text="..."

  // Badge color by action
  const badge = {
    navigate: 'bg-blue-100 text-blue-700',
    click:    'bg-gray-100 text-gray-700',
    select:   'bg-purple-100 text-purple-700',
    fill:     'bg-green-100 text-green-700',
  }[step.action] || 'bg-gray-100 text-gray-700';

  return (
    <div className="border border-gray-200 rounded-lg p-3">
      {/* Header: number, icon, label, delete */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 font-mono w-7 flex-shrink-0">{index + 1}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${badge}`}>
          {icon} {step.action}
        </span>
        <input
          value={step.label || ''}
          onChange={(e) => onLabel(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 border border-gray-200 rounded text-sm font-medium"
          title="Description"
        />
        <button onClick={onInsertAfter} className="text-meesho-pink hover:bg-pink-50 rounded px-2 py-1 flex-shrink-0 text-xs" title="Insert a new action below">＋</button>
        <button onClick={onDelete} className="text-red-500 hover:bg-red-50 rounded px-2 py-1 flex-shrink-0" title="Delete this action">✕</button>
      </div>

      <div className="mt-2 pl-9 space-y-1.5">
        {/* NAVIGATE → URL */}
        {step.action === 'navigate' && (
          <Row label="URL" value={step.value || ''} mono onChange={onStepValue} />
        )}

        {/* SELECT → value + selector */}
        {step.action === 'select' && (
          <>
            <Row label="Value" value={step.value || ''} onChange={onStepValue} />
            <Row label="Selector" value={step.selector || ''} mono onChange={onSelector} />
          </>
        )}

        {/* CLICK → kind classifier + value/selector */}
        {step.action === 'click' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16 flex-shrink-0">Type</span>
              <select
                value={step.kind || 'click'}
                onChange={(e) => onClickKind(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded text-xs"
              >
                <option value="click">Click (button / option)</option>
                <option value="checkbox">Checkbox / toggle</option>
                <option value="field">Field — type a value</option>
              </select>
            </div>
            {text != null ? (
              <Row label="Clicks text" value={text} onChange={(v) => onSelector(`text="${v.replace(/"/g, '\\"')}"`)} />
            ) : (
              <Row label="Selector" value={step.selector || ''} mono onChange={onSelector} />
            )}
          </>
        )}

        {/* FILL — a field with full type options. AI/SKU/Image hide the value box. */}
        {step.action === 'fill' && field && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16 flex-shrink-0">Type</span>
              <select
                value={field.type}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'click' || v === 'checkbox') onClickKind(v);   // revert to a click
                  else onFieldType(v);                                      // fixed / ai / sku / image
                }}
                className="px-2 py-1 border border-gray-300 rounded text-xs"
              >
                <option value="fixed">Fixed value</option>
                <option value="ai">AI generated</option>
                <option value="sku">SKU (auto)</option>
                <option value="image">Image</option>
                <option disabled>──────────</option>
                <option value="click">↩ Make it a Click</option>
                <option value="checkbox">↩ Make it a Checkbox</option>
              </select>
            </div>
            {/* Manual value ONLY for fixed. AI/SKU/Image are auto — no manual input. */}
            {field.type === 'fixed' && (
              <Row label="Value" value={field.fixedValue || ''} onChange={onFieldFixed} />
            )}
            {field.type === 'ai' && (
              <Row label="AI prompt" value={field.aiPrompt || ''} placeholder="Leave blank to auto-infer from the field name" onChange={onFieldPrompt} />
            )}
            {field.type === 'sku' && <Note>Auto-generated SKU from the pattern above — no manual value.</Note>}
            {field.type === 'image' && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-16 flex-shrink-0">Source</span>
                  <select
                    value={field.imageRole || 'auto'}
                    onChange={(e) => onFieldImageRole(e.target.value)}
                    className="px-2 py-1 border border-gray-300 rounded text-xs"
                  >
                    <option value="hero">Hero — the photo you upload when you click Run</option>
                    <option value="shared">Shared — the 3 pre-uploaded images</option>
                    <option value="auto">Auto (1st upload = hero, rest = shared)</option>
                  </select>
                </div>
                <Note>No manual value — the file is uploaded automatically based on the source above.</Note>
              </>
            )}
            <Row label="Selector" value={step.selector || ''} mono onChange={onSelector} />
          </>
        )}

        {/* Legacy inline fill (older configs without a field entry) */}
        {step.action === 'fill' && !field && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16 flex-shrink-0">Type</span>
              <select value="field" onChange={(e) => onClickKind(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded text-xs">
                <option value="field">Field — type a value</option>
                <option value="click">↩ Make it a Click</option>
                <option value="checkbox">↩ Make it a Checkbox</option>
              </select>
            </div>
            <Row label="Value" value={step.value || ''} onChange={onStepValue} />
            <Row label="Selector" value={step.selector || ''} mono onChange={onSelector} />
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, onChange, mono, placeholder }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-xs text-gray-400 w-16 flex-shrink-0">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`flex-1 min-w-0 px-2 py-1 border border-gray-200 rounded text-xs ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}

function Note({ children }) {
  return <p className="text-xs text-gray-400 pl-[4.5rem]">{children}</p>;
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
