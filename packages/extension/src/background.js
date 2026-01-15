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
        const { tabId, selector, x, y, index = 0 } = payload || {};
        const tab = await getTargetTab(tabId);

        if (selector) {
          const result = await executeInTab(tab.id, (sel, idx) => {
            const elements = document.querySelectorAll(sel);
            if (elements.length === 0) {
              return { error: `Element not found: ${sel}` };
            }
            if (idx >= elements.length) {
              return { error: `Index ${idx} out of range (found ${elements.length} elements matching ${sel})` };
            }
            const el = elements[idx];
            el.click();
            return {
              clicked: true,
              selector: sel,
              index: idx,
              totalMatches: elements.length,
              tagName: el.tagName.toLowerCase(),
              text: el.textContent?.slice(0, 100),
            };
          }, [selector, index]);

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
        const { tabId, format = 'jpeg', quality = 60, clip } = payload || {};
        const tab = await getTargetTab(tabId);

        // Activate the tab first to ensure we capture the right content
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise(resolve => setTimeout(resolve, 100));

        // If clip is provided, use CDP for partial screenshot
        if (clip && clip.x !== undefined && clip.y !== undefined && clip.width && clip.height) {
          await chrome.debugger.attach({ tabId: tab.id }, '1.3');

          try {
            const cdpFormat = format === 'png' ? 'png' : 'jpeg';
            const result = await chrome.debugger.sendCommand(
              { tabId: tab.id },
              'Page.captureScreenshot',
              {
                format: cdpFormat,
                quality: cdpFormat === 'jpeg' ? quality : undefined,
                clip: {
                  x: clip.x,
                  y: clip.y,
                  width: clip.width,
                  height: clip.height,
                  scale: 1,
                },
              }
            );

            const mimeType = cdpFormat === 'png' ? 'image/png' : 'image/jpeg';
            return {
              id,
              success: true,
              data: {
                dataUrl: `data:${mimeType};base64,${result.data}`,
                format: cdpFormat,
                tabId: tab.id,
                partial: true,
                clip,
              },
            };
          } finally {
            await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
          }
        }

        // Full screenshot using standard API
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
            partial: false,
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
        const { tabId, x, y, selector, button = 'left', clickCount = 1 } = payload || {};
        if (x === undefined && y === undefined && !selector) {
          throw new Error('Either x,y coordinates or selector is required');
        }
        const tab = await getTargetTab(tabId);

        // Attach debugger to tab
        await chrome.debugger.attach({ tabId: tab.id }, '1.3');

        try {
          let clickX = x;
          let clickY = y;

          // If selector provided, get coordinates AFTER debugger is attached
          // This ensures coords account for any debugger bar offset
          if (selector) {
            const evalResult = await chrome.debugger.sendCommand(
              { tabId: tab.id },
              'Runtime.evaluate',
              {
                expression: `(function() {
                  const el = document.querySelector(${JSON.stringify(selector)});
                  if (!el) return { error: 'Element not found: ${selector}' };
                  const rect = el.getBoundingClientRect();
                  return {
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2,
                    width: rect.width,
                    height: rect.height,
                    tagName: el.tagName.toLowerCase(),
                    text: (el.textContent || '').trim().slice(0, 50)
                  };
                })()`,
                returnByValue: true,
              }
            );

            const coords = evalResult.result?.value;
            if (!coords || coords.error) {
              throw new Error(coords?.error || `Element not found: ${selector}`);
            }
            clickX = coords.x;
            clickY = coords.y;
          }

          const buttonMap = { left: 'left', right: 'right', middle: 'middle' };
          const cdpButton = buttonMap[button] || 'left';

          // Mouse pressed
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: clickX,
            y: clickY,
            button: cdpButton,
            clickCount,
          });

          // Mouse released
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: clickX,
            y: clickY,
            button: cdpButton,
            clickCount,
          });

          return {
            id,
            success: true,
            data: {
              clicked: true,
              x: clickX,
              y: clickY,
              selector: selector || undefined,
              button: cdpButton,
              method: 'debugger',
            },
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

      case 'keyboard_press': {
        const { tabId, key, modifiers = [] } = payload || {};
        if (!key) {
          throw new Error('key is required');
        }
        const tab = await getTargetTab(tabId);

        // Map common key names to CDP key codes
        const keyMap = {
          'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
          'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
          'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
          'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
          'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
          'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
          'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
          'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
          'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
          'Home': { key: 'Home', code: 'Home', keyCode: 36 },
          'End': { key: 'End', code: 'End', keyCode: 35 },
          'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
          'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
          'Space': { key: ' ', code: 'Space', keyCode: 32 },
        };

        // Handle single character keys (a-z, 0-9, etc.)
        const keyInfo = keyMap[key] || {
          key: key.length === 1 ? key : key,
          code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0
        };

        // Build modifier flags
        let modifierFlags = 0;
        if (modifiers.includes('alt')) modifierFlags |= 1;
        if (modifiers.includes('ctrl')) modifierFlags |= 2;
        if (modifiers.includes('meta') || modifiers.includes('cmd')) modifierFlags |= 4;
        if (modifiers.includes('shift')) modifierFlags |= 8;

        await chrome.debugger.attach({ tabId: tab.id }, '1.3');

        try {
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: keyInfo.key,
            code: keyInfo.code,
            windowsVirtualKeyCode: keyInfo.keyCode,
            modifiers: modifierFlags,
          });
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: keyInfo.key,
            code: keyInfo.code,
            windowsVirtualKeyCode: keyInfo.keyCode,
            modifiers: modifierFlags,
          });

          return {
            id,
            success: true,
            data: { pressed: true, key, modifiers, method: 'debugger' },
          };
        } finally {
          await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
        }
      }

      case 'scroll': {
        const { tabId, x = 0, y = 0, deltaX = 0, deltaY = 0 } = payload || {};
        const tab = await getTargetTab(tabId);

        await chrome.debugger.attach({ tabId: tab.id }, '1.3');

        try {
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x,
            y,
            deltaX,
            deltaY,
          });

          return {
            id,
            success: true,
            data: { scrolled: true, x, y, deltaX, deltaY, method: 'debugger' },
          };
        } finally {
          await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
        }
      }

      case 'go_back': {
        const { tabId } = payload || {};
        const tab = await getTargetTab(tabId);
        await chrome.tabs.goBack(tab.id);
        return {
          id,
          success: true,
          data: { navigated: 'back', tabId: tab.id },
        };
      }

      case 'go_forward': {
        const { tabId } = payload || {};
        const tab = await getTargetTab(tabId);
        await chrome.tabs.goForward(tab.id);
        return {
          id,
          success: true,
          data: { navigated: 'forward', tabId: tab.id },
        };
      }

      case 'refresh': {
        const { tabId } = payload || {};
        const tab = await getTargetTab(tabId);
        await chrome.tabs.reload(tab.id);
        return {
          id,
          success: true,
          data: { refreshed: true, tabId: tab.id },
        };
      }

      case 'download': {
        const { url, filename } = payload || {};
        if (!url) {
          throw new Error('url is required');
        }
        const downloadId = await chrome.downloads.download({
          url,
          filename, // Optional suggested filename
          saveAs: false, // Don't prompt - use default location
        });
        return {
          id,
          success: true,
          data: { downloadId, url, filename },
        };
      }

      case 'download_status': {
        const { downloadId } = payload || {};
        if (downloadId === undefined) {
          // List recent downloads
          const downloads = await chrome.downloads.search({ limit: 10, orderBy: ['-startTime'] });
          return {
            id,
            success: true,
            data: {
              downloads: downloads.map(d => ({
                id: d.id,
                filename: d.filename,
                url: d.url,
                state: d.state, // in_progress, interrupted, complete
                bytesReceived: d.bytesReceived,
                totalBytes: d.totalBytes,
                error: d.error,
              })),
            },
          };
        } else {
          // Get specific download
          const [download] = await chrome.downloads.search({ id: downloadId });
          if (!download) {
            throw new Error(`Download ${downloadId} not found`);
          }
          return {
            id,
            success: true,
            data: {
              id: download.id,
              filename: download.filename,
              url: download.url,
              state: download.state,
              bytesReceived: download.bytesReceived,
              totalBytes: download.totalBytes,
              error: download.error,
            },
          };
        }
      }

      case 'get_bounding_rect': {
        const { tabId, selector } = payload || {};
        if (!selector) {
          throw new Error('selector is required');
        }
        const tab = await getTargetTab(tabId);

        const result = await executeInTab(tab.id, (sel) => {
          const el = document.querySelector(sel);
          if (!el) {
            return { error: `Element not found: ${sel}` };
          }
          const rect = el.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            centerX: rect.x + rect.width / 2,
            centerY: rect.y + rect.height / 2,
            visible: rect.width > 0 && rect.height > 0,
          };
        }, [selector]);

        if (result?.error) {
          throw new Error(result.error);
        }
        return { id, success: true, data: result };
      }

      case 'wait_for_element': {
        const { tabId, selector, timeout = 10000 } = payload || {};
        if (!selector) {
          throw new Error('selector is required');
        }
        const tab = await getTargetTab(tabId);

        const startTime = Date.now();
        const pollInterval = 200;

        while (Date.now() - startTime < timeout) {
          const result = await executeInTab(tab.id, (sel) => {
            const el = document.querySelector(sel);
            if (el) {
              const rect = el.getBoundingClientRect();
              return {
                found: true,
                visible: rect.width > 0 && rect.height > 0,
                tagName: el.tagName.toLowerCase(),
              };
            }
            return { found: false };
          }, [selector]);

          if (result?.found) {
            return {
              id,
              success: true,
              data: {
                ...result,
                selector,
                waitedMs: Date.now() - startTime,
              },
            };
          }

          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        return {
          id,
          success: true,
          data: {
            found: false,
            selector,
            timedOut: true,
            waitedMs: timeout,
          },
        };
      }

      case 'element_exists': {
        const { tabId, selector } = payload || {};
        if (!selector) {
          throw new Error('selector is required');
        }
        const tab = await getTargetTab(tabId);

        const result = await executeInTab(tab.id, (sel) => {
          const els = document.querySelectorAll(sel);
          return {
            exists: els.length > 0,
            count: els.length,
          };
        }, [selector]);

        return { id, success: true, data: { ...result, selector } };
      }

      case 'drag': {
        const { tabId, startX, startY, endX, endY, steps = 10 } = payload || {};
        if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
          throw new Error('startX, startY, endX, endY are required');
        }
        const tab = await getTargetTab(tabId);

        await chrome.debugger.attach({ tabId: tab.id }, '1.3');

        try {
          // Mouse down at start
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: startX,
            y: startY,
            button: 'left',
            clickCount: 1,
          });

          // Move in steps
          for (let i = 1; i <= steps; i++) {
            const progress = i / steps;
            const x = startX + (endX - startX) * progress;
            const y = startY + (endY - startY) * progress;
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x,
              y,
              button: 'left',
            });
            await new Promise(resolve => setTimeout(resolve, 10));
          }

          // Mouse up at end
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: endX,
            y: endY,
            button: 'left',
            clickCount: 1,
          });

          return {
            id,
            success: true,
            data: { dragged: true, startX, startY, endX, endY, steps, method: 'debugger' },
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
