#!/bin/bash
# Poll notification file and trigger immediate wake using cron tool
# Run in background: bash poll-notifications.sh &

NOTIF_FILE="/tmp/oauth3-notifications.log"
LAST_READ=0

echo "🔔 Polling $NOTIF_FILE for OAuth3 notifications..."

while true; do
  if [ -f "$NOTIF_FILE" ]; then
    CURRENT_SIZE=$(stat -c%s "$NOTIF_FILE" 2>/dev/null || stat -f%z "$NOTIF_FILE" 2>/dev/null || echo 0)
    
    if [ "$CURRENT_SIZE" -gt "$LAST_READ" ]; then
      # Read new content
      NEW_CONTENT=$(tail -c +$((LAST_READ + 1)) "$NOTIF_FILE")
      
      if [ -n "$NEW_CONTENT" ]; then
        echo "📨 New notification detected:"
        echo "$NEW_CONTENT"
        
        # Use the cron tool to wake agent
        # Note: This calls the tool in the current session context
        echo "$NEW_CONTENT" | while IFS= read -r line; do
          if [ -n "$line" ]; then
            echo "⏰ Triggering wake..."
            # The cron tool is available in the agent's environment
            node -e "
              const tool = require('/usr/lib/node_modules/openclaw/dist/agent/tools/cron.js');
              tool.cron({ action: 'wake', text: '${line}', mode: 'now' }).then(
                result => console.log('✅ Wake triggered:', JSON.stringify(result)),
                error => console.error('❌ Wake failed:', error.message)
              );
            " 2>&1
          fi
        done
        
        LAST_READ=$CURRENT_SIZE
      fi
    fi
  fi
  
  sleep 2
done
