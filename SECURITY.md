# Helios Security Model

This document describes the security features and threat model for Helios.

## Threat Model

Helios provides AI agents with access to your actual browser sessions. This is powerful but requires careful security considerations.

### What Helios CAN Access
- Your logged-in sessions (banking, email, etc.)
- Page content and DOM structure
- Ability to click, type, navigate, and download

### What Helios CANNOT Do
- Access browser passwords or saved credentials
- Read cookies directly (only interact with pages)
- Bypass browser security (CORS, CSP, etc.)
- Access other browser profiles

## Security Features

### 1. WebSocket Authentication

Connections between the native host and MCP server require a cryptographically secure auth token.

- Token is auto-generated on first run using `crypto.randomBytes(32)`
- Stored in `~/.helios/config.json`
- Native host reads token from config and includes it in WebSocket URL
- Invalid tokens are rejected with connection closed

Additionally, origin validation prevents CSRF and DNS rebinding attacks by only allowing connections from:
- Chrome extensions (`chrome-extension://`)
- Localhost (`http://localhost`, `http://127.0.0.1`)
- Native messaging (no origin)

### 2. Emergency Stop

Immediately halt ALL browser automation:

```
emergency_stop(true)   # Block all actions
emergency_stop(false)  # Resume normal operation
```

When enabled, all tools except security tools return an error.

### 3. Rate Limiting

Prevents runaway automation with dual limits:
- **Per-second**: 5 actions/second (burst protection)
- **Per-minute**: 60 actions/minute (sustained limit)

Configure in `~/.helios/config.json`:
```json
{
  "rateLimit": {
    "enabled": true,
    "maxActionsPerSecond": 5,
    "maxActionsPerMinute": 60
  }
}
```

Read-only tools (ping, tabs_list, read_page, screenshot) are not rate-limited.

### 4. Domain Restrictions

Control which sites can be automated using proper URL parsing (not string matching).

**Blocklist** (always blocked):
- `chrome://` URLs
- `chrome-extension://` URLs
- `file://` URLs

**Allowlist** (optional - empty = allow all):
```json
{
  "domains": {
    "allowlist": ["github.com", "example.com"],
    "blocklist": ["chrome://", "chrome-extension://", "file://"]
  }
}
```

Domain matching uses proper hostname extraction:
- `github.com` matches `github.com` and `api.github.com`
- Prevents bypass attempts like `evil-github.com` or `github.com.evil.com`

### 5. Audit Logging

All browser actions are logged to `~/.helios/logs/YYYY-MM-DD.jsonl`.

Each entry contains:
- Timestamp
- Action name
- Arguments
- Result (success/error/blocked)
- Duration
- Error message (if any)

View logs:
```
audit_logs(days=1, limit=50)
```

### 6. Cryptographically Secure Message IDs

All messages between components use cryptographically secure IDs:
- Generated using `crypto.randomBytes(16)`
- Collision detection prevents ID reuse
- Prevents replay attacks

### 7. Security Tools

| Tool | Purpose |
|------|---------|
| `security_status` | View current security state |
| `security_config` | View or update configuration |
| `emergency_stop` | Enable/disable kill switch |
| `audit_logs` | View recent action logs |

## Configuration

Security config is stored in `~/.helios/config.json`:

```json
{
  "port": 9333,
  "authToken": "auto-generated-64-char-hex-token",
  "rateLimit": {
    "enabled": true,
    "maxActionsPerSecond": 5,
    "maxActionsPerMinute": 60
  },
  "domains": {
    "allowlist": [],
    "blocklist": ["chrome://", "chrome-extension://", "file://"]
  },
  "sensitiveActions": {
    "requireConfirmation": false,
    "actions": ["download", "type", "click", "form_fill"]
  },
  "auditLog": {
    "enabled": true,
    "retentionDays": 30
  },
  "emergencyStop": false
}
```

## Best Practices

1. **Review audit logs** regularly to understand what actions are being taken
2. **Use domain allowlist** for sensitive workflows to prevent navigation to unexpected sites
3. **Keep rate limits enabled** to prevent accidental infinite loops
4. **Use emergency stop** immediately if automation behaves unexpectedly
5. **Don't automate highly sensitive actions** like password changes or financial transfers
6. **Protect your config file** - it contains the auth token

## Extension Permissions

The Chrome extension requires these permissions:

| Permission | Purpose |
|------------|---------|
| `activeTab` | Interact with current tab |
| `tabs` | List and manage tabs |
| `scripting` | Execute scripts for DOM reading |
| `downloads` | Download files |
| `nativeMessaging` | Connect to MCP server |
| `<all_urls>` | Access any website (required for automation) |

## Reporting Security Issues

If you discover a security vulnerability, please:

1. **Do not** open a public GitHub issue
2. Email security concerns privately
3. Allow time for a fix before public disclosure

## Local-Only Architecture

All Helios communication stays on localhost:

```
Claude Code <-> MCP Server <-> Native Host <-> Extension
     |              |              |              |
   stdio      localhost:9333    Native Msg    Browser
             (authenticated)
```

No data is sent to external servers. All processing is local.
