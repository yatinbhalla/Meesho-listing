import { useEffect, useRef, useState } from 'react';

// WHY: Reconnect on close so the log panel keeps working even if the Express
// server restarts during development.
const RECONNECT_DELAY_MS = 3000;

/**
 * Subscribe to the server's WebSocket stream.
 *
 * @param {(msg: any) => void} [onMessage] - Optional callback fired for every message
 *                                            (after it has been added to `messages`).
 * @returns {{ messages: any[], status: 'connected'|'disconnected'|'error', clear: () => void }}
 */
export function useWebSocket(onMessage) {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('disconnected');
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  // Tracks intentional teardown so onclose doesn't schedule a reconnect when
  // React StrictMode runs the effect cleanup → mount cycle in development.
  // Without this, every dev-mount leaks a ghost connection that ALSO receives
  // every broadcast, causing every log line to appear twice in the UI.
  const teardownRef = useRef(false);
  // Keep latest onMessage in a ref so we don't reconnect every render.
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  function connect() {
    teardownRef.current = false;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setStatus('connected');

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
      const msg = { ...data, time };
      setMessages((prev) => [...prev, msg]);
      cbRef.current?.(msg);
    };

    ws.onclose = () => {
      setStatus('disconnected');
      // If the effect cleanup closed us, do NOT schedule a reconnect.
      // Otherwise the next StrictMode mount opens a fresh socket AND the
      // reconnect timer also fires → two live sockets, every message double.
      if (teardownRef.current) return;
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      setStatus('error');
      ws.close();
    };
  }

  useEffect(() => {
    connect();
    return () => {
      teardownRef.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return { messages, status, clear: () => setMessages([]) };
}
