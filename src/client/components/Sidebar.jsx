import React from 'react';

export default function Sidebar({ paths, activePath, onSelectPath, onNewPath, onSettings, profiles = [], activeProfileId, onSwitchProfile }) {
  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
      <div className="p-4 border-b border-gray-200">
        <h1 className="text-lg font-bold text-meesho-pink flex items-center gap-2">
          <span>🛍️</span>Meesho Lister
        </h1>
      </div>

      {/* Active account switcher — every recording & listing uses this account. */}
      {profiles.length > 0 && (
        <div className="px-3 pt-3">
          <label className="block text-xs text-gray-400 uppercase tracking-wider px-1 mb-1">Account</label>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">👤</span>
            <select
              value={activeProfileId || ''}
              onChange={(e) => onSwitchProfile(e.target.value)}
              className="w-full pl-8 pr-2 py-2 text-sm font-medium border border-gray-300 rounded-lg bg-gray-50 text-gray-800 appearance-none cursor-pointer hover:border-meesho-pink focus:border-meesho-pink focus:outline-none"
              title="Switch Meesho account — each has its own paths"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.hasPassword ? '' : ' (no login set)'}
                </option>
              ))}
            </select>
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none text-xs">▾</span>
          </div>
        </div>
      )}

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        <p className="text-xs text-gray-400 uppercase tracking-wider px-2 mb-2">Saved Paths</p>

        {paths.length === 0 && (
          <p className="text-sm text-gray-400 px-2 py-4 text-center">
            No paths yet.<br/>Record one to start.
          </p>
        )}

        {paths.map((p) => {
          const isActive = activePath?._folder === p._folder;
          const ready = isPathReady(p);
          return (
            <button
              key={p._folder}
              onClick={() => onSelectPath(p)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors group
                ${isActive ? 'bg-meesho-light text-meesho-dark font-medium' : 'text-gray-700 hover:bg-gray-100'}`}
              title={ready ? 'Ready to use' : 'Needs configuration — open this path to finish setup'}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate flex-1">{p.name}</span>
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ready ? 'bg-green-500' : 'bg-amber-500'}`} />
              </div>
              {!ready && (
                <span className="block text-xs text-amber-700 mt-0.5">Needs setup</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-gray-200 space-y-1">
        <button
          onClick={onNewPath}
          className="w-full px-3 py-2 bg-meesho-pink text-white rounded-lg text-sm font-medium hover:bg-meesho-dark transition-colors"
        >
          + Record New Path
        </button>
        <button
          onClick={onSettings}
          className="w-full px-3 py-2 text-gray-600 rounded-lg text-sm hover:bg-gray-100 transition-colors"
        >
          ⚙️ Settings
        </button>
      </div>
    </aside>
  );
}

// A path is "ready" when shared images are uploaded AND at least one field has
// a non-default type (someone has gone through the configure step).
function isPathReady(p) {
  if (!p._sharedImagesReady) return false;
  // After recording, all fields default to 'fixed'. Once configured, at least
  // one is usually 'ai' or 'sku'. Heuristic, not strict.
  return (p.fields || []).some((f) => f.type === 'ai' || f.type === 'sku' || f.type === 'image');
}
