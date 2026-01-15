#!/usr/bin/env node
/**
 * Helios Native Messaging Host
 *
 * Bridge between Chrome extension (via native messaging) and MCP server (via WebSocket).
 * Chrome spawns this process when the extension needs it, ensuring reliable connections.
 */

import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface HeliosConfig {
  port: number;
  authToken: string;
}

// Read config from file
function getConfig(): HeliosConfig {
  try {
    const configPath = path.join(os.homedir(), '.helios', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      port: config.port || 9333,
      authToken: config.authToken || '',
    };
  } catch {
    return { port: 9333, authToken: '' };
  }
}

function getWsUrl(): string {
  const config = getConfig();
  const baseUrl = `ws://localhost:${config.port}`;
  if (config.authToken) {
    return `${baseUrl}?token=${config.authToken}`;
  }
  return baseUrl;
}

const CONFIG = {
  get wsUrl() { return getWsUrl(); },  // Dynamic to pick up token changes
  reconnectDelay: 1000,
  maxReconnectAttempts: 10,
};

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let messageQueue: Buffer[] = [];

// Native messaging protocol: 4-byte length prefix (little-endian) + JSON
function readNativeMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let lengthBuffer = Buffer.alloc(0);
    let messageBuffer = Buffer.alloc(0);
    let expectedLength = -1;

    const onData = (chunk: Buffer) => {
      if (expectedLength === -1) {
        // Reading length prefix
        lengthBuffer = Buffer.concat([lengthBuffer, chunk]);
        if (lengthBuffer.length >= 4) {
          expectedLength = lengthBuffer.readUInt32LE(0);
          // Any extra bytes are part of the message
          if (lengthBuffer.length > 4) {
            messageBuffer = lengthBuffer.slice(4);
          }
          lengthBuffer = Buffer.alloc(0);
        }
      } else {
        // Reading message body
        messageBuffer = Buffer.concat([messageBuffer, chunk]);
      }

      if (expectedLength !== -1 && messageBuffer.length >= expectedLength) {
        process.stdin.removeListener('data', onData);
        const jsonStr = messageBuffer.slice(0, expectedLength).toString('utf8');
        try {
          resolve(JSON.parse(jsonStr));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${jsonStr}`));
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

function writeNativeMessage(message: unknown): void {
  const json = JSON.stringify(message);
  const messageBuffer = Buffer.from(json, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(messageBuffer.length, 0);

  process.stdout.write(lengthBuffer);
  process.stdout.write(messageBuffer);
}

function log(message: string): void {
  // Log to stderr so it doesn't interfere with native messaging protocol
  process.stderr.write(`[Helios Native Host] ${message}\n`);
}

function connectToServer(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  log(`Connecting to MCP server at ${CONFIG.wsUrl}...`);

  try {
    ws = new WebSocket(CONFIG.wsUrl);

    ws.on('open', () => {
      log('Connected to MCP server');
      reconnectAttempts = 0;

      // Send any queued messages
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift();
        if (msg && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }

      // Notify extension that we're connected
      writeNativeMessage({ type: 'connected' });
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        writeNativeMessage(message);
      } catch (e) {
        log(`Error parsing message from server: ${e}`);
      }
    });

    ws.on('close', () => {
      log('Disconnected from MCP server');
      ws = null;
      writeNativeMessage({ type: 'disconnected' });
      scheduleReconnect();
    });

    ws.on('error', (error) => {
      log(`WebSocket error: ${error.message}`);
    });
  } catch (error) {
    log(`Failed to connect: ${error}`);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= CONFIG.maxReconnectAttempts) {
    log('Max reconnect attempts reached, giving up');
    writeNativeMessage({ type: 'error', error: 'Max reconnect attempts reached' });
    return;
  }

  reconnectAttempts++;
  const delay = CONFIG.reconnectDelay * Math.min(reconnectAttempts, 5);
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  setTimeout(connectToServer, delay);
}

async function handleExtensionMessages(): Promise<void> {
  while (true) {
    try {
      const message = await readNativeMessage();
      log(`Received from extension: ${JSON.stringify(message)}`);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      } else {
        // Queue message for when we reconnect
        messageQueue.push(Buffer.from(JSON.stringify(message)));
        log('Message queued (not connected)');
      }
    } catch (error) {
      log(`Error reading message: ${error}`);
      // If stdin closes, exit gracefully
      if ((error as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED') {
        break;
      }
    }
  }
}

async function main(): Promise<void> {
  log('Starting Helios Native Host...');

  // Connect to MCP server
  connectToServer();

  // Handle messages from extension
  await handleExtensionMessages();

  log('Native host shutting down');
  if (ws) {
    ws.close();
  }
  process.exit(0);
}

// Handle process signals
process.on('SIGINT', () => {
  log('Received SIGINT');
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM');
  if (ws) ws.close();
  process.exit(0);
});

main().catch((error) => {
  log(`Fatal error: ${error}`);
  process.exit(1);
});
