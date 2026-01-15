# Helios

Browser automation for AI agents. Control your actual logged-in browser sessions with Claude Code or any MCP-compatible AI assistant.

## Why Helios?

Unlike Puppeteer or Playwright that spawn isolated browser instances, Helios connects to your **real browser** with your **real sessions**. This means:

- **Already logged in** - Access sites where you're authenticated (banking, email, internal tools)
- **Your cookies and state** - No need to handle authentication flows
- **Token efficient** - Structured DOM representation uses ~400 tokens vs ~1500 for screenshots
- **Learnable** - Site knowledge and guides persist across sessions

## Architecture

```
┌─────────────────┐      Native       ┌─────────────────┐      WebSocket     ┌─────────────────┐
│  Claude Code    │◄────Messaging────►│  Native Host    │◄──────────────────►│ Chrome Extension│
│  / MCP Host     │                   │  (Bridge)       │   localhost:9333   │  (Manifest V3)  │
└─────────────────┘                   └─────────────────┘                    └─────────────────┘
                                                                                     │
                                                                                     │ chrome.* APIs
                                                                                     ▼
                                                                             ┌─────────────────┐
                                                                             │  Your Browser   │
                                                                             │  (logged in)    │
                                                                             └─────────────────┘
```

## Installation

### 1. Clone and build

```bash
git clone https://github.com/aic-holdings/helios.git
cd helios

# Install dependencies
npm install
cd packages/shared && npm install && npm run build
cd ../native-host && npm install && npm run build
cd ../server && npm install && npm run build
cd ../..
```

### 2. Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `packages/extension` folder

### 3. Install the Native Messaging Host

The native host bridges Chrome's native messaging to the MCP server.

**macOS/Linux:**
```bash
# Create the native host manifest
mkdir -p ~/.config/google-chrome/NativeMessagingHosts  # Linux
# or: mkdir -p ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts  # macOS

# Create manifest file (adjust path to your helios location)
cat > ~/.config/google-chrome/NativeMessagingHosts/com.helios.native.json << 'EOF'
{
  "name": "com.helios.native",
  "description": "Helios Native Messaging Host",
  "path": "/absolute/path/to/helios/packages/native-host/dist/index.js",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
EOF
```

Replace:
- `/absolute/path/to/helios` with your actual path
- `YOUR_EXTENSION_ID` with the ID shown in `chrome://extensions`

**Make the host executable:**
```bash
chmod +x /path/to/helios/packages/native-host/dist/index.js
```

### 4. Configure Claude Code

Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json` or via `/settings`):

```json
{
  "mcpServers": {
    "helios": {
      "command": "node",
      "args": ["/path/to/helios/packages/server/dist/index.js"]
    }
  }
}
```

### 5. Verify installation

1. Click the Helios extension icon - should show "Connected"
2. In Claude Code, the `helios` tools should be available
3. Try: "List my browser tabs" - should show your open tabs

## Available Tools

### Navigation & Tabs
- `tabs_list` - List all open tabs
- `navigate` - Go to URL or back/forward
- `tab_activate` - Switch to a specific tab

### Page Interaction
- `read_page` - Get structured DOM (token-efficient)
- `screenshot` - Capture visible area as image
- `click` - Click elements by selector or coordinates
- `type` - Type text into focused element
- `scroll` - Scroll page or elements
- `mouse_click` - Click at specific coordinates
- `keyboard_press` - Press keyboard keys

### Downloads
- `download` - Download file from URL
- `download_status` - Check download progress

### Learning & Memory
- `site_knowledge_get` - Retrieve learned patterns for a domain
- `site_knowledge_save` - Save patterns for future sessions
- `site_knowledge_list` - List all known domains
- `guide_list` - List available automation guides
- `guide_read` - Read a specific guide
- `guide_search` - Search guides for keywords

## Configuration

### Port Configuration

By default, Helios uses port 9333. To run multiple instances:

**MCP Server:** Set `HELIOS_PORT` environment variable:
```json
{
  "mcpServers": {
    "helios": {
      "command": "node",
      "args": ["/path/to/helios/packages/server/dist/index.js"],
      "env": {
        "HELIOS_PORT": "9334"
      }
    }
  }
}
```

**Native Host:** Edit `~/.helios/config.json`:
```json
{
  "port": 9334
}
```

### Site Knowledge

Helios persists learned patterns in `~/.helios/sites/`. Example:

```json
{
  "domain": "example.com",
  "navigation": {
    "login_page": "/auth/login",
    "dashboard": "/app/dashboard"
  },
  "patterns": {
    "submit_button": "button[type=submit]"
  },
  "gotchas": [
    "Modal appears after 2 seconds on first visit"
  ],
  "updated": "2025-01-15"
}
```

### Guides

General automation patterns live in `~/.helios/guides/` as markdown files. Use `guide_search` to find relevant guidance when stuck.

## Security Considerations

- **Local only** - All communication stays on localhost
- **Your browser** - Helios accesses your actual sessions; be mindful of what you automate
- **No data collection** - Helios doesn't phone home or collect any data
- **Extension permissions** - The extension requires broad permissions to interact with pages

## Development

```bash
# Build all packages
cd packages/shared && npm run build
cd ../native-host && npm run build
cd ../server && npm run build

# Run server in development
cd packages/server && npm run dev
```

## Project Structure

```
helios/
├── packages/
│   ├── extension/      # Chrome extension (Manifest V3)
│   │   ├── manifest.json
│   │   ├── src/
│   │   │   ├── background.js   # Service worker
│   │   │   ├── popup.html/js   # Extension popup
│   │   │   └── icons/
│   ├── native-host/    # Native messaging bridge
│   │   └── src/index.ts
│   ├── server/         # MCP server
│   │   └── src/index.ts
│   └── shared/         # Shared types
│       └── src/index.ts
├── LICENSE
└── README.md
```

## Troubleshooting

**Extension shows "Disconnected"**
- Ensure the MCP server is running
- Check that native host manifest path is correct
- Verify the extension ID in native host manifest matches

**Tools not appearing in Claude Code**
- Run `/mcp` to reconnect
- Check Claude Code logs for MCP errors

**Commands timing out**
- Some pages take longer to load
- Check browser console for errors

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.
