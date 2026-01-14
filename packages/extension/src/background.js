/**
 * Helios - Background Service Worker
 *
 * Connects to MCP server via Native Messaging host for reliable connections.
 * Chrome manages the native host lifecycle, solving MV3 service worker issues.
 */

const HOST_NAME = 'com.helios.native';

let port = null;
let connectionStatus = 'disconnected';
let reconnectTimer = null;
let reconnectAttempts = 0;

const CONFIG = {
  reconnectBaseDelay: 1000,
  reconnectMaxDelay: 30000,
  maxReconnectAttempts: 20,
};

// Update connection status and notify popup
function setConnectionStatus(status) {
  connectionStatus = status;
  console.log(`[Helios] Connection status: ${status}`);

  // Notify popup if open
  chrome.runtime.sendMessage({ type: 'status', status }).catch(() => {
    // Popup not open, ignore
  });
}

// Connect to native messaging host
function connect() {
  if (port) {
    console.log('[Helios] Already connected to native host');
    return;
  }

  setConnectionStatus('connecting');
  console.log(`[Helios] Connecting to native host: ${HOST_NAME}`);

  try {
    port = chrome.runtime.connectNative(HOST_NAME);

    port.onMessage.addListener(async (message) => {
      console.log('[Helios] Received from native host:', message);

      // Handle connection status messages from native host
      if (message.type === 'connected') {
        console.log('[Helios] Native host connected to MCP server');
        setConnectionStatus('connected');
        reconnectAttempts = 0;
        return;
      }

      if (message.type === 'disconnected') {
        console.log('[Helios] Native host lost connection to MCP server');
        setConnectionStatus('reconnecting');
        return;
      }

      if (message.type === 'error') {
        console.error('[Helios] Native host error:', message.error);
        return;
      }

      // Handle MCP messages from server
      if (message.id) {
        try {
          const response = await handleMessage(message);
          if (port) {
            port.postMessage(response);
          }
        } catch (error) {
          console.error('[Helios] Error handling message:', error);
          if (port) {
            port.postMessage({
              id: message.id,
              success: false,
              error: error.message,
            });
          }
        }
      }
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.log('[Helios] Native host disconnected:', error?.message || 'unknown');
      port = null;
      setConnectionStatus('disconnected');
      scheduleReconnect();
    });

    // Native host is connected - it will notify us when MCP server connects
    console.log('[Helios] Native messaging port opened');
  } catch (error) {
    console.error('[Helios] Failed to connect to native host:', error);
    port = null;
    setConnectionStatus('disconnected');
    scheduleReconnect();
  }
}

