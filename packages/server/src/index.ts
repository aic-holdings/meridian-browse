#!/usr/bin/env node
/**
 * Helios - MCP Server
 *
 * Bridges Claude (via MCP) to Chrome extension (via WebSocket)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Site knowledge storage
const HELIOS_DIR = path.join(os.homedir(), '.helios');
const SITES_DIR = path.join(HELIOS_DIR, 'sites');
const GUIDES_DIR = path.join(HELIOS_DIR, 'guides');
const LOGS_DIR = path.join(HELIOS_DIR, 'logs');
const CONFIG_FILE = path.join(HELIOS_DIR, 'config.json');

async function ensureDirs() {
  await fs.mkdir(SITES_DIR, { recursive: true });
  await fs.mkdir(GUIDES_DIR, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
}

// =============================================================================
// SECURITY MODULE
// =============================================================================

interface SecurityConfig {
  port: number;
  rateLimit: {
    enabled: boolean;
    maxActionsPerMinute: number;
  };
  domains: {
    allowlist: string[];  // Empty = allow all
    blocklist: string[];  // Always blocked
  };
  sensitiveActions: {
    requireConfirmation: boolean;
    actions: string[];  // Actions that need confirmation
  };
  auditLog: {
    enabled: boolean;
    retentionDays: number;
  };
  emergencyStop: boolean;  // When true, all actions are blocked
}

const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  port: 9333,
  rateLimit: {
    enabled: true,
    maxActionsPerMinute: 60,
  },
  domains: {
    allowlist: [],  // Empty = allow all
    blocklist: ['chrome://', 'chrome-extension://', 'file://'],
  },
  sensitiveActions: {
    requireConfirmation: false,  // Set to true to require confirmation
    actions: ['download', 'type', 'click', 'form_fill'],
  },
  auditLog: {
    enabled: true,
    retentionDays: 30,
  },
  emergencyStop: false,
};

let securityConfig: SecurityConfig = { ...DEFAULT_SECURITY_CONFIG };

// Load security config from file
async function loadSecurityConfig(): Promise<void> {
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    const loaded = JSON.parse(content);
    securityConfig = { ...DEFAULT_SECURITY_CONFIG, ...loaded };
  } catch {
    // Use defaults, save them
    await saveSecurityConfig();
  }
}

async function saveSecurityConfig(): Promise<void> {
  await ensureDirs();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(securityConfig, null, 2));
}

// Rate limiting
const actionTimestamps: number[] = [];

function checkRateLimit(): { allowed: boolean; remaining: number } {
  if (!securityConfig.rateLimit.enabled) {
    return { allowed: true, remaining: Infinity };
  }

  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  // Remove old timestamps
  while (actionTimestamps.length > 0 && actionTimestamps[0] < oneMinuteAgo) {
    actionTimestamps.shift();
  }

  const remaining = securityConfig.rateLimit.maxActionsPerMinute - actionTimestamps.length;

  if (remaining <= 0) {
    return { allowed: false, remaining: 0 };
  }

  actionTimestamps.push(now);
  return { allowed: true, remaining: remaining - 1 };
}

// Domain checking
function isDomainAllowed(url: string): { allowed: boolean; reason?: string } {
  // Check blocklist first
  for (const blocked of securityConfig.domains.blocklist) {
    if (url.startsWith(blocked) || url.includes(blocked)) {
      return { allowed: false, reason: `Domain blocked: ${blocked}` };
    }
  }

  // If allowlist is empty, allow all (except blocklist)
  if (securityConfig.domains.allowlist.length === 0) {
    return { allowed: true };
  }

  // Check allowlist
  for (const allowed of securityConfig.domains.allowlist) {
    if (url.includes(allowed)) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: 'Domain not in allowlist' };
}

// Audit logging
interface AuditLogEntry {
  timestamp: string;
  action: string;
  target?: string;
  args?: unknown;
  result: 'success' | 'error' | 'blocked';
  error?: string;
  duration_ms?: number;
}

async function auditLog(entry: Omit<AuditLogEntry, 'timestamp'>): Promise<void> {
  if (!securityConfig.auditLog.enabled) return;

  const fullEntry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(LOGS_DIR, `${today}.jsonl`);

  try {
    await ensureDirs();
    await fs.appendFile(logFile, JSON.stringify(fullEntry) + '\n');
  } catch (e) {
    console.error('[Helios] Failed to write audit log:', e);
  }
}

async function getAuditLogs(days: number = 1): Promise<AuditLogEntry[]> {
  const logs: AuditLogEntry[] = [];

  try {
    const files = await fs.readdir(LOGS_DIR);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    for (const file of files.filter(f => f.endsWith('.jsonl'))) {
      const dateStr = file.replace('.jsonl', '');
      if (new Date(dateStr) >= cutoff) {
        const content = await fs.readFile(path.join(LOGS_DIR, file), 'utf-8');
        for (const line of content.trim().split('\n')) {
          if (line) {
            try {
              logs.push(JSON.parse(line));
            } catch { /* skip malformed lines */ }
          }
        }
      }
    }
  } catch { /* no logs yet */ }

  return logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// Emergency stop
