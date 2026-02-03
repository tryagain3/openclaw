#!/usr/bin/env bash

# Set Gemini API key (required for non-interactive onboarding)
# You can either:
# 1. Set it here directly (uncomment and replace with your API key):
# export OPENCLAW_GEMINI_API_KEY="your-gemini-api-key-here"
#
# 2. Or set it before running: export OPENCLAW_GEMINI_API_KEY="your-key" && ./deploy_nas.sh
# 3. Or pass it inline: OPENCLAW_GEMINI_API_KEY="your-key" ./deploy_nas.sh
#
# If not set, docker-setup.sh will exit with an error asking for it.

sudo rm -rf /volume1/docker/openclaw/.openclaw/*
sudo mkdir -p /volume1/docker/openclaw/.openclaw/workspace
sudo chmod 777 /volume1/docker/openclaw/.openclaw/workspace
export OPENCLAW_GEMINI_API_KEY="AIzaSyBIm02Uf2KuuiVEbtbMu7uR2kpLvhlT7ok"
./docker-setup.sh

# Add controlUi configuration and set model to gemini-2.0-flash
echo "Updating openclaw.json with controlUi configuration and model..."
OPENCLAW_CONFIG="/volume1/docker/openclaw/.openclaw/openclaw.json"
if [ -f "$OPENCLAW_CONFIG" ]; then
  echo "Found openclaw.json at $OPENCLAW_CONFIG"
  if command -v python3 &> /dev/null; then
    echo "Using python3 to update configuration..."
    if sudo python3 -c "
import json
with open('$OPENCLAW_CONFIG') as f:
    c = json.load(f)
# Update gateway config
g = c.setdefault('gateway', {})
g['controlUi'] = {'enabled': True, 'allowInsecureAuth': True}
# Reorder: known keys first, then others
ordered = {k: g[k] for k in ['mode', 'auth', 'port', 'bind', 'controlUi', 'tailscale'] if k in g}
ordered.update({k: v for k, v in g.items() if k not in ordered})
c['gateway'] = ordered
# Update agents config to use gemini-2.0-flash
a = c.setdefault('agents', {})
d = a.setdefault('defaults', {})
d['model'] = {'primary': 'google/gemini-2.0-flash'}
d['imageModel'] = {'primary': 'google/gemini-2.0-flash'}
# Ensure model is in allowlist
models = d.setdefault('models', {})
models['google/gemini-2.0-flash'] = models.get('google/gemini-2.0-flash', {})
with open('$OPENCLAW_CONFIG', 'w') as f:
    json.dump(c, f, indent=2)
"; then
      echo "✓ Successfully updated openclaw.json with controlUi configuration and gemini-2.0-flash model"
    else
      echo "✗ Failed to update openclaw.json"
      exit 1
    fi
  else
    echo "✗ Error: python3 not found. Cannot update openclaw.json"
    exit 1
  fi
else
  echo "⚠ Warning: openclaw.json not found at $OPENCLAW_CONFIG"
  echo "  The file should be created by docker-setup.sh. Continuing..."
fi

# Open Control UI in browser with gateway token
echo ""
echo "==> Opening Control UI in browser..."
if [ -f "$OPENCLAW_CONFIG" ]; then
  # Read gateway config from openclaw.json (no fallbacks)
  GATEWAY_CONFIG=$(sudo python3 -c "
import json
with open('$OPENCLAW_CONFIG') as f:
    c = json.load(f)
gateway = c.get('gateway', {})
port = gateway.get('port')
bind = gateway.get('bind')
token = gateway.get('auth', {}).get('token')
if port and bind and token:
    print(f'{port}|{bind}|{token}')
" 2>/dev/null)
  
  if [ -n "$GATEWAY_CONFIG" ]; then
    IFS='|' read -r GATEWAY_PORT GATEWAY_BIND GATEWAY_TOKEN <<< "$GATEWAY_CONFIG"
    
    
    CONTROL_UI_URL="http://127.0.0.1:${GATEWAY_PORT}/?token=${GATEWAY_TOKEN}"
    echo "⚠️  No browser command found. Please open manually:"
    echo "   $CONTROL_UI_URL"
  fi
else
  echo "⚠️  Warning: openclaw.json not found at $OPENCLAW_CONFIG"
fi