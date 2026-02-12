#!/usr/bin/env node
/**
 * Simple HTTP server that receives notifications from proxy and triggers immediate cron wake
 * Run this in the background: node notify-agent.js &
 */

const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const PORT = 18790;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/notify') {
    let body = '';
    
    req.on('data', chunk => { body += chunk; });
    
    req.on('error', (error) => {
      console.error('❌ Request error:', error);
      try {
        res.writeHead(500);
        res.end();
      } catch (e) {}
    });
    
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body);
        console.log(`📨 Notification: ${message}`);
        
        // Write to notification file (for heartbeat backup)
        const timestamp = new Date().toISOString();
        require('fs').appendFileSync('/tmp/oauth3-notifications.log', `${timestamp} ${message}\n`);
        
        // Trigger immediate system event to main session
        try {
          const escapedMessage = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
          const { stdout } = await execAsync(`openclaw system event --text "${escapedMessage}" --mode now`);
          console.log(`✅ System event triggered: ${message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Notification sent via system event' }));
        } catch (wakeError) {
          console.error(`⚠️ System event failed:`, wakeError.message);
          console.error(`  Full error:`, wakeError.stderr || wakeError.stdout);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Notification logged to file (system event failed)' }));
        }
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
  console.log(`📁 Writing notifications to /tmp/oauth3-notifications.log`);
});

// Prevent crashes
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  console.log('  Process continuing...');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection:', reason);
  console.log('  Process continuing...');
});
