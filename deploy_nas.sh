#!/usr/bin/env bash
sudo rm -rf /volume1/docker/openclaw/.openclaw/*
sudo mkdir -p /volume1/docker/openclaw/.openclaw/workspace
sudo chmod 777 /volume1/docker/openclaw/.openclaw/workspace
./docker-setup.sh

# Add controlUi configuration to openclaw.json
echo "Updating openclaw.json with controlUi configuration..."
OPENCLAW_CONFIG="/volume1/docker/openclaw/.openclaw/openclaw.json"
if [ -f "$OPENCLAW_CONFIG" ]; then
  echo "Found openclaw.json at $OPENCLAW_CONFIG"
  if command -v jq &> /dev/null; then
    echo "Using jq to update configuration..."
    if sudo jq '.gateway.controlUi = {"enabled": true, "allowInsecureAuth": true}' "$OPENCLAW_CONFIG" > "$OPENCLAW_CONFIG.tmp" && sudo mv "$OPENCLAW_CONFIG.tmp" "$OPENCLAW_CONFIG"; then
      echo "✓ Successfully updated openclaw.json with controlUi configuration"
    else
      echo "✗ Failed to update openclaw.json"
      exit 1
    fi
  elif command -v python3 &> /dev/null; then
    echo "Using python3 to update configuration..."
    if sudo python3 -c "import json, sys; c=json.load(open('$OPENCLAW_CONFIG')); c.setdefault('gateway', {})['controlUi'] = {'enabled': True, 'allowInsecureAuth': True}; json.dump(c, open('$OPENCLAW_CONFIG', 'w'), indent=2)"; then
      echo "✓ Successfully updated openclaw.json with controlUi configuration"
    else
      echo "✗ Failed to update openclaw.json"
      exit 1
    fi
  else
    echo "✗ Error: Neither jq nor python3 found. Cannot update openclaw.json"
    exit 1
  fi
else
  echo "⚠ Warning: openclaw.json not found at $OPENCLAW_CONFIG"
  echo "  The file should be created by docker-setup.sh. Continuing..."
fi