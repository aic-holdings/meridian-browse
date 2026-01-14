#!/usr/bin/env node
/**
 * Meridian Browse - MCP Server
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
      'Browser extension not connected. Please ensure the Meridian Browse extension is installed and connected.'
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

  console.error(`[Meridian] WebSocket server listening on port ${CONFIG.wsPort}`);

  wss.on('connection', (socket) => {
    console.error('[Meridian] Extension connected');

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
        console.error('[Meridian] Error parsing message:', error);
      }
    });

    socket.on('close', () => {
      console.error('[Meridian] Extension disconnected');
      if (extensionSocket === socket) {
        extensionSocket = null;
      }
    });

    socket.on('error', (error) => {
      console.error('[Meridian] Socket error:', error);
    });
  });

  return wss;
}

// Create MCP server
function createMCPServer(): Server {
  const server = new Server(
    { name: 'meridian-browse', version: '0.1.0' },
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
          description: 'Get structured representation of the page DOM. Returns elements with refs for interaction. Much more token-efficient than screenshots.',
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
          name: 'screenshot',
          description: 'Capture a screenshot of the visible area. Use sparingly - prefer read_page for most interactions.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: {
                type: 'number',
                description: 'Tab ID. If not provided, uses active tab.',
              },
              format: {
                type: 'string',
                enum: ['png', 'jpeg'],
                description: 'Image format (default: png)',
              },
              quality: {
                type: 'number',
                description: 'JPEG quality 0-100 (default: 80)',
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

        case 'screenshot': {
          const result = await sendToExtension('screenshot', args) as { dataUrl: string };
          // Return as image content
          const base64Data = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
          const mimeType = result.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
          return {
            content: [
              {
                type: 'image',
                data: base64Data,
                mimeType,
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

  console.error('[Meridian] Starting MCP server...');

  await server.connect(transport);

  // Handle shutdown
  process.on('SIGINT', () => {
    console.error('[Meridian] Shutting down...');
    wss.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[Meridian] Fatal error:', error);
  process.exit(1);
});
