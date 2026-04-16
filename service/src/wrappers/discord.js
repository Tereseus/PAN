// PAN Discord Wrapper — content script injected into https://discord.com/app
//
// Runs inside the Tauri webview that opens Discord. Watches the DOM for new
// messages and posts them back to PAN via the Tauri shell's /wrap/inbound
// endpoint (which forwards to PAN :7777 /api/v1/wrap/inbound).
//
// Exposes window.__PAN_SEND__(text) to drive Discord's message input.
//
// This file is loaded as a STRING by service/src/routes/wrap.js and passed as
// `initScript` to the Tauri /open endpoint. The script runs on every page load
// inside Discord.

export const DISCORD_CONTENT_SCRIPT = `
(() => {
  const SERVICE = 'discord';
  const INBOUND = 'http://127.0.0.1:7790/wrap/inbound';
  const LOG = (...a) => console.log('[PAN-WRAP:discord]', ...a);
  LOG('content script loaded', location.href);

  // Fire ready immediately on script load — before any DOM wait. Proves injection.
  try {
    fetch(INBOUND, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ready', service: SERVICE, url: location.href, phase: 'early' }),
    }).catch(() => {});
  } catch (e) {}

  // ─── Read: observe message list and post new messages to PAN ───
  const seen = new Set();
  function extractMessage(node) {
    try {
      if (!node || node.nodeType !== 1) return null;
      const id = node.id || '';
      // Only process the message ROW (chat-messages-CHID-MSGID), not its children
      // like message-content-MSGID, message-accessories-MSGID, message-reactions-MSGID.
      // Those get picked up via the row's subtree.
      if (!id.startsWith('chat-messages-')) return null;
      // Format: chat-messages-CHANNELID-MESSAGEID  →  last dash-segment = msg id
      const msgId = id.split('-').pop();
      if (!msgId) return null;

      // Author: Discord uses <span class="username_..."> inside <h3> header.
      // Group-header rows have the username; subsequent grouped replies don't —
      // leave author null for those (we still capture text).
      const authorEl = node.querySelector('h3 [class*="username"]') || node.querySelector('[class*="username"]');
      const author = authorEl ? authorEl.textContent.trim() : null;

      // Content: prefer the exact container by id; fall back to scoped selectors.
      // Avoid bare [class*="markup"] — that matches reactions, embeds, etc.
      let contentEl = node.querySelector('#message-content-' + msgId);
      if (!contentEl) contentEl = node.querySelector('[id^="message-content-"]');
      if (!contentEl) {
        // Last resort: scoped markup inside the messageContent wrapper
        contentEl = node.querySelector('[class*="messageContent"] [class*="markup"]')
          || node.querySelector('div[class*="markup"]');
      }

      let text = null;
      if (contentEl) {
        // Use innerText where available (respects visibility, line breaks) else textContent
        const raw = (contentEl.innerText || contentEl.textContent || '').replace(/\\u200b/g, '').trim();
        text = raw.length ? raw : null;
      }

      const timeEl = node.querySelector('time');
      const timestamp = timeEl ? timeEl.getAttribute('datetime') : null;

      // Channel info from URL: /channels/GUILD_ID/CHANNEL_ID (or @me for DMs)
      const parts = location.pathname.split('/').filter(Boolean);
      const guildId = parts[1] || null;
      const channelId = parts[2] || null;

      return { service: SERVICE, msg_id: msgId, author, text, timestamp, guild_id: guildId, channel_id: channelId, url: location.href };
    } catch (e) { return null; }
  }

  function post(payload) {
    try {
      fetch(INBOUND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(e => LOG('post failed', e.message));
    } catch (e) { LOG('post threw', e.message); }
  }

  function scan(root) {
    // Only scan chat-messages rows — other message-* ids are children.
    const candidates = (root || document).querySelectorAll('[id^="chat-messages-"]');
    for (const c of candidates) {
      const id = c.id;
      const m = extractMessage(c);
      if (!m) continue;
      // Key the seen-set by (msg_id + hash-of-text) so that a row which
      // originally had null text (observer fired before React filled it in)
      // can be re-posted once text appears.
      const textKey = m.text ? m.text.slice(0, 32) : 'NOTEXT';
      const key = m.msg_id + '|' + textKey;
      if (seen.has(key)) continue;
      if (!m.text && !m.author) continue;
      seen.add(key);
      post({ type: 'message', ...m });
    }
  }

  // MutationObserver on the document — Discord re-renders a lot, so scan the whole subtree
  const obs = new MutationObserver(muts => {
    for (const mut of muts) {
      for (const added of mut.addedNodes) {
        if (added.nodeType === 1) scan(added);
      }
    }
  });
  // Defer until body exists
  function startObserving() {
    if (!document.body) return setTimeout(startObserving, 200);
    obs.observe(document.body, { childList: true, subtree: true });
    const initial = document.querySelectorAll('[id^="chat-messages-"], [id^="message-"]').length;
    scan(document.body);
    LOG('observing, initial nodes=' + initial);
    post({ type: 'ready', service: SERVICE, url: location.href, phase: 'observing', initial_count: initial });
  }
  startObserving();

  // Heartbeat: every 10s, post a count of message-row nodes currently in the DOM
  // AND re-run the full scan so we catch rows whose message-content element
  // rendered after the row itself (Discord is React + virtualised).
  let debugSent = false;
  setInterval(() => {
    try {
      const rows = document.querySelectorAll('[id^="chat-messages-"]');
      scan(document.body);
      // One-time: if we still have no real text after a scan, dump the structure
      // of the first row so we can adjust selectors.
      if (!debugSent && rows.length > 0 && seen.size > 0) {
        let anyWithText = false;
        for (const k of seen) { if (!k.endsWith('|NOTEXT')) { anyWithText = true; break; } }
        if (!anyWithText) {
          const sample = rows[0];
          const html = sample.outerHTML.slice(0, 2000);
          post({ type: 'debug', service: SERVICE, sample_id: sample.id, html });
          debugSent = true;
        }
      }
      post({ type: 'heartbeat', service: SERVICE, url: location.href, dom_msg_rows: rows.length, seen_size: seen.size });
    } catch (e) {}
  }, 10000);

  // ─── Write: send a message by typing into Discord's input ───
  window.__PAN_SEND__ = async function(text) {
    const input = document.querySelector('[role="textbox"][contenteditable="true"]');
    if (!input) { LOG('no input found'); return false; }
    input.focus();
    // Discord uses Slate.js — we simulate a paste event to preserve formatting
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    // Dispatch Enter
    await new Promise(r => setTimeout(r, 50));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return true;
  };

  LOG('ready. window.__PAN_SEND__(text) is available.');
})();
`;
