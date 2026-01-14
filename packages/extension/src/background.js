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

// Get active tab or specified tab
async function getTargetTab(tabId) {
  if (tabId) {
    return await chrome.tabs.get(tabId);
  }
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    throw new Error('No active tab found');
  }
  return activeTab;
}

// Execute script in tab and return result
async function executeInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (results && results[0]) {
    if (results[0].error) {
      throw new Error(results[0].error.message);
    }
    return results[0].result;
  }
  return null;
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

      case 'tabs_list': {
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
      }

      case 'navigate': {
        const { url, tabId } = payload || {};
        if (!url) {
          throw new Error('URL is required');
        }
        const tab = await getTargetTab(tabId);
        await chrome.tabs.update(tab.id, { url });
        // Wait a bit for navigation to start
        await new Promise(resolve => setTimeout(resolve, 500));
        const updatedTab = await chrome.tabs.get(tab.id);
        return {
          id,
          success: true,
          data: {
            tabId: updatedTab.id,
            url: updatedTab.url,
            title: updatedTab.title,
          },
        };
      }

      case 'click': {
        const { tabId, selector, x, y } = payload || {};
        const tab = await getTargetTab(tabId);

        if (selector) {
          const result = await executeInTab(tab.id, (sel) => {
            const el = document.querySelector(sel);
            if (!el) {
              return { error: `Element not found: ${sel}` };
            }
            el.click();
            return {
              clicked: true,
              selector: sel,
              tagName: el.tagName.toLowerCase(),
              text: el.textContent?.slice(0, 100),
            };
          }, [selector]);

          if (result?.error) {
            throw new Error(result.error);
          }
          return { id, success: true, data: result };
        } else if (x !== undefined && y !== undefined) {
          const result = await executeInTab(tab.id, (clickX, clickY) => {
            const el = document.elementFromPoint(clickX, clickY);
            if (el) {
              el.click();
              return {
                clicked: true,
                x: clickX,
                y: clickY,
                tagName: el.tagName.toLowerCase(),
              };
            }
            return { error: `No element at coordinates (${clickX}, ${clickY})` };
          }, [x, y]);

          if (result?.error) {
            throw new Error(result.error);
          }
          return { id, success: true, data: result };
        } else {
          throw new Error('Either selector or x,y coordinates required');
        }
      }

      case 'type': {
        const { tabId, selector, text, clear = true } = payload || {};
        if (!selector || text === undefined) {
          throw new Error('selector and text are required');
        }
        const tab = await getTargetTab(tabId);

        const result = await executeInTab(tab.id, (sel, txt, shouldClear) => {
          const el = document.querySelector(sel);
          if (!el) {
            return { error: `Element not found: ${sel}` };
          }
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
            return { error: 'Element is not an input or textarea' };
          }
          if (shouldClear) {
            el.value = '';
          }
          el.focus();
          el.value = txt;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return {
            typed: true,
            selector: sel,
            length: txt.length,
          };
        }, [selector, text, clear]);

        if (result?.error) {
          throw new Error(result.error);
        }
        return { id, success: true, data: result };
      }

      case 'read_page': {
        const { tabId, selector = 'body', maxElements = 100 } = payload || {};
        const tab = await getTargetTab(tabId);

        const result = await executeInTab(tab.id, (rootSelector, maxEls) => {
          const root = document.querySelector(rootSelector);
          if (!root) {
            return { error: `Root element not found: ${rootSelector}` };
          }

          const elements = [];
          const interactiveSelectors = [
            'a[href]', 'button', 'input', 'textarea', 'select',
            '[role="button"]', '[role="link"]', '[role="textbox"]',
            '[onclick]', '[tabindex]'
          ];

          // Find interactive elements
          const interactiveEls = root.querySelectorAll(interactiveSelectors.join(','));
          let refCounter = 1;

          for (const el of interactiveEls) {
            if (elements.length >= maxEls) break;

            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 &&
                             rect.top < window.innerHeight && rect.bottom > 0;

            if (!isVisible) continue;

            const elementInfo = {
              ref: `e${refCounter++}`,
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || '').trim().slice(0, 80),
            };

            // Add relevant attributes
            if (el.id) elementInfo.id = el.id;
            if (el.className && typeof el.className === 'string') {
              elementInfo.class = el.className.split(' ').slice(0, 3).join(' ');
            }
            if (el instanceof HTMLAnchorElement) elementInfo.href = el.href;
            if (el instanceof HTMLInputElement) {
              elementInfo.type = el.type;
              elementInfo.name = el.name;
              elementInfo.value = el.value.slice(0, 50);
              elementInfo.placeholder = el.placeholder;
            }
            if (el instanceof HTMLButtonElement || el.getAttribute('role') === 'button') {
              elementInfo.disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
            }

            elements.push(elementInfo);
          }

          return {
            url: window.location.href,
            title: document.title,
            elements,
            totalInteractive: interactiveEls.length,
            truncated: interactiveEls.length > maxEls,
          };
        }, [selector, maxElements]);

        if (result?.error) {
          throw new Error(result.error);
        }
        return { id, success: true, data: result };
      }

      case 'screenshot': {
        const { tabId, format = 'png', quality = 80 } = payload || {};
        const tab = await getTargetTab(tabId);

        // Activate the tab first to ensure we capture the right content
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise(resolve => setTimeout(resolve, 100));

        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: format === 'jpeg' ? 'jpeg' : 'png',
          quality: format === 'jpeg' ? quality : undefined,
        });

        return {
          id,
          success: true,
          data: {
            dataUrl,
            format,
            tabId: tab.id,
          },
        };
      }

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