function isEmergencyStopped(): boolean {
  return securityConfig.emergencyStop;
}

async function setEmergencyStop(stopped: boolean): Promise<void> {
  securityConfig.emergencyStop = stopped;
  await saveSecurityConfig();
  await auditLog({
    action: 'emergency_stop',
    result: 'success',
    args: { stopped },
  });
}

interface SiteKnowledge {
  domain: string;
  notes?: string;
  navigation?: Record<string, string>;
  gotchas?: string[];
  patterns?: Record<string, string>;
  auth_stop?: string[];
  updated: string;
}

async function getSiteKnowledge(domain: string): Promise<SiteKnowledge | null> {
  try {
    const filePath = path.join(SITES_DIR, `${domain}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveSiteKnowledge(knowledge: SiteKnowledge): Promise<void> {
  await ensureDirs();
  const filePath = path.join(SITES_DIR, `${knowledge.domain}.json`);
  knowledge.updated = new Date().toISOString().split('T')[0];
  await fs.writeFile(filePath, JSON.stringify(knowledge, null, 2));
}

async function listSiteKnowledge(): Promise<string[]> {
  try {
    await ensureDirs();
    const files = await fs.readdir(SITES_DIR);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

// Guide functions
interface GuideInfo {
  name: string;
  title: string;
  description: string;
}

async function listGuides(): Promise<GuideInfo[]> {
  try {
    await ensureDirs();
    const files = await fs.readdir(GUIDES_DIR);
    const guides: GuideInfo[] = [];

    for (const file of files.filter(f => f.endsWith('.md') && !f.startsWith('_'))) {
      const name = file.replace('.md', '');
      const content = await fs.readFile(path.join(GUIDES_DIR, file), 'utf-8');
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : name;
      // Get first paragraph after title as description
      const descMatch = content.match(/^#.+\n\n(.+?)(\n\n|$)/s);
      const description = descMatch ? descMatch[1].slice(0, 100) : '';
      guides.push({ name, title, description });
    }
    return guides;
  } catch {
    return [];
  }
}

async function readGuide(name: string): Promise<string | null> {
  try {
    const filePath = path.join(GUIDES_DIR, `${name}.md`);
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function searchGuides(query: string): Promise<Array<{name: string; matches: string[]}>> {
  try {
    await ensureDirs();
    const files = await fs.readdir(GUIDES_DIR);
    const results: Array<{name: string; matches: string[]}> = [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    for (const file of files.filter(f => f.endsWith('.md'))) {
      const name = file.replace('.md', '');
      const content = await fs.readFile(path.join(GUIDES_DIR, file), 'utf-8');
      const contentLower = content.toLowerCase();

      // Check if any query word matches
      if (queryWords.some(word => contentLower.includes(word))) {
        // Extract matching lines for context
        const lines = content.split('\n');
        const matches: string[] = [];
        for (const line of lines) {
          if (queryWords.some(word => line.toLowerCase().includes(word))) {
            matches.push(line.trim());
            if (matches.length >= 3) break; // Limit context
          }
        }
        if (matches.length > 0) {
          results.push({ name, matches });
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

const CONFIG = {
  wsPort: parseInt(process.env.HELIOS_PORT || '9333', 10),
  requestTimeout: 30000,
};

// Extension connection state
let extensionSocket: WebSocket | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// Generate unique message ID
function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Send message to extension and wait for response
async function sendToExtension(type: string, payload?: unknown): Promise<unknown> {
  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
    throw new Error(
      'Browser extension not connected. Please ensure the Helios extension is installed and connected.'
    );
  }

  const id = generateMessageId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out after ${CONFIG.requestTimeout}ms`));
    }, CONFIG.requestTimeout);

    pendingRequests.set(id, { resolve, reject, timeout });

    extensionSocket!.send(JSON.stringify({ id, type, payload }));
  });
}

