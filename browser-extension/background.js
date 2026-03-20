/**
 * ΠΑΝ Browser Bridge — background service worker
 *
 * Connects to the PAN server and exposes browser capabilities:
 * - List all open tabs (titles + URLs)
 * - Read page content from any tab
 * - Navigate to URLs
 * - Execute actions on pages (click, type, scroll)
 * - Search across all open tabs
 *
 * Polls PAN server for pending browser commands every 2 seconds.
 */

const PAN_SERVER = 'http://127.0.0.1:7777';
const POLL_INTERVAL = 2000;

// Keep service worker alive — MV3 suspends after 30s of inactivity
// This alarm fires every 25 seconds to prevent suspension
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Just existing in this handler keeps the worker alive
  }
});

// Poll for browser commands from PAN server
async function pollForCommands() {
  try {
    const res = await fetch(`${PAN_SERVER}/api/v1/browser/commands`);
    const commands = await res.json();

    for (const cmd of commands) {
      const result = await executeCommand(cmd);

      // Send result back
      await fetch(`${PAN_SERVER}/api/v1/browser/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cmd.id, result })
      });
    }
  } catch (e) {
    // Server not reachable — silent fail, retry next poll
  }
}

// Execute a browser command
async function executeCommand(cmd) {
  try {
    switch (cmd.action) {
      case 'list_tabs':
        return await listTabs();

      case 'read_tab':
        return await readTab(cmd.tabId || cmd.query);

      case 'read_active':
        return await readActiveTab();

      case 'navigate':
        return await navigateTab(cmd.url, cmd.tabId);

      case 'activate_tab':
        return await activateTab(cmd.tabId || cmd.query);

      case 'search_tabs':
        return await searchTabs(cmd.query);

      case 'execute_js':
        return await executeJs(cmd.tabId, cmd.code);

      case 'close_tab':
        return await closeTab(cmd.tabId);

      case 'new_tab':
        return await newTab(cmd.url);

      case 'read_all_tabs':
        return await readAllTabs();

      case 'type_text':
        return await typeInTab(cmd.tabId || cmd.query, cmd.selector, cmd.text);

      case 'click_element':
        return await clickInTab(cmd.tabId || cmd.query, cmd.selector, cmd.text);

      case 'fill_and_submit':
        return await fillAndSubmit(cmd.tabId || cmd.query, cmd.fields);

      case 'get_inputs':
        return await getInputs(cmd.tabId || cmd.query);

      case 'press_key':
        return await pressKey(cmd.tabId || cmd.query, cmd.key);

      case 'hover_element':
        return await hoverElement(cmd.tabId || cmd.query, cmd.selector, cmd.text);

      default:
        return { ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// List all open tabs with titles and URLs
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    ok: true,
    tabs: tabs.map(t => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
      index: t.index
    }))
  };
}

// Read the text content of a specific tab (by ID or title search)
async function readTab(tabIdOrQuery) {
  let tabId;

  if (typeof tabIdOrQuery === 'number') {
    tabId = tabIdOrQuery;
  } else {
    // Search by title
    const tabs = await chrome.tabs.query({});
    const match = tabs.find(t =>
      t.title.toLowerCase().includes(tabIdOrQuery.toLowerCase()) ||
      t.url.toLowerCase().includes(tabIdOrQuery.toLowerCase())
    );
    if (!match) return { ok: false, error: `No tab matching "${tabIdOrQuery}"` };
    tabId = match.id;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Get visible text content, cleaned up
      const text = document.body.innerText;
      const title = document.title;
      const url = window.location.href;
      // Also get any selected text
      const selection = window.getSelection()?.toString() || '';
      return { title, url, text: text.slice(0, 50000), selection }; // Cap at 50KB
    }
  });

  const data = results[0]?.result;
  if (!data) return { ok: false, error: 'Could not read tab content' };

  return { ok: true, ...data };
}

// Read the currently active tab
async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { ok: false, error: 'No active tab' };
  return readTab(tab.id);
}

// Navigate a tab to a URL
async function navigateTab(url, tabId) {
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (!tabId) return { ok: false, error: 'No tab to navigate' };

  await chrome.tabs.update(tabId, { url });
  return { ok: true, navigated: url, tabId };
}

// Activate (switch to) a tab by ID or title search
async function activateTab(tabIdOrQuery) {
  let tab;

  if (typeof tabIdOrQuery === 'number') {
    tab = await chrome.tabs.get(tabIdOrQuery);
  } else {
    const tabs = await chrome.tabs.query({});
    tab = tabs.find(t =>
      t.title.toLowerCase().includes(tabIdOrQuery.toLowerCase()) ||
      t.url.toLowerCase().includes(tabIdOrQuery.toLowerCase())
    );
  }

  if (!tab) return { ok: false, error: `No tab matching "${tabIdOrQuery}"` };

  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true, activated: tab.title, tabId: tab.id };
}

// Search all tabs for text content
async function searchTabs(query) {
  const tabs = await chrome.tabs.query({});
  const results = [];

  for (const tab of tabs) {
    if (tab.title.toLowerCase().includes(query.toLowerCase()) ||
        tab.url.toLowerCase().includes(query.toLowerCase())) {
      results.push({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        matchType: 'title/url'
      });
    }
  }

  return { ok: true, results, query };
}

// Execute JavaScript on a tab — uses a safe wrapper function
async function executeJs(tabId, code) {
  if (!tabId && typeof tabId !== 'number') {
    // Might be a query string
    tabId = await resolveTabId(tabId);
  }
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }

  // Can't use new Function() due to CSP. Instead, inject a script that evals.
  // Use executeScript with a func that receives the code string.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN', // Run in page context to avoid CSP issues
    func: (codeStr) => {
      try { return eval(codeStr); } catch(e) { return 'Error: ' + e.message; }
    },
    args: [code]
  });

  return { ok: true, result: results[0]?.result };
}

// Close a tab
async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return { ok: true, closed: tabId };
}

// Open a new tab
async function newTab(url) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank' });
  return { ok: true, tabId: tab.id, url: tab.url };
}

// Read text content from ALL open tabs (for searching across everything)
async function readAllTabs() {
  const tabs = await chrome.tabs.query({});
  const results = [];

  for (const tab of tabs.slice(0, 20)) { // Cap at 20 tabs
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body?.innerText?.slice(0, 5000) || ''
      });
      results.push({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        text: res[0]?.result || ''
      });
    } catch {
      results.push({ id: tab.id, title: tab.title, url: tab.url, text: '[could not read]' });
    }
  }

  return { ok: true, tabs: results };
}

// Type text into an input field
async function typeInTab(tabIdOrQuery, selector, text) {
  const tabId = await resolveTabId(tabIdOrQuery);
  if (!tabId) return { ok: false, error: `No tab matching "${tabIdOrQuery}"` };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN', // Run in page context for React compatibility
    func: (sel, txt) => {
      // Find the element — by CSS selector or by searching for focused/visible input
      let el = sel ? document.querySelector(sel) : document.activeElement;

      // If no selector, find the most likely input field
      if (!el || el === document.body) {
        // Try contentEditable divs (Slack, Discord, Gmail compose)
        el = document.querySelector('[contenteditable="true"]')
          || document.querySelector('textarea:not([hidden])')
          || document.querySelector('input[type="text"]:not([hidden])')
          || document.querySelector('input:not([type]):not([hidden])');
      }

      if (!el) return { found: false, error: 'No input field found' };

      // Focus the element
      el.focus();

      if (el.isContentEditable) {
        // For React-based contentEditable (Instagram, Slack, Discord, Gmail)
        el.focus();
        // Select all existing content and replace it
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        // Use execCommand which React/contentEditable listens to
        document.execCommand('insertText', false, txt);
      } else {
        // For regular inputs/textareas — need native setter to trigger React
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, txt);
        } else {
          el.value = txt;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return { found: true, tagName: el.tagName, typed: txt };
    },
    args: [selector || null, text]
  });

  const data = results[0]?.result;
  return data?.found ? { ok: true, ...data } : { ok: false, error: data?.error || 'Could not type' };
}

// Click an element by CSS selector or by visible text
async function clickInTab(tabIdOrQuery, selector, buttonText) {
  const tabId = await resolveTabId(tabIdOrQuery);
  if (!tabId) return { ok: false, error: `No tab matching "${tabIdOrQuery}"` };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, txt) => {
      let el;

      if (sel) {
        el = document.querySelector(sel);
      }

      if (!el && txt) {
        // Find by visible text — buttons, links, spans
        const search = txt.toLowerCase();
        const candidates = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"], span, div[role="option"]')];
        el = candidates.find(c => c.textContent.trim().toLowerCase().includes(search));
      }

      if (!el) return { found: false, error: `Element not found: ${sel || txt}` };

      el.click();
      return { found: true, tagName: el.tagName, text: el.textContent?.slice(0, 50) };
    },
    args: [selector || null, buttonText || null]
  });

  const data = results[0]?.result;
  return data?.found ? { ok: true, ...data } : { ok: false, error: data?.error || 'Could not click' };
}

// Fill multiple fields and optionally submit
async function fillAndSubmit(tabIdOrQuery, fields) {
  const tabId = await resolveTabId(tabIdOrQuery);
  if (!tabId) return { ok: false, error: `No tab matching "${tabIdOrQuery}"` };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (fieldList) => {
      const filled = [];
      for (const { selector, value } of fieldList) {
        const el = document.querySelector(selector);
        if (el) {
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push({ selector, success: true });
        } else {
          filled.push({ selector, success: false, error: 'not found' });
        }
      }
      return { filled };
    },
    args: [fields || []]
  });

  return { ok: true, ...results[0]?.result };
}

// Get all input fields on the page (so Claude can see what's fillable)
async function getInputs(tabIdOrQuery) {
  const tabId = await resolveTabId(tabIdOrQuery);
  if (!tabId) return { ok: false, error: `No tab matching "${tabIdOrQuery}"` };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const inputs = [];
      const els = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
      for (const el of els) {
        if (el.offsetParent === null && !el.isContentEditable) continue; // skip hidden
        inputs.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || (el.isContentEditable ? 'contenteditable' : ''),
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          value: el.value?.slice(0, 100) || el.textContent?.slice(0, 100) || '',
          selector: el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : '')
        });
      }
      return { inputs };
    }
  });

  return { ok: true, ...results[0]?.result };
}

// Hover over an element to trigger hover menus
async function hoverElement(tabIdOrQuery, selector, searchText) {
  const tabId = await resolveTabId(tabIdOrQuery);
  if (!tabId) return { ok: false, error: `No tab matching "${tabIdOrQuery}"` };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (sel, txt) => {
      let el;
      if (sel) {
        el = document.querySelector(sel);
      }
      if (!el && txt) {
        const search = txt.toLowerCase();
        // Find the element containing the text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.toLowerCase().includes(search)) {
            el = walker.currentNode.parentElement;
            break;
          }
        }
      }
      if (!el) return { found: false, error: 'Element not found' };

      // Get element position
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // Dispatch mouse events to simulate hover
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

      return { found: true, tagName: el.tagName, x: Math.round(x), y: Math.round(y), text: el.textContent?.slice(0, 50) };
    },
    args: [selector || null, searchText || null]
  });

  const data = results[0]?.result;
  return data?.found ? { ok: true, ...data } : { ok: false, error: data?.error || 'Could not hover' };
}

// Press a key (Enter, Tab, Escape, etc)
async function pressKey(tabIdOrQuery, key) {
  const tabId = await resolveTabId(tabIdOrQuery);
  if (!tabId) return { ok: false, error: `No tab matching "${tabIdOrQuery}"` };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (keyName) => {
      const el = document.activeElement || document.body;
      const opts = { key: keyName, code: keyName, bubbles: true, cancelable: true };
      if (keyName === 'Enter') { opts.keyCode = 13; opts.code = 'Enter'; }
      if (keyName === 'Tab') { opts.keyCode = 9; opts.code = 'Tab'; }
      if (keyName === 'Escape') { opts.keyCode = 27; opts.code = 'Escape'; }
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      // For forms, also try submitting
      if (keyName === 'Enter') {
        const form = el.closest('form');
        if (form) form.submit();
      }
      return { pressed: keyName, target: el.tagName };
    },
    args: [key]
  });

  return { ok: true, ...results[0]?.result };
}

// Helper: resolve tab ID from ID number or title search
async function resolveTabId(tabIdOrQuery) {
  if (typeof tabIdOrQuery === 'number') return tabIdOrQuery;
  if (!tabIdOrQuery) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  }
  const tabs = await chrome.tabs.query({});
  const match = tabs.find(t =>
    t.title.toLowerCase().includes(tabIdOrQuery.toLowerCase()) ||
    t.url.toLowerCase().includes(tabIdOrQuery.toLowerCase())
  );
  return match?.id;
}

// Start polling
setInterval(pollForCommands, POLL_INTERVAL);

// Also respond to messages from the popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getStatus') {
    fetch(`${PAN_SERVER}/health`)
      .then(r => r.json())
      .then(data => sendResponse({ connected: true, ...data }))
      .catch(() => sendResponse({ connected: false }));
    return true; // async response
  }

  if (msg.action === 'execute') {
    executeCommand(msg).then(sendResponse);
    return true;
  }
});

console.log('[ΠΑΝ] Browser Bridge loaded — polling', PAN_SERVER);
