import React, { useEffect, useState } from 'react';

export default function Settings({ paths, onPathsChanged, onEditPath, onDuplicatePath }) {
  const [tab, setTab] = useState('credentials');
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'credentials', label: 'Credentials' },
          { id: 'paths',       label: 'Paths' },
          { id: 'skus',        label: 'Used SKUs' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id ? 'border-meesho-pink text-meesho-pink' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'credentials' && <CredentialsTab />}
      {tab === 'paths'       && <PathsTab paths={paths} onPathsChanged={onPathsChanged} onEditPath={onEditPath} onDuplicatePath={onDuplicatePath} />}
      {tab === 'skus'        && <SkusTab />}
    </div>
  );
}

function CredentialsTab() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ MEESHO_EMAIL: '', MEESHO_PASSWORD: '', GEMINI_API_KEY: '', GEMINI_MODEL: '', AI_NAVIGATION_ENABLED: true });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState(null);

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      setData(d);
      setForm((f) => ({
        ...f,
        MEESHO_EMAIL: d.MEESHO_EMAIL,
        GEMINI_MODEL: d.GEMINI_MODEL,
        AI_NAVIGATION_ENABLED: d.AI_NAVIGATION_ENABLED !== false,
      }));
    }).catch(() => {});
  }, []);

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const body = {};
      // Only send non-empty fields. Password / API key blank = keep existing.
      if (form.MEESHO_EMAIL    !== data?.MEESHO_EMAIL)  body.MEESHO_EMAIL = form.MEESHO_EMAIL;
      if (form.MEESHO_PASSWORD)                          body.MEESHO_PASSWORD = form.MEESHO_PASSWORD;
      if (form.GEMINI_API_KEY)                           body.GEMINI_API_KEY  = form.GEMINI_API_KEY;
      if (form.GEMINI_MODEL    !== data?.GEMINI_MODEL)  body.GEMINI_MODEL    = form.GEMINI_MODEL;
      if (form.AI_NAVIGATION_ENABLED !== data?.AI_NAVIGATION_ENABLED) {
        body.AI_NAVIGATION_ENABLED = form.AI_NAVIGATION_ENABLED ? 'true' : 'false';
      }

      if (Object.keys(body).length === 0) { setMsg({ type: 'info', text: 'Nothing to update.' }); return; }

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || 'Failed to save settings.');
      }
      setMsg({ type: 'success', text: 'Saved. Changes apply on next automation run.' });
      setForm((f) => ({ ...f, MEESHO_PASSWORD: '', GEMINI_API_KEY: '' }));
      // refresh masked previews
      const refreshed = await fetch('/api/settings').then((r) => r.json());
      setData(refreshed);
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    } finally { setSaving(false); }
  }

  if (!data) return <p className="text-gray-400 text-sm">Loading…</p>;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
      <p className="text-xs text-gray-500">
        Stored locally in <code className="bg-gray-100 px-1 rounded">.env</code>. Never sent anywhere except to Meesho (login) and Gemini (text generation).
      </p>

      <Field label="Meesho Email" value={form.MEESHO_EMAIL}
        onChange={(v) => setForm({ ...form, MEESHO_EMAIL: v })} />

      <Field label="Meesho Password" type="password" placeholder={data.hasPassword ? `Current: ${data.MEESHO_PASSWORD_MASKED}` : 'Not set'}
        value={form.MEESHO_PASSWORD} onChange={(v) => setForm({ ...form, MEESHO_PASSWORD: v })}
        hint="Leave blank to keep existing password." />

      <Field label="Gemini API Key" type="password" placeholder={data.hasApiKey ? `Current: ${data.GEMINI_API_KEY_MASKED}` : 'Not set'}
        value={form.GEMINI_API_KEY} onChange={(v) => setForm({ ...form, GEMINI_API_KEY: v })}
        hint="Leave blank to keep existing key." />

      <Field label="Gemini Model" value={form.GEMINI_MODEL}
        onChange={(v) => setForm({ ...form, GEMINI_MODEL: v })}
        hint='e.g. "gemini-2.5-flash-lite". Leave blank to auto-pick.' />

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={form.AI_NAVIGATION_ENABLED}
          onChange={(e) => setForm({ ...form, AI_NAVIGATION_ENABLED: e.target.checked })}
          className="mt-1"
        />
        <span>
          <span className="block text-sm font-medium">AI Navigation</span>
          <span className="block text-xs text-gray-500">
            When a recorded selector breaks, ask Gemini to find the right element instead of pausing for manual recovery. Each rescue uses ~1 Gemini call.
          </span>
        </span>
      </label>

      {msg && (
        <p className={`text-sm ${
          msg.type === 'error'   ? 'text-red-600' :
          msg.type === 'success' ? 'text-green-600' : 'text-gray-600'
        }`}>{msg.text}</p>
      )}

      <button
        onClick={save}
        disabled={saving}
        className="px-5 py-2 bg-meesho-pink text-white rounded-lg font-medium hover:bg-meesho-dark transition-colors disabled:bg-gray-300"
      >{saving ? 'Saving…' : 'Save settings'}</button>
    </div>
  );
}

function Field({ label, type = 'text', value, onChange, placeholder, hint }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

function PathsTab({ paths, onPathsChanged, onEditPath, onDuplicatePath }) {
  const [busy, setBusy] = useState(null);
  async function del(folder, name) {
    if (!confirm(`Delete path "${name}"? This removes the config and shared images permanently.`)) return;
    const res = await fetch(`/api/paths/${folder}`, { method: 'DELETE' });
    if (res.ok) onPathsChanged();
    else alert('Failed to delete.');
  }
  async function duplicate(p) {
    setBusy(p._folder);
    try { await onDuplicatePath(p); } finally { setBusy(null); }
  }
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      {paths.length === 0 && <p className="p-6 text-sm text-gray-400 text-center">No paths recorded yet.</p>}
      {paths.map((p) => (
        <div key={p._folder} className="flex items-center justify-between p-4 border-b border-gray-100 last:border-0 gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium truncate">{p.name}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {p.fields?.length || 0} fields · {p.steps?.length || 0} steps · SKU pattern <code className="bg-gray-100 px-1 rounded">{p.skuPattern}</code>
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onEditPath && (
              <button
                onClick={() => onEditPath(p)}
                className="px-3 py-1 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >Edit</button>
            )}
            {onDuplicatePath && (
              <button
                onClick={() => duplicate(p)}
                disabled={busy === p._folder}
                title="Make a copy of this path to tweak (e.g. a different colour variant)"
                className="px-3 py-1 text-sm text-meesho-pink hover:bg-pink-50 rounded-lg transition-colors disabled:text-gray-300"
              >{busy === p._folder ? 'Copying…' : 'Duplicate'}</button>
            )}
            <button
              onClick={() => del(p._folder, p.name)}
              className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
            >Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SkusTab() {
  const [skus, setSkus] = useState([]);
  useEffect(() => {
    fetch('/api/skus').then((r) => r.json()).then(setSkus).catch(() => {});
  }, []);
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <p className="text-sm text-gray-500 mb-3">{skus.length} SKU{skus.length === 1 ? '' : 's'} generated so far.</p>
      {skus.length === 0
        ? <p className="text-sm text-gray-400">None yet.</p>
        : (
          <div className="font-mono text-xs space-y-1 max-h-96 overflow-y-auto">
            {skus.map((s) => <div key={s} className="text-gray-700">{s}</div>)}
          </div>
        )}
    </div>
  );
}