// Create WebSocket server for extension connection
function createWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ port: CONFIG.wsPort });

  console.error(`[Helios] WebSocket server listening on port ${CONFIG.wsPort}`);

  wss.on('connection', (socket) => {
    console.error('[Helios] Extension connected');

    // Close any existing connection
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      extensionSocket.close();
    }

    extensionSocket = socket;

    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        const { id, success, data: responseData, error } = message;

        const pending = pendingRequests.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(id);

          if (success) {
            pending.resolve(responseData);
          } else {
            pending.reject(new Error(error || 'Unknown error'));
          }
        }
      } catch (error) {
        console.error('[Helios] Error parsing message:', error);
      }
    });

    socket.on('close', () => {
      console.error('[Helios] Extension disconnected');
      if (extensionSocket === socket) {
        extensionSocket = null;
      }
    });

    socket.on('error', (error) => {
      console.error('[Helios] Socket error:', error);
    });
  });

  return wss;
}

// Create MCP server
function createMCPServer(): Server {
  const server = new Server(
    { name: 'helios', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'ping',
          description: 'Test connection to browser extension. Returns pong if connected.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'tabs_list',
          description: 'List all open browser tabs with their IDs, URLs, and titles.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'windows_list',
          description: 'List all browser windows including popups. Use this to find OAuth popups or other secondary windows.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'navigate',
          description: 'Navigate a tab to a URL. If no tabId provided, uses the active tab.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The URL to navigate to',
              },
              tabId: {
                type: 'number',
                description: 'Tab ID to navigate. If not provided, uses active tab.',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'click',
          description: 'Click an element on the page by CSS selector or coordinates. When using selector, use index parameter to click the nth matching element (0-indexed).',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              selector: {
                type: 'string',
                description: 'CSS selector of element to click',
              },
              index: {
                type: 'number',
                description: 'Index of element to click when multiple elements match the selector (0-indexed, default: 0). Use this to click the 2nd, 3rd, etc. matching element.',
              },
              x: {
                type: 'number',
                description: 'X coordinate to click (used if no selector)',
              },
              y: {
                type: 'number',
                description: 'Y coordinate to click (used if no selector)',
              },
            },
            required: [],
          },
        },
        {
          name: 'type',
          description: 'Type text into an input element.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              selector: {
                type: 'string',
                description: 'CSS selector of input element',
              },
              text: {
                type: 'string',
                description: 'Text to type',
              },
              clear: {
                type: 'boolean',
                description: 'Clear existing text before typing (default: true)',
              },
            },
            required: ['selector', 'text'],
          },
        },
        {
          name: 'read_page',
          description: 'PREFERRED: Get structured DOM representation. Returns interactive elements with refs. Uses ~200-500 tokens vs ~1500 for screenshots. Use this FIRST to understand page structure before taking actions. Only use screenshot if you need to verify visual layout.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              selector: {
                type: 'string',
                description: 'CSS selector to scope reading (default: body)',
              },
              maxElements: {
                type: 'number',
                description: 'Maximum elements to return (default: 100)',
              },
            },
            required: [],
          },
        },
        {
          name: 'navigate_and_read',
          description: 'EFFICIENT: Navigate to URL and immediately read page structure in one call. Saves a round-trip vs navigate + read_page separately.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The URL to navigate to',
              },
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              waitMs: {
                type: 'number',
                description: 'Milliseconds to wait after navigation (default: 1000)',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'screenshot',
          description: 'EXPENSIVE (~1500 tokens): Capture visible area as image. Only use when you MUST verify visual layout, colors, or positioning. For finding/clicking elements, use read_page instead (70% cheaper). Use clip parameter for partial screenshots to reduce tokens.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              format: {
                type: 'string',
                enum: ['jpeg', 'png'],
                description: 'Image format (default: jpeg - smaller/cheaper)',
              },
              quality: {
                type: 'number',
                description: 'JPEG quality 0-100 (default: 60 for efficiency)',
              },
              clip: {
                type: 'object',
                description: 'Capture only a region. Use get_bounding_rect to find element coordinates first.',
                properties: {
                  x: { type: 'number', description: 'Left edge X coordinate' },
                  y: { type: 'number', description: 'Top edge Y coordinate' },
                  width: { type: 'number', description: 'Width of region' },
                  height: { type: 'number', description: 'Height of region' },
                },
                required: ['x', 'y', 'width', 'height'],
              },
            },
            required: [],
          },
        },
        {
          name: 'console_logs',
          description: 'Read console logs from the page. Injects a log interceptor if not already present. Essential for debugging.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              clear: {
                type: 'boolean',
                description: 'Clear logs after reading (default: false)',
              },
              level: {
                type: 'string',
                enum: ['all', 'log', 'warn', 'error', 'info', 'debug'],
                description: 'Filter by log level (default: all)',
              },
              limit: {
                type: 'number',
                description: 'Max number of logs to return (default: 100)',
              },
            },
            required: [],
          },
        },
        {
          name: 'evaluate',
          description: 'Execute JavaScript code in the page context. Returns the result. Use for custom automation or debugging.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              code: {
                type: 'string',
                description: 'JavaScript code to execute',
              },
            },
            required: ['code'],
          },
        },
        {
          name: 'mouse_click',
          description: 'REAL MOUSE CLICK via Chrome DevTools Protocol. Use this for OAuth popups, protected buttons, or any element that blocks JS clicks. More powerful than click() but slightly slower. IMPORTANT: When using selector, coordinates are looked up AFTER debugger attaches, avoiding offset issues from the Chrome debugger bar.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              selector: {
                type: 'string',
                description: 'CSS selector of element to click. Coordinates are calculated AFTER debugger attach, avoiding debugger bar offset issues. Use this instead of x,y for more reliable clicks.',
              },
              x: {
                type: 'number',
                description: 'X coordinate to click. Required if no selector provided.',
              },
              y: {
                type: 'number',
                description: 'Y coordinate to click. Required if no selector provided.',
              },
              button: {
                type: 'string',
                enum: ['left', 'right', 'middle'],
                description: 'Mouse button (default: left)',
              },
              clickCount: {
                type: 'number',
                description: 'Number of clicks (default: 1, use 2 for double-click)',
              },
            },
            required: [],
          },
        },
        {
          name: 'mouse_move',
          description: 'Move mouse cursor to coordinates via Chrome DevTools Protocol. Use before mouse_click for hover effects or drag operations.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              x: {
                type: 'number',
                description: 'X coordinate to move to (required)',
              },
              y: {
                type: 'number',
                description: 'Y coordinate to move to (required)',
              },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'keyboard_type',
          description: 'Type text using real keyboard events via Chrome DevTools Protocol. Use for inputs that block programmatic value setting.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              text: {
                type: 'string',
                description: 'Text to type (required)',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'keyboard_press',
          description: 'Press a key or key combination. Use for Enter, Tab, Escape, arrows, or shortcuts like Ctrl+A, Ctrl+C, Ctrl+V.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              key: {
                type: 'string',
                description: 'Key to press: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or single char (a-z)',
              },
              modifiers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Modifier keys: ctrl, alt, shift, meta/cmd',
              },
            },
            required: ['key'],
          },
        },
        {
          name: 'scroll',
          description: 'Scroll the page using mouse wheel. Use deltaY negative to scroll down, positive to scroll up.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              x: {
                type: 'number',
                description: 'X coordinate for scroll position (default: 0)',
              },
              y: {
                type: 'number',
                description: 'Y coordinate for scroll position (default: 0)',
              },
              deltaX: {
                type: 'number',
                description: 'Horizontal scroll amount (positive=right)',
              },
              deltaY: {
                type: 'number',
                description: 'Vertical scroll amount (negative=down, positive=up)',
              },
            },
            required: [],
          },
        },
        {
          name: 'go_back',
          description: 'Navigate back in browser history.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
            },
            required: [],
          },
        },
        {
          name: 'go_forward',
          description: 'Navigate forward in browser history.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
            },
            required: [],
          },
        },
        {
          name: 'refresh',
          description: 'Refresh the current page.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
            },
            required: [],
          },
        },
        {
          name: 'download',
          description: 'Trigger a file download. Returns download ID for tracking. If download doesn\'t start, user may need to disable "Ask where to save" in Chrome settings.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL to download',
              },
              filename: {
                type: 'string',
                description: 'Suggested filename (optional)',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'download_status',
          description: 'Check download status. Without downloadId, lists recent downloads. Returns filename (full path), state (in_progress/complete/interrupted), and progress.',
          inputSchema: {
            type: 'object',
            properties: {
              downloadId: {
                type: 'number',
                description: 'Specific download ID to check. If omitted, lists recent downloads.',
              },
            },
            required: [],
          },
        },
        {
          name: 'get_bounding_rect',
          description: 'LOW-COST: Get element coordinates without screenshot. Returns x, y, width, height, centerX, centerY. Use this to find where to click.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              selector: {
                type: 'string',
                description: 'CSS selector of element',
              },
            },
            required: ['selector'],
          },
        },
        {
          name: 'wait_for_element',
          description: 'Wait for an element to appear in the DOM. Useful after navigation or dynamic content loading.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              selector: {
                type: 'string',
                description: 'CSS selector to wait for',
              },
              timeout: {
                type: 'number',
                description: 'Max wait time in ms (default: 10000)',
              },
            },
            required: ['selector'],
          },
        },
        {
          name: 'element_exists',
          description: 'LOW-COST: Quick check if selector matches any elements. Returns exists (bool) and count.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              selector: {
                type: 'string',
                description: 'CSS selector to check',
              },
            },
            required: ['selector'],
          },
        },
        {
          name: 'drag',
          description: 'Drag from one point to another. Useful for sliders, drag-and-drop, drawing.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              startX: {
                type: 'number',
                description: 'Starting X coordinate',
              },
              startY: {
                type: 'number',
                description: 'Starting Y coordinate',
              },
              endX: {
                type: 'number',
                description: 'Ending X coordinate',
              },
              endY: {
                type: 'number',
                description: 'Ending Y coordinate',
              },
              steps: {
                type: 'number',
                description: 'Number of intermediate steps (default: 10)',
              },
            },
            required: ['startX', 'startY', 'endX', 'endY'],
          },
        },
        {
          name: 'site_knowledge_get',
          description: 'Get stored knowledge about a website (gotchas, patterns, navigation hints). Check this BEFORE starting browser automation on a site to benefit from past learnings.',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Domain name (e.g., "chase.com", "github.com")',
              },
            },
            required: ['domain'],
          },
        },
        {
          name: 'site_knowledge_save',
          description: 'Save learned knowledge about a website. Call this AFTER completing a browser task to preserve gotchas, working patterns, and navigation hints for future sessions.',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Domain name (e.g., "chase.com")',
              },
              notes: {
                type: 'string',
                description: 'General notes about the site',
              },
              navigation: {
                type: 'object',
                description: 'Navigation hints as key-value pairs (e.g., {"statements": "Accounts dropdown → Statements & documents"})',
              },
              gotchas: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of gotchas and warnings learned',
              },
              patterns: {
                type: 'object',
                description: 'Selector patterns as key-value pairs (e.g., {"tables": "#accountsTable-{n}-row{n}"})',
              },
              auth_stop: {
                type: 'array',
                items: { type: 'string' },
                description: 'Domains where AI should stop and let human handle auth',
              },
            },
            required: ['domain'],
          },
        },
        {
          name: 'site_knowledge_list',
          description: 'List all domains with stored knowledge.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'guide_list',
          description: 'List available Helios guides. Use this to see what guides exist for browser automation patterns.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'guide_read',
          description: 'Read a specific Helios guide. Use this to get detailed instructions for a specific automation pattern (e.g., "downloading", "dynamic-elements", "authentication", "troubleshooting").',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Guide name (e.g., "downloading", "dynamic-elements", "troubleshooting")',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'guide_search',
          description: 'Search Helios guides for keywords. Use this when you encounter a problem to find relevant guidance. Returns matching guides with context snippets.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (e.g., "download pdf", "dynamic id", "click not working")',
              },
            },
            required: ['query'],
          },
        },
        // Security tools
        {
          name: 'security_status',
          description: 'Get current security status including rate limits, domain restrictions, and emergency stop state.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'security_config',
          description: 'View or update security configuration. Can set rate limits, domain allowlist/blocklist, and other security settings.',
          inputSchema: {
            type: 'object',
            properties: {
              update: {
                type: 'object',
                description: 'Partial config to merge (e.g., {"rateLimit": {"maxActionsPerMinute": 30}})',
              },
            },
            required: [],
          },
        },
        {
          name: 'emergency_stop',
          description: 'Enable or disable emergency stop. When enabled, ALL browser actions are blocked immediately.',
          inputSchema: {
            type: 'object',
            properties: {
              stop: {
                type: 'boolean',
                description: 'true to enable emergency stop, false to disable',
              },
            },
            required: ['stop'],
          },
        },
        {
          name: 'audit_logs',
          description: 'View recent audit logs showing all browser actions taken.',
          inputSchema: {
            type: 'object',
            properties: {
              days: {
                type: 'number',
                description: 'Number of days of logs to retrieve (default: 1)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of entries to return (default: 50)',
              },
            },
            required: [],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    // Security tools bypass security checks
    const securityTools = ['security_status', 'security_config', 'emergency_stop', 'audit_logs'];

    try {
      // Emergency stop check (except for security tools)
      if (!securityTools.includes(name) && isEmergencyStopped()) {
        await auditLog({ action: name, args, result: 'blocked', error: 'Emergency stop active' });
        return {
          content: [{
            type: 'text',
            text: '🛑 EMERGENCY STOP ACTIVE. All browser actions are blocked. Use emergency_stop(false) to resume.',
          }],
          isError: true,
        };
      }

      // Rate limit check (except for security and read-only tools)
      const readOnlyTools = ['ping', 'tabs_list', 'windows_list', 'read_page', 'screenshot', ...securityTools];
      if (!readOnlyTools.includes(name)) {
        const rateCheck = checkRateLimit();
        if (!rateCheck.allowed) {
          await auditLog({ action: name, args, result: 'blocked', error: 'Rate limit exceeded' });
          return {
            content: [{
              type: 'text',
              text: `⚠️ Rate limit exceeded (${securityConfig.rateLimit.maxActionsPerMinute}/min). Wait before retrying.`,
            }],
            isError: true,
          };
        }
      }

      switch (name) {
        case 'ping': {
          const result = await sendToExtension('ping');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'tabs_list': {
          const result = await sendToExtension('tabs_list');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'windows_list': {
          const result = await sendToExtension('windows_list');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'navigate': {
          const result = await sendToExtension('navigate', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'click': {
          const result = await sendToExtension('click', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'type': {
          const result = await sendToExtension('type', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'read_page': {
          const result = await sendToExtension('read_page', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'navigate_and_read': {
          // Navigate first
          await sendToExtension('navigate', { url: (args as any).url, tabId: (args as any).tabId });
          // Wait for page to load
          const waitMs = (args as any).waitMs || 1000;
          await new Promise(resolve => setTimeout(resolve, waitMs));
          // Then read page
          const result = await sendToExtension('read_page', { tabId: (args as any).tabId });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'screenshot': {
          const result = await sendToExtension('screenshot', args) as { dataUrl: string; partial?: boolean };
          // Return as image content with cost warning
          const base64Data = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
          const mimeType = result.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
          const tokenWarning = result.partial
            ? '📷 Partial screenshot captured (reduced tokens vs full page).'
            : '⚠️ Screenshot used ~1500 tokens. Next time, consider read_page (~400 tokens) or use clip parameter for partial screenshots.';
          return {
            content: [
              {
                type: 'text',
                text: tokenWarning,
              },
              {
                type: 'image',
                data: base64Data,
                mimeType,
              },
            ],
          };
        }

        case 'console_logs': {
          const result = await sendToExtension('console_logs', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'evaluate': {
          const result = await sendToExtension('evaluate', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'mouse_click': {
          const result = await sendToExtension('mouse_click', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'mouse_move': {
          const result = await sendToExtension('mouse_move', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'keyboard_type': {
          const result = await sendToExtension('keyboard_type', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'keyboard_press': {
          const result = await sendToExtension('keyboard_press', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'scroll': {
          const result = await sendToExtension('scroll', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'go_back': {
          const result = await sendToExtension('go_back', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'go_forward': {
          const result = await sendToExtension('go_forward', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'refresh': {
          const result = await sendToExtension('refresh', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'download': {
          const result = await sendToExtension('download', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'download_status': {
          const result = await sendToExtension('download_status', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'get_bounding_rect': {
          const result = await sendToExtension('get_bounding_rect', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'wait_for_element': {
          const result = await sendToExtension('wait_for_element', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'element_exists': {
          const result = await sendToExtension('element_exists', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'drag': {
          const result = await sendToExtension('drag', args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'site_knowledge_get': {
          const { domain } = args as { domain: string };
          const knowledge = await getSiteKnowledge(domain);
          if (!knowledge) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No stored knowledge for ${domain}. You're exploring fresh - save what you learn!`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(knowledge, null, 2),
              },
            ],
          };
        }

        case 'site_knowledge_save': {
          const { domain, notes, navigation, gotchas, patterns, auth_stop } = args as {
            domain: string;
            notes?: string;
            navigation?: Record<string, string>;
            gotchas?: string[];
            patterns?: Record<string, string>;
            auth_stop?: string[];
          };

          // Merge with existing knowledge if present
          const existing = await getSiteKnowledge(domain);
          const merged: SiteKnowledge = {
            domain,
            notes: notes || existing?.notes,
            navigation: { ...existing?.navigation, ...navigation },
            gotchas: [...new Set([...(existing?.gotchas || []), ...(gotchas || [])])],
            patterns: { ...existing?.patterns, ...patterns },
            auth_stop: [...new Set([...(existing?.auth_stop || []), ...(auth_stop || [])])],
            updated: new Date().toISOString().split('T')[0],
          };

          await saveSiteKnowledge(merged);
          return {
            content: [
              {
                type: 'text',
                text: `Saved knowledge for ${domain}. Stored at ~/.helios/sites/${domain}.json`,
              },
            ],
          };
        }

        case 'site_knowledge_list': {
          const domains = await listSiteKnowledge();
          return {
            content: [
              {
                type: 'text',
                text: domains.length > 0
                  ? `Known sites:\n${domains.map(d => `  - ${d}`).join('\n')}`
                  : 'No site knowledge stored yet.',
              },
            ],
          };
        }

        case 'guide_list': {
          const guides = await listGuides();
          if (guides.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No guides available. Guides are stored in ~/.helios/guides/',
                },
              ],
            };
          }
          const list = guides.map(g => `- **${g.name}**: ${g.title}`).join('\n');
          return {
            content: [
              {
                type: 'text',
                text: `Available guides:\n${list}\n\nUse guide_read(name) to read a specific guide.`,
              },
            ],
          };
        }

        case 'guide_read': {
          const { name: guideName } = args as { name: string };
          // Support reading the index
          const fileName = guideName === 'index' ? '_index' : guideName;
          const content = await readGuide(fileName);
          if (!content) {
            const guides = await listGuides();
            const available = guides.map(g => g.name).join(', ');
            return {
              content: [
                {
                  type: 'text',
                  text: `Guide "${guideName}" not found. Available guides: ${available}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: content,
              },
            ],
          };
        }

        case 'guide_search': {
          const { query } = args as { query: string };
          const results = await searchGuides(query);
          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No guides found matching "${query}". Try different keywords or use guide_list to see all guides.`,
                },
              ],
            };
          }
          const formatted = results.map(r =>
            `**${r.name}**:\n${r.matches.map(m => `  - ${m}`).join('\n')}`
          ).join('\n\n');
          return {
            content: [
              {
                type: 'text',
                text: `Found ${results.length} guide(s) matching "${query}":\n\n${formatted}\n\nUse guide_read(name) to read the full guide.`,
              },
            ],
          };
        }

        // Security tools
        case 'security_status': {
          const rateCheck = checkRateLimit();
          const status = {
            emergencyStop: isEmergencyStopped(),
            rateLimit: {
              enabled: securityConfig.rateLimit.enabled,
              maxPerMinute: securityConfig.rateLimit.maxActionsPerMinute,
              remaining: rateCheck.remaining,
            },
            domains: {
              allowlist: securityConfig.domains.allowlist.length > 0
                ? securityConfig.domains.allowlist
                : '(all allowed)',
              blocklist: securityConfig.domains.blocklist,
            },
            auditLog: securityConfig.auditLog.enabled ? 'enabled' : 'disabled',
          };
          return {
            content: [{
              type: 'text',
              text: `🔒 Security Status:\n${JSON.stringify(status, null, 2)}`,
            }],
          };
        }

        case 'security_config': {
          const { update } = args as { update?: Partial<SecurityConfig> };
          if (update) {
            // Deep merge the update
            securityConfig = {
              ...securityConfig,
              ...update,
              rateLimit: { ...securityConfig.rateLimit, ...update.rateLimit },
              domains: { ...securityConfig.domains, ...update.domains },
              sensitiveActions: { ...securityConfig.sensitiveActions, ...update.sensitiveActions },
              auditLog: { ...securityConfig.auditLog, ...update.auditLog },
            };
            await saveSecurityConfig();
            await auditLog({ action: 'security_config', args: update, result: 'success' });
            return {
              content: [{
                type: 'text',
                text: `✅ Security config updated:\n${JSON.stringify(securityConfig, null, 2)}`,
              }],
            };
          }
          return {
            content: [{
              type: 'text',
              text: `🔒 Current security config:\n${JSON.stringify(securityConfig, null, 2)}`,
            }],
          };
        }

        case 'emergency_stop': {
          const { stop } = args as { stop: boolean };
          await setEmergencyStop(stop);
          return {
            content: [{
              type: 'text',
              text: stop
                ? '🛑 EMERGENCY STOP ENABLED. All browser actions are now blocked.'
                : '✅ Emergency stop disabled. Browser actions are now allowed.',
            }],
          };
        }

        case 'audit_logs': {
          const { days = 1, limit = 50 } = args as { days?: number; limit?: number };
          const logs = await getAuditLogs(days);
          const limited = logs.slice(0, limit);
          return {
            content: [{
              type: 'text',
              text: limited.length > 0
                ? `📋 Audit logs (${limited.length} of ${logs.length} entries):\n${JSON.stringify(limited, null, 2)}`
                : 'No audit logs found for this period.',
            }],
          };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      await auditLog({
        action: name,
        args,
        result: 'error',
        error: error instanceof Error ? error.message : String(error),
        duration_ms: duration,
      });
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Load security config on startup
loadSecurityConfig().catch(console.error);

// Main entry point
async function main() {
  // Start WebSocket server for extension
  const wss = createWebSocketServer();

  // Create and start MCP server
  const server = createMCPServer();
  const transport = new StdioServerTransport();

  console.error('[Helios] Starting MCP server...');

  await server.connect(transport);

  // Handle shutdown
  process.on('SIGINT', () => {
    console.error('[Helios] Shutting down...');
    wss.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[Helios] Fatal error:', error);
  process.exit(1);
});
