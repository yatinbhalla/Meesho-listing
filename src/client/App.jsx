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

  useEffect(() => { refreshPaths(); }, [refreshPaths]);

  // ─── WebSocket — central connection shared via context ─────────────────────
  const ws = useWebSocket((msg) => {
    // After recording finishes, automatically jump to the configure screen.
    if (msg.type === 'event' && msg.event === 'recording_complete' && msg.pathConfig) {
      setConfiguringPath({ ...msg.pathConfig, _folder: msg.pathConfig.name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) });
      setView('configure');
      refreshPaths();
    }
  });

  return (
    <WSContext.Provider value={ws}>
      <div className="flex h-screen bg-gray-50 font-sans text-gray-800">
        <Sidebar
          paths={paths}
          activePath={selectedPath}
          onSelectPath={(p) => { setSelectedPath(p); setView('list'); }}
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
                setSelectedPath(configuringPath);
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
