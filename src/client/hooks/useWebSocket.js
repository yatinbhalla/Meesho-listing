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
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Ignore a late open on a socket we've already replaced (StrictMode).
      if (wsRef.current !== ws) { ws.close(); return; }
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      // Drop messages from a stale socket that hasn't finished closing yet —
      // otherwise every broadcast would be processed once per live socket.
      if (wsRef.current !== ws) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
      const msg = { ...data, time };
      setMessages((prev) => [...prev, msg]);
      cbRef.current?.(msg);
    };

    ws.onclose = () => {
      // Only the CURRENT socket may schedule a reconnect. StrictMode's
      // mount→cleanup→mount cycle (and any reconnect) leaves an earlier socket
      // whose async onclose fires LATER — after connect() has already installed
      // a new socket. Without this identity check, that stale close schedules
      // its OWN reconnect, so you end up with several live sockets that each
      // receive every broadcast — doubling/tripling every log line and SKU.
      if (wsRef.current !== ws) return;
      setStatus('disconnected');
      if (teardownRef.current) return;
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setStatus('error');
      ws.close();
    };
  }

  useEffect(() => {
    teardownRef.current = false;
    connect();
    return () => {
      teardownRef.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return { messages, status, clear: () => setMessages([]) };
}
