#!/bin/bash
# Watch for OAuth3 notifications and trigger immediate wake

NOTIF_FILE="/tmp/oauth3-notifications.log"
LAST_SIZE=0

while true; do
  if [ -f "$NOTIF_FILE" ]; then
    CURRENT_SIZE=$(stat -f%z "$NOTIF_FILE" 2>/dev/null || stat -c%s "$NOTIF_FILE" 2>/dev/null || echo 0)
    
    if [ "$CURRENT_SIZE" -gt "$LAST_SIZE" ]; then
      # New content detected
      NEW_LINES=$(tail -c +$((LAST_SIZE + 1)) "$NOTIF_FILE")
      
      # Trigger wake for each new notification
      while IFS= read -r line; do
        if [ -n "$line" ]; then
          openclaw cron wake --text "$line" --mode now 2>/dev/null || true
        fi
      done <<< "$NEW_LINES"
      
      LAST_SIZE=$CURRENT_SIZE
    fi
  fi
  
  sleep 2
done
