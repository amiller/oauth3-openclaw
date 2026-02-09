#!/usr/bin/env node
/**
 * File watcher using inotify - no polling!
 * Watches /tmp/oauth3-notifications.log for changes and immediately triggers wake
 */

const fs = require('fs');
const { exec } = require('child_process');

const NOTIF_FILE = '/tmp/oauth3-notifications.log';
let lastSize = 0;

// Initialize file if doesn't exist
if (!fs.existsSync(NOTIF_FILE)) {
  fs.writeFileSync(NOTIF_FILE, '');
}

lastSize = fs.statSync(NOTIF_FILE).size;

console.log('👀 Watching', NOTIF_FILE, 'for changes (inotify - no polling!)');

// Use fs.watch (inotify on Linux) - triggers only on actual changes
fs.watch(NOTIF_FILE, (eventType, filename) => {
  if (eventType === 'change') {
    const currentSize = fs.statSync(NOTIF_FILE).size;
    
    if (currentSize > lastSize) {
      // New content added
      const newContent = fs.readFileSync(NOTIF_FILE, 'utf8').slice(lastSize);
      lastSize = currentSize;
      
      if (newContent.trim()) {
        console.log('\n📨 New notification detected!');
        console.log(newContent.trim());
        
        // Clear the file
        fs.writeFileSync(NOTIF_FILE, '');
        lastSize = 0;
        
        // THIS IS WHERE WE NEED TO TRIGGER THE WAKE
        // For now, just log it - Andrew needs to see the notification
        console.log('⚠️  Manual notification required - no auto-wake yet');
      }
    }
  }
});

console.log('✅ File watcher running (event-driven, not polling)\n');
