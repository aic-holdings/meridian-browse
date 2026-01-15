#!/bin/bash
# Set up native messaging host for Helios
# Run from the helios repo root: ./scripts/setup-native-host.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Detect OS and set native messaging path
if [[ "$OSTYPE" == "darwin"* ]]; then
    NATIVE_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    NATIVE_HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
else
    echo "❌ Unsupported OS: $OSTYPE"
    exit 1
fi

mkdir -p "$NATIVE_HOST_DIR"

echo "🌞 Helios Native Host Setup"
echo ""
echo "Extension ID is shown in chrome://extensions after loading the extension."
echo ""
read -p "Enter your Chrome Extension ID: " EXTENSION_ID

if [ -z "$EXTENSION_ID" ]; then
    echo "❌ Extension ID required."
    exit 1
fi

NATIVE_HOST_PATH="$REPO_DIR/packages/native-host/dist/index.js"

cat > "$NATIVE_HOST_DIR/com.helios.native.json" << EOF
{
  "name": "com.helios.native",
  "description": "Helios Native Messaging Host",
  "path": "$NATIVE_HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo ""
echo "✅ Native messaging host configured at:"
echo "   $NATIVE_HOST_DIR/com.helios.native.json"
echo ""
echo "🔄 Restart Chrome for changes to take effect."
