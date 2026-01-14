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

const CONFIG = {
  wsPort: 9333,
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
          description: 'Click an element on the page by CSS selector or coordinates.',
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
          description: 'EXPENSIVE (~1500 tokens): Capture visible area as image. Only use when you MUST verify visual layout, colors, or positioning. For finding/clicking elements, use read_page instead (70% cheaper). Ask yourself: "Do I need pixels or just structure?"',
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
          description: 'REAL MOUSE CLICK via Chrome DevTools Protocol. Use this for OAuth popups, protected buttons, or any element that blocks JS clicks. More powerful than click() but slightly slower.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              x: {
                type: 'number',
                description: 'X coordinate to click (required)',
              },
              y: {
                type: 'number',
                description: 'Y coordinate to click (required)',
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
            required: ['x', 'y'],
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
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
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
          const result = await sendToExtension('screenshot', args) as { dataUrl: string };
          // Return as image content with cost warning
          const base64Data = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
          const mimeType = result.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
          return {
            content: [
              {
                type: 'text',
                text: '⚠️ Screenshot used ~1500 tokens. Next time, consider read_page (~400 tokens) unless you need visual verification.',
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

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
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
