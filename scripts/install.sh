#!/bin/bash
# Helios Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/aic-holdings/helios/main/scripts/install.sh | bash

set -e

HELIOS_DIR="$HOME/.helios"
INSTALL_DIR="$HELIOS_DIR/app"
REPO_URL="https://github.com/aic-holdings/helios.git"

echo "🌞 Installing Helios..."

# Create directories
mkdir -p "$HELIOS_DIR"
mkdir -p "$HELIOS_DIR/sites"
mkdir -p "$HELIOS_DIR/guides"

# Clone or update repo
if [ -d "$INSTALL_DIR" ]; then
    echo "📦 Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull origin main
else
    echo "📦 Cloning repository..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install and build
echo "🔨 Building packages..."
cd packages/shared && npm install && npm run build
cd ../native-host && npm install && npm run build
cd ../server && npm install && npm run build
cd ../..

# Detect OS and set native messaging path
if [[ "$OSTYPE" == "darwin"* ]]; then
    NATIVE_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    NATIVE_HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
else
    echo "❌ Unsupported OS: $OSTYPE"
    echo "   Please set up native messaging manually."
    exit 1
fi

mkdir -p "$NATIVE_HOST_DIR"

# Get extension ID (user needs to provide this after loading extension)
echo ""
echo "📌 Next step: Load the Chrome extension"
echo "   1. Open Chrome → chrome://extensions"
echo "   2. Enable 'Developer mode' (top right)"
echo "   3. Click 'Load unpacked'"
echo "   4. Select: $INSTALL_DIR/packages/extension"
echo ""
read -p "   Enter the Extension ID shown in Chrome: " EXTENSION_ID

if [ -z "$EXTENSION_ID" ]; then
    echo "❌ Extension ID required. Run this script again after loading the extension."
    exit 1
fi

# Create native messaging host manifest
NATIVE_HOST_PATH="$INSTALL_DIR/packages/native-host/dist/index.js"
cat > "$NATIVE_HOST_DIR/com.helios.native.json" << EOF
{
  "name": "com.helios.native",
  "description": "Helios Native Messaging Host",
  "path": "$NATIVE_HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo "✅ Native messaging host configured"

# Create default config
cat > "$HELIOS_DIR/config.json" << EOF
{
  "port": 9333
}
EOF

# Show MCP config
SERVER_PATH="$INSTALL_DIR/packages/server/dist/index.js"
echo ""
echo "✅ Helios installed successfully!"
echo ""
echo "📋 Add this to your Claude Code MCP settings:"
echo ""
echo '{'
echo '  "mcpServers": {'
echo '    "helios": {'
echo "      \"command\": \"node\","
echo "      \"args\": [\"$SERVER_PATH\"]"
echo '    }'
echo '  }'
echo '}'
echo ""
echo "🌞 Enjoy browser automation with Helios!"
