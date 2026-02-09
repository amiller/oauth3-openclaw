#!/usr/bin/env node
/**
 * Simple HTTP server that receives notifications from proxy and triggers immediate cron wake
 * Run this in the background: node notify-agent.js &
 */

const http = require('http');

const PORT = 18790;
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/notify') {
    let body = '';
    
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body);
        console.log(`📨 Notification: ${message}`);
        
        // Trigger immediate wake via Gateway API
        const wakeResponse = await fetch(`${GATEWAY_URL}/api/cron/wake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: message,
            mode: 'now'
          })
        });
        
        if (wakeResponse.ok) {
          console.log(`✅ Wake triggered successfully`);
        } else {
          console.error(`❌ Wake failed: ${wakeResponse.status}`);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        console.error('Error:', error);
        res.writeHead(400);
        res.end();
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🔔 Notification receiver listening on http://127.0.0.1:${PORT}`);
  console.log(`📡 Will POST wake events to ${GATEWAY_URL}/api/cron/wake`);
});
