# Contributing to Helios

Thanks for your interest in contributing to Helios!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/helios.git`
3. Install dependencies and build (see README.md)
4. Create a branch: `git checkout -b my-feature`

## Development Setup

```bash
# Install and build all packages
cd packages/shared && npm install && npm run build
cd ../native-host && npm install && npm run build
cd ../server && npm install && npm run build
```

Load the extension from `packages/extension` in Chrome developer mode.

## Making Changes

### Code Style

- TypeScript for server and native-host packages
- Vanilla JavaScript for the Chrome extension (Manifest V3 service workers)
- Clear, descriptive variable and function names
- Comments for non-obvious logic

### Testing

Before submitting:

1. Build all packages successfully
2. Load the extension and verify connection
3. Test your changes with Claude Code or another MCP client
4. Check browser console and server logs for errors

### Commit Messages

Use clear, descriptive commit messages:

```
feat: Add keyboard shortcut support
fix: Handle disconnection during page navigation
docs: Update installation instructions for Windows
```

## Pull Requests

1. Update documentation if needed
2. Ensure all packages build without errors
3. Describe what your PR does and why
4. Link any related issues

## Reporting Issues

When reporting bugs, include:

- OS and Chrome version
- Steps to reproduce
- Expected vs actual behavior
- Any error messages from console/logs

## Architecture Notes

- **Extension** (`packages/extension`): Chrome Manifest V3 extension. Service worker connects via native messaging.
- **Native Host** (`packages/native-host`): Bridge between Chrome native messaging and WebSocket. Spawned by Chrome.
- **Server** (`packages/server`): MCP server that Claude Code connects to. Manages WebSocket connection to native host.
- **Shared** (`packages/shared`): Common types and constants.

## Questions?

Open an issue for questions about contributing.
