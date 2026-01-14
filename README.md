# Meridian Browse

Intelligent browser automation for AI. Control your actual logged-in browser tabs with token-efficient structured DOM representation.

## Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│   MCP Server    │◄──────────────────►│ Chrome Extension│
│   (Node.js)     │   localhost:9333   │  (Manifest V3)  │
└─────────────────┘                    └─────────────────┘
        ▲                                      │
        │ stdio                                │ chrome.* APIs
        │                                      ▼
┌─────────────────┐                    ┌─────────────────┐
│  Claude Code    │                    │  Your Browser   │
│  / Any MCP Host │                    │  (logged in)    │
└─────────────────┘                    └─────────────────┘
```

## Quick Start

### 1. Install dependencies

```bash
npm install
cd packages/server && npm install
cd ../shared && npm install
```

### 2. Build the server

```bash
cd packages/shared && npm run build
cd ../server && npm run build
```

### 3. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select `packages/extension` folder

### 4. Configure Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "meridian-browse": {
      "command": "node",
      "args": ["/path/to/meridian-browse/packages/server/dist/index.js"]
    }
  }
}
```

### 5. Test the connection

In Claude Code, try:
- `ping` - Should return "pong" from the extension
- `tabs_list` - Should list your open browser tabs

## Development

```bash
# Watch mode for server
pnpm --filter @meridian/server dev

# Build everything
pnpm build
```

## Project Structure

```
meridian-browse/
├── packages/
│   ├── extension/     # Chrome extension (Manifest V3)
│   │   ├── manifest.json
│   │   └── src/
│   │       ├── background.js  # Service worker, WebSocket connection
│   │       ├── popup.html     # Extension popup UI
│   │       └── popup.js
│   ├── server/        # MCP server
│   │   └── src/
│   │       └── index.ts       # WebSocket + MCP bridge
│   └── shared/        # Shared types and protocols
│       └── src/
│           └── index.ts
└── package.json       # Workspace root
```

## License

MIT
