import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ListingForm from './components/ListingForm.jsx';
import RecordWizard from './components/RecordWizard.jsx';
import PathConfig from './components/PathConfig.jsx';
import Settings from './components/Settings.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';

// WHY: We expose the live WebSocket via context so deeply-nested components
// (e.g. LiveLog inside ListingForm) can subscribe without prop-drilling.
export const WSContext = createContext(null);
export const useWS = () => useContext(WSContext);

export default function App() {
  // ─── Top-level view router ──────────────────────────────────────────────────
  const [view, setView]                   = useState('welcome');   // welcome | list | record | configure | edit | settings
  const [paths, setPaths]                 = useState([]);
  const [selectedPath, setSelectedPath]   = useState(null);
  const [configuringPath, setConfiguringPath] = useState(null);    // PathConfig used by the post-record wizard
  const [editingPath, setEditingPath]     = useState(null);        // PathConfig used to edit an existing path

  const refreshPaths = useCallback(async () => {
    try {
      const res = await fetch('/api/paths');
      if (res.ok) setPaths(await res.json());
    } catch {}
  }, []);

  // Open the CONFIGURE screen for a path (re-fetches latest config to avoid stale state).
  // Used after recording and when the user clicks an unconfigured path in the sidebar.
  const openConfigure = useCallback(async (folder) => {
    try {
      const res = await fetch(`/api/paths/${encodeURIComponent(folder)}`);
      if (!res.ok) throw new Error('Path not found.');
      const full = await res.json();
      setConfiguringPath(full);
      setView('configure');
    } catch (err) {
      alert(err.message);
    }
  }, []);

  // Open the editor for an existing path (re-fetches the latest config to avoid stale state).
  const openEditor = useCallback(async (pathSummary) => {
    try {
      const res = await fetch(`/api/paths/${encodeURIComponent(pathSummary._folder)}`);
      if (!res.ok) throw new Error('Path not found.');
      const full = await res.json();
      setEditingPath(full);
      setView('edit');
    } catch (err) {
      alert(err.message);
    }
  }, []);

  // A path is "unconfigured" if it still has no SKU pattern — i.e. a fresh
  // recording the user hasn't named/configured yet. Clicking it should open the
  // Configure screen, not the listing screen (which would be a dead end).
  const isUnconfigured = (p) => !p || !p.skuPattern;

  function handleSelectPath(p) {
    setSelectedPath(p);
    if (isUnconfigured(p)) openConfigure(p._folder);
    else setView('list');
  }

  useEffect(() => { refreshPaths(); }, [refreshPaths]);

  // ─── WebSocket — central connection shared via context ─────────────────────
  const ws = useWebSocket((msg) => {
    // After recording finishes, automatically jump to the configure screen.
    // Use the folder the recorder actually saved to (path details are entered
    // here in the app, so the folder name isn't derived from the path name).
    if (msg.type === 'event' && msg.event === 'recording_complete' && msg.pathConfig) {
      const cfg = msg.pathConfig;
      setConfiguringPath({ ...cfg, _folder: cfg._folder });
      setView('configure');
      refreshPaths();
    }
  });

  // ─── Fallback: poll for a finished recording while the record view is open ──
  // WHY: the recording_complete WS event can be missed if the app tab is
  // backgrounded/throttled while the user watches the Chromium window. Without
  // this, the user would be stuck on "Recording in Progress" forever. We poll
  // the paths list; when a fresh unconfigured recording_* path appears, we jump
  // to the configure screen — same destination as the WS event, just resilient.
  useEffect(() => {
    if (view !== 'record') return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/paths');
        if (!res.ok) return;
        const list = await res.json();
        if (cancelled) return;
        setPaths(list);
        const fresh = list
          .filter((p) => p._folder?.startsWith('recording_') && isUnconfigured(p))
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
        if (fresh) {
          clearInterval(timer);
          openConfigure(fresh._folder);
        }
      } catch {}
    }, 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [view, openConfigure]);

  return (
    <WSContext.Provider value={ws}>
      <div className="flex h-screen bg-gray-50 font-sans text-gray-800">
        <Sidebar
          paths={paths}
          activePath={selectedPath}
          onSelectPath={handleSelectPath}
          onNewPath={() => setView('record')}
          onSettings={() => setView('settings')}
        />

        <main className="flex-1 overflow-y-auto">
          {view === 'welcome' && <Welcome onRecord={() => setView('record')} />}
          {view === 'list'    && (
            <ListingForm
              path={selectedPath}
              onRefresh={refreshPaths}
              onEdit={() => openEditor(selectedPath)}
            />
          )}
          {view === 'record'  && <RecordWizard onCancel={() => setView('welcome')} />}
          {view === 'configure' && (
            <PathConfig
              mode="configure"
              path={configuringPath}
              onDone={async () => {
                await refreshPaths();
                // Re-fetch so the listing screen shows the just-entered name/SKU.
                const refreshed = await fetch(`/api/paths/${encodeURIComponent(configuringPath._folder)}`).then((r) => r.json()).catch(() => null);
                setSelectedPath(refreshed || configuringPath);
                setConfiguringPath(null);
                setView('list');
              }}
              onCancel={() => { setConfiguringPath(null); setView('list'); }}
            />
          )}
          {view === 'edit' && (
            <PathConfig
              mode="edit"
              path={editingPath}
              onDone={async () => {
                await refreshPaths();
                // Refresh the selected path so the listing form reflects edits immediately.
                const refreshed = await fetch(`/api/paths/${encodeURIComponent(editingPath._folder)}`).then((r) => r.json()).catch(() => null);
                setSelectedPath(refreshed || editingPath);
                setEditingPath(null);
                setView('list');
              }}
              onCancel={() => { setEditingPath(null); setView('list'); }}
            />
          )}
          {view === 'settings' && (
            <Settings
              onPathsChanged={refreshPaths}
              paths={paths}
              onEditPath={openEditor}
            />
          )}
        </main>
      </div>
    </WSContext.Provider>
  );
}

function Welcome({ onRecord }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-md p-8">
        <p className="text-6xl mb-6">🛍️</p>
        <h1 className="text-3xl font-bold mb-3">Meesho Lister</h1>
        <p className="text-gray-500 mb-8">
          Automate Meesho product listings. Record a product type once, then list new products with a single click.
        </p>
        <button
          onClick={onRecord}
          className="px-6 py-3 bg-meesho-pink text-white rounded-lg font-medium hover:bg-meesho-dark transition-colors"
        >
          Record Your First Path
        </button>
        <p className="text-xs text-gray-400 mt-6">
          Or pick a saved path from the sidebar to list a product.
        </p>
      </div>
    </div>
  );
}
