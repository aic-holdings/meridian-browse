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

### Quick Install (macOS/Linux)

```bash
# Clone and build
git clone https://github.com/aic-holdings/helios.git
cd helios
cd packages/shared && npm install && npm run build
cd ../native-host && npm install && npm run build
cd ../server && npm install && npm run build
cd ../..

# Load extension in Chrome
# 1. Open chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" → select packages/extension folder
# 4. Copy the Extension ID shown

# Set up native messaging (run from repo root)
./scripts/setup-native-host.sh
```

### Configure Claude Code

Add to your MCP settings (`~/.claude.json` or via Claude Code `/settings`):

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

### Verify

1. Click the Helios extension icon → should show "Connected"
2. In Claude Code, try: "List my browser tabs"

---

<details>
<summary>Manual Installation</summary>

### 1. Clone and build

```bash
git clone https://github.com/aic-holdings/helios.git
cd helios
cd packages/shared && npm install && npm run build
cd ../native-host && npm install && npm run build
cd ../server && npm install && npm run build
```

### 2. Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `packages/extension` folder
5. Copy the **Extension ID** shown

### 3. Set up Native Messaging Host

**Linux:**
```bash
mkdir -p ~/.config/google-chrome/NativeMessagingHosts
cat > ~/.config/google-chrome/NativeMessagingHosts/com.helios.native.json << EOF
{
  "name": "com.helios.native",
  "description": "Helios Native Messaging Host",
  "path": "$(pwd)/packages/native-host/dist/index.js",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
EOF
```

**macOS:**
```bash
mkdir -p ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts
cat > ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.helios.native.json << EOF
{
  "name": "com.helios.native",
  "description": "Helios Native Messaging Host",
  "path": "$(pwd)/packages/native-host/dist/index.js",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
EOF
```

Replace `YOUR_EXTENSION_ID` with the ID from step 2.

### 4. Configure Claude Code

Add to MCP settings:

```json
{
  "mcpServers": {
    "helios": {
      "command": "node",
      "args": ["/absolute/path/to/helios/packages/server/dist/index.js"]
    }
  }
}
```

</details>

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

## Security

Helios includes security features to prevent misuse:

- **Emergency Stop** - `emergency_stop(true)` immediately halts all automation
- **Rate Limiting** - Default 60 actions/minute to prevent runaway loops
- **Domain Blocklist** - Prevent automation on sensitive URLs
- **Audit Logging** - All actions logged to `~/.helios/logs/`

See [SECURITY.md](SECURITY.md) for full details on the security model, configuration, and best practices.

### Quick Security Commands

```
security_status        # View current security state
emergency_stop(true)   # STOP all automation immediately
audit_logs(days=1)     # View recent actions
```

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
