import React, { useEffect, useRef } from 'react';
import { useWS } from '../App.jsx';

// Real-time log panel — pulls messages from the shared WS context.
// Optional `topic` prop filters to messages tagged with that topic (e.g. 'run').
export default function LiveLog({ topic, height = 'h-64', emptyText = 'Waiting for activity...' }) {
  const { messages, status, clear } = useWS();
  const bottomRef = useRef(null);

  const visible = topic ? messages.filter((m) => !m.topic || m.topic === topic) : messages;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [visible.length]);

  const statusColor = { connected: 'bg-green-400', disconnected: 'bg-gray-500', error: 'bg-red-400' }[status];

  return (
    <div className="bg-gray-900 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-800">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="text-xs text-gray-400 font-mono flex-1">Live Log {topic ? `· ${topic}` : ''}</span>
        <button
          onClick={clear}
          className="text-xs text-gray-500 hover:text-gray-300 font-mono"
        >clear</button>
      </div>
      <div className={`log-panel ${height} overflow-y-auto p-4 font-mono text-xs space-y-1`}>
        {visible.length === 0 && (
          <p className="text-gray-600">{emptyText}</p>
        )}
        {visible.map((msg, i) => {
          const color = msg.type === 'error'   ? 'text-red-400'
                      : msg.type === 'success' ? 'text-green-400'
                      : msg.type === 'event'   ? 'text-meesho-pink'
                      : 'text-gray-300';
          return (
            <div key={i} className={`flex gap-2 ${color}`}>
              <span className="text-gray-600 shrink-0">{msg.time}</span>
              <span className="break-words">{msg.text}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
