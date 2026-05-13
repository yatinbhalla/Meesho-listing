import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001/ws');
ws.on('open',  () => console.error('[ws] connected'));
ws.on('error', (e) => console.error('[ws] error:', e.message));
ws.on('close', () => { console.error('[ws] closed'); process.exit(0); });
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  const t = new Date().toLocaleTimeString('en-IN', { hour12: false });
  const tag = (m.type || 'log').toUpperCase().padEnd(7);
  const topic = m.topic ? `[${m.topic}]` : '';
  const ev = m.event ? ` <${m.event}>` : '';
  console.log(`${t}  ${tag}${topic}${ev}  ${m.text || ''}`);
});
process.on('SIGINT', () => { ws.close(); process.exit(0); });