// Schedule reconnection with exponential backoff
function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  if (reconnectAttempts >= CONFIG.maxReconnectAttempts) {
    console.log('[Helios] Max reconnect attempts reached');
    setConnectionStatus('failed');
    return;
  }

  const delay = Math.min(
    CONFIG.reconnectBaseDelay * Math.pow(2, reconnectAttempts),
    CONFIG.reconnectMaxDelay
  );

  console.log(`[Helios] Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);

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
              windowId: tab.windowId,
            })),
          },
        };
      }

      case 'windows_list': {
        const windows = await chrome.windows.getAll({ populate: true });
        return {
          id,
          success: true,
          data: {
            windows: windows.map((win) => ({
              id: win.id,
              type: win.type,
              focused: win.focused,
              tabs: win.tabs?.map((tab) => ({
                id: tab.id,
                url: tab.url,
                title: tab.title,
              })),
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
        const { tabId, format = 'jpeg', quality = 60 } = payload || {};
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

      case 'console_logs': {
        const { tabId, clear = false, level = 'all', limit = 100 } = payload || {};
        const tab = await getTargetTab(tabId);

        const result = await executeInTab(tab.id, (shouldClear, filterLevel, maxLogs) => {
          // Inject console interceptor if not present
          if (!window.__heliosConsoleLogs) {
            window.__heliosConsoleLogs = [];
            const originalConsole = {};
            ['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
              originalConsole[method] = console[method];
              console[method] = function(...args) {
                window.__heliosConsoleLogs.push({
                  level: method,
                  timestamp: Date.now(),
                  args: args.map(arg => {
                    try {
                      if (arg instanceof Error) {
                        return { type: 'error', message: arg.message, stack: arg.stack };
                      }
                      return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
                    } catch (e) {
                      return String(arg);
                    }
                  }),
                });
                // Keep only last 500 logs
                if (window.__heliosConsoleLogs.length > 500) {
                  window.__heliosConsoleLogs.shift();
                }
                originalConsole[method].apply(console, args);
              };
            });
            window.__heliosOriginalConsole = originalConsole;
          }

          let logs = window.__heliosConsoleLogs;

          // Filter by level
          if (filterLevel !== 'all') {
            logs = logs.filter(l => l.level === filterLevel);
          }

          // Limit
          logs = logs.slice(-maxLogs);

          // Clear if requested
          if (shouldClear) {
            window.__heliosConsoleLogs = [];
          }

          return {
            logs,
            total: window.__heliosConsoleLogs.length,
            interceptorActive: true,
          };
        }, [clear, level, limit]);

        return { id, success: true, data: result };
      }

      case 'evaluate': {
        const { tabId, code } = payload || {};
        if (!code) {
          throw new Error('code is required');
        }
        const tab = await getTargetTab(tabId);

        const result = await executeInTab(tab.id, (jsCode) => {
          try {
            // Use indirect eval for global scope
            const result = (0, eval)(jsCode);
            // Try to serialize the result
            if (result === undefined) return { value: undefined, type: 'undefined' };
            if (result === null) return { value: null, type: 'null' };
            if (typeof result === 'function') return { value: '[Function]', type: 'function' };
            if (typeof result === 'symbol') return { value: result.toString(), type: 'symbol' };
            try {
              return { value: JSON.parse(JSON.stringify(result)), type: typeof result };
            } catch {
              return { value: String(result), type: typeof result };
            }
          } catch (e) {
            return { error: e.message, stack: e.stack };
          }
        }, [code]);

        if (result?.error) {
          throw new Error(result.error);
        }
        return { id, success: true, data: result };
      }

      case 'mouse_click': {
        const { tabId, x, y, button = 'left', clickCount = 1 } = payload || {};
        if (x === undefined || y === undefined) {
          throw new Error('x and y coordinates are required');
        }
        const tab = await getTargetTab(tabId);

        // Attach debugger to tab
        await chrome.debugger.attach({ tabId: tab.id }, '1.3');

        try {
          const buttonMap = { left: 'left', right: 'right', middle: 'middle' };
          const cdpButton = buttonMap[button] || 'left';

          // Mouse pressed
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x,
            y,
            button: cdpButton,
            clickCount,
          });

          // Mouse released
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x,
            y,
            button: cdpButton,
            clickCount,
          });

          return {
            id,
            success: true,
            data: { clicked: true, x, y, button: cdpButton, method: 'debugger' },
          };
        } finally {
          // Always detach debugger
          await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
        }
      }

      case 'mouse_move': {
        const { tabId, x, y } = payload || {};
        if (x === undefined || y === undefined) {
          throw new Error('x and y coordinates are required');
        }
        const tab = await getTargetTab(tabId);

        await chrome.debugger.attach({ tabId: tab.id }, '1.3');

        try {
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x,
            y,
          });

          return {
            id,
            success: true,
            data: { moved: true, x, y },
          };
        } finally {
          await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
        }
      }

      case 'keyboard_type': {
        const { tabId, text } = payload || {};
        if (!text) {
          throw new Error('text is required');
        }
        const tab = await getTargetTab(tabId);

        await chrome.debugger.attach({ tabId: tab.id }, '1.3');

        try {
          // Type each character
          for (const char of text) {
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              text: char,
            });
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              text: char,
            });
          }

          return {
            id,
            success: true,
            data: { typed: true, length: text.length, method: 'debugger' },
          };
        } finally {
          await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
        }
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
    if (port) {
      port.disconnect();
      port = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setConnectionStatus('disconnected');
    sendResponse({ ok: true });
  }
  return true;
});

// Start connection on service worker load
connect();

console.log('[Helios] Background service worker started (Native Messaging)');
