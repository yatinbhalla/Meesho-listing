import React, { useEffect, useState } from 'react';

export default function Settings({ paths, onPathsChanged, onEditPath, onDuplicatePath, onProfilesChanged }) {
  const [tab, setTab] = useState('profiles');
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'profiles',    label: 'Accounts' },
          { id: 'credentials', label: 'Gemini & AI' },
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

      {tab === 'profiles'    && <ProfilesTab onProfilesChanged={onProfilesChanged} />}
      {tab === 'credentials' && <CredentialsTab />}
      {tab === 'paths'       && <PathsTab paths={paths} onPathsChanged={onPathsChanged} onEditPath={onEditPath} onDuplicatePath={onDuplicatePath} />}
      {tab === 'skus'        && <SkusTab />}
    </div>
  );
}

// ─── Accounts (Meesho profiles) ─────────────────────────────────────────────────
function ProfilesTab({ onProfilesChanged }) {
  const [profiles, setProfiles] = useState(null);
  const [drafts, setDrafts]     = useState({});   // id -> { name, email, password }
  const [savingId, setSavingId] = useState(null);
  const [msg, setMsg]           = useState(null);

  const load = () => fetch('/api/profiles').then((r) => r.json()).then((d) => {
    setProfiles(d.profiles);
    setDrafts(Object.fromEntries(d.profiles.map((p) => [p.id, { name: p.name, email: p.email, password: '' }])));
  }).catch(() => {});

  useEffect(() => { load(); }, []);

  function setField(id, key, val) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], [key]: val } }));
  }

  async function save(p) {
    setSavingId(p.id); setMsg(null);
    try {
      const body = {};
      const d = drafts[p.id] || {};
      if (d.name !== p.name)   body.name = d.name;
      if (d.email !== p.email) body.email = d.email;
      if (d.password)          body.password = d.password;
      if (Object.keys(body).length === 0) { setMsg({ type: 'info', text: 'Nothing to update.' }); return; }
      const res = await fetch(`/api/profiles/${p.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Save failed.'); }
      setMsg({ type: 'success', text: `Saved "${d.name}". Applies on the next run for this account.` });
      await load();
      onProfilesChanged?.();
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    } finally { setSavingId(null); }
  }

  if (!profiles) return <p className="text-gray-400 text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Each account has its own Meesho login, its own saved paths, and its own browser session. Switch the active
        account from the sidebar. Credentials are stored locally in <code className="bg-gray-100 px-1 rounded">data/profiles.json</code> and never sent anywhere except to Meesho.
      </p>
      {profiles.map((p) => {
        const d = drafts[p.id] || { name: '', email: '', password: '' };
        return (
          <div key={p.id} className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">👤</span>
              <input
                value={d.name}
                onChange={(e) => setField(p.id, 'name', e.target.value)}
                className="text-base font-semibold border-b border-transparent hover:border-gray-300 focus:border-meesho-pink focus:outline-none flex-1"
              />
            </div>
            <Field label="Meesho Email" value={d.email} onChange={(v) => setField(p.id, 'email', v)} placeholder="account email" />
            <Field label="Meesho Password" type="password"
              placeholder={p.hasPassword ? `Current: ${p.passwordMasked}` : 'Not set'}
              value={d.password} onChange={(v) => setField(p.id, 'password', v)}
              hint="Leave blank to keep the existing password." />
            <button
              onClick={() => save(p)} disabled={savingId === p.id}
              className="px-4 py-2 bg-meesho-pink text-white rounded-lg text-sm font-medium hover:bg-meesho-dark transition-colors disabled:bg-gray-300"
            >{savingId === p.id ? 'Saving…' : 'Save account'}</button>
          </div>
        );
      })}
      {msg && (
        <p className={`text-sm ${msg.type === 'error' ? 'text-red-600' : msg.type === 'success' ? 'text-green-600' : 'text-gray-600'}`}>{msg.text}</p>
      )}
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
      // Only send non-empty fields. API key blank = keep existing.
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
        Gemini powers AI text generation &amp; navigation. Stored locally in <code className="bg-gray-100 px-1 rounded">.env</code>.
        Meesho account logins live under the <strong>Accounts</strong> tab.
      </p>

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
  const [importing, setImporting] = useState(false);
  const fileRef = React.useRef(null);

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
  // Download a single-file backup (config + shared images) for the path.
  async function exportPath(p) {
    try {
      const res = await fetch(`/api/paths/${encodeURIComponent(p._folder)}/export`);
      if (!res.ok) throw new Error('Export failed.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(p.name || 'path').replace(/[^a-z0-9._-]+/gi, '_')}.meesho-path.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    }
  }
  // Restore a path from a backup file.
  async function importPath(file) {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('backup', file);
      const res = await fetch('/api/paths/import', { method: 'POST', body: fd });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || 'Import failed.');
      }
      const restored = await res.json();
      await onPathsChanged();
      if (onEditPath) onEditPath(restored);   // open the restored path so the user can review it
      else alert(`Restored "${restored.name}".`);
    } catch (err) {
      alert(err.message);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="flex items-center justify-between p-3 border-b border-gray-100">
        <p className="text-xs text-gray-500">Back up a path to a file, or restore one from a backup.</p>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => importPath(e.target.files?.[0])}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          className="px-3 py-1 text-sm text-meesho-pink border border-meesho-pink rounded-lg hover:bg-pink-50 transition-colors disabled:opacity-50"
        >{importing ? 'Importing…' : '⬆ Import path'}</button>
      </div>
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
              onClick={() => exportPath(p)}
              title="Download a backup file (config + shared images) to restore this path later"
              className="px-3 py-1 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >Export</button>
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
