/**
 * Meridian Browse - Background Service Worker
 *
 * Connects to MCP server via WebSocket and handles browser automation commands.
 */

const CONFIG = {
  wsHost: 'localhost',
  wsPort: 9333,
  reconnectBaseDelay: 1000,
  reconnectMaxDelay: 30000,
};

let ws = null;
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
let reconnectTimer = null;

// Generate unique message ID
function generateMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Update connection status and notify popup
function setConnectionStatus(status) {
  connectionStatus = status;
  console.log(`[Meridian] Connection status: ${status}`);

  // Notify popup if open
  chrome.runtime.sendMessage({ type: 'status', status }).catch(() => {
    // Popup not open, ignore
  });
}

// Connect to WebSocket server
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('[Meridian] Already connected');
    return;
  }

  setConnectionStatus('connecting');
  const url = `ws://${CONFIG.wsHost}:${CONFIG.wsPort}`;
  console.log(`[Meridian] Connecting to ${url}...`);

  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[Meridian] Connected to MCP server');
      setConnectionStatus('connected');
      reconnectAttempts = 0;
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[Meridian] Received:', message);
        const response = await handleMessage(message);
        ws.send(JSON.stringify(response));
      } catch (error) {
        console.error('[Meridian] Error handling message:', error);
      }
    };

    ws.onclose = () => {
      console.log('[Meridian] Connection closed');
      setConnectionStatus('disconnected');
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('[Meridian] WebSocket error:', error);
    };
  } catch (error) {
    console.error('[Meridian] Failed to create WebSocket:', error);
    setConnectionStatus('disconnected');
    scheduleReconnect();
  }
}

// Schedule reconnection with exponential backoff
function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  const delay = Math.min(
    CONFIG.reconnectBaseDelay * Math.pow(2, reconnectAttempts),
    CONFIG.reconnectMaxDelay
  );

  console.log(`[Meridian] Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);

  reconnectTimer = setTimeout(() => {
    reconnectAttempts++;
    connect();
  }, delay);
}

// Handle incoming messages from server
async function handleMessage(message) {
  const { id, type, payload } = message;

  try {
    switch (type) {
      case 'ping':
        return {
          id,
          success: true,
          data: {
            pong: true,
            extensionVersion: chrome.runtime.getManifest().version,
            timestamp: Date.now(),
          },
        };

      case 'tabs_list':
        const tabs = await chrome.tabs.query({});
        return {
          id,
          success: true,
          data: {
            tabs: tabs.map((tab) => ({
              id: tab.id,
              url: tab.url,
              title: tab.title,
              active: tab.active,
              groupId: tab.groupId,
            })),
          },
        };

      default:
        return {
          id,
          success: false,
          error: `Unknown message type: ${type}`,
        };
    }
  } catch (error) {
    return {
      id,
      success: false,
      error: error.message,
    };
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getStatus') {
    sendResponse({ status: connectionStatus });
  } else if (message.type === 'connect') {
    connect();
    sendResponse({ ok: true });
  } else if (message.type === 'disconnect') {
    if (ws) {
      ws.close();
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    sendResponse({ ok: true });
  }
  return true;
});

// Start connection on service worker load
connect();

console.log('[Meridian] Background service worker started');
