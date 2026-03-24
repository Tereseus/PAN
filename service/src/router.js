import { spawn } from 'child_process';
import { insert, all, get } from './db.js';
import { claude } from './claude.js';
import { isAvailable as weztermAvailable, openTerminal as weztermOpen, sendText as weztermSend, getText as weztermGet, listPanes as weztermList } from './wezterm.js';
import * as playwright from './playwright-bridge.js';
import { findSkill, getSkillPrompt, listSkills } from './skills.js';

// Log a step in the command processing pipeline
function logStep(commandId, step, detail) {
  if (!commandId) return;
  try {
    insert(`INSERT INTO command_logs (command_id, step, detail) VALUES (:cid, :step, :detail)`, {
      ':cid': commandId,
      ':step': step,
      ':detail': typeof detail === 'string' ? detail : JSON.stringify(detail)
    });
  } catch {}
  console.log(`[PAN Log] cmd=${commandId} ${step}: ${typeof detail === 'string' ? detail.slice(0, 100) : JSON.stringify(detail).slice(0, 100)}`);
}

// Server-side quick classification — catches obvious patterns without Claude
function serverClassify(text) {
  const lower = text.toLowerCase();
  if (lower.match(/(create|make)\s+(a\s+)?(folder|file|directory)/)) return 'system';
  if (lower.match(/(delete|remove)\s+(the\s+|a\s+)?(folder|file)/)) return 'system';
  if (lower.match(/(open|launch)\s+(the\s+)?\w+.*(project|dev|terminal)/)) return 'terminal';
  if (lower.match(/(add|put)\s+.*(list|grocery)/)) return 'memory';
  return null;
}

// Quick system handlers that need no Claude call at all
function tryQuickSystem(text) {
  const lower = text.toLowerCase();

  if (lower.includes('status')) {
    const stats = get(`SELECT
      (SELECT COUNT(*) FROM events) as events,
      (SELECT COUNT(*) FROM memory_items) as memories,
      (SELECT COUNT(*) FROM projects) as projects
    `);
    return {
      intent: 'system',
      response: `PAN status: ${stats.events} events, ${stats.memories} memories, ${stats.projects} projects.`
    };
  }

  if (lower.includes('stop') || lower.includes('pause') || lower.includes('sleep')) {
    return { intent: 'system', response: 'PAN paused. Say "PAN wake up" to resume.', action: 'pause' };
  }

  return null;
}

// Single unified Claude call — classifies AND handles in one shot
async function handleUnified(text, context) {
  const cmdId = context._commandId || null;

  // Build project list for context
  const projects = all("SELECT name, path FROM projects ORDER BY name");
  const projectList = projects.map(p => `- ${p.name}: ${p.path.replace(/\//g, '\\')}`).join('\n');

  // Pull relevant memories for query context
  const memories = all(`SELECT content, item_type FROM memory_items
    WHERE content LIKE :q ORDER BY created_at DESC LIMIT 5`, {
    ':q': `%${text.split(' ').slice(0, 3).join('%')}%`
  });
  const memoryContext = memories.length > 0
    ? `\nRelevant memories:\n${memories.map(m => `- [${m.item_type}] ${m.content}`).join('\n')}`
    : '';

  // Include conversation history if available
  const conversationHistory = context.conversation_history || '';
  const historyBlock = conversationHistory
    ? `\nRecent conversation:\n${conversationHistory}\n`
    : '';

  // Include sensor data if available
  const sensors = context.sensors || null;
  let sensorBlock = '';
  if (sensors) {
    const parts = [];
    const phone = sensors.phone || {};
    if (phone.gps) {
      const addr = phone.gps.address ? ` (${phone.gps.address})` : '';
      parts.push(`Location: ${phone.gps.lat?.toFixed(5)}, ${phone.gps.lng?.toFixed(5)}${addr}${phone.gps.altitude ? ` alt:${Math.round(phone.gps.altitude)}m` : ''}${phone.gps.speed ? ` speed:${phone.gps.speed.toFixed(1)}m/s` : ''}`);
    }
    if (phone.compass != null) parts.push(`Compass: ${Math.round(phone.compass)}°`);
    if (phone.barometer_hpa != null) parts.push(`Pressure: ${phone.barometer_hpa.toFixed(0)}hPa`);
    if (phone.light_lux != null) parts.push(`Light: ${Math.round(phone.light_lux)}lux`);
    if (phone.accelerometer) parts.push(`Accel: x=${phone.accelerometer.x?.toFixed(1)} y=${phone.accelerometer.y?.toFixed(1)} z=${phone.accelerometer.z?.toFixed(1)}`);
    const pendant = sensors.pendant || {};
    if (pendant.temperature_c != null) parts.push(`Temp: ${pendant.temperature_c}°C`);
    if (pendant.humidity_pct != null) parts.push(`Humidity: ${pendant.humidity_pct}%`);
    if (pendant.gas) parts.push(`Gas: ${JSON.stringify(pendant.gas)}`);
    if (parts.length > 0) sensorBlock = `\nUser's current sensor readings: ${parts.join(' | ')}\n`;
  }

  // NanoClaw: check for matching skill before calling Claude
  const matchedSkill = findSkill(text);
  const skillBlock = matchedSkill
    ? (logStep(cmdId, 'skill_matched', matchedSkill.name), getSkillPrompt(matchedSkill))
    : '';

  logStep(cmdId, 'unified_call', 'single Claude call for classify+handle');

  try {
    const raw = await claude(
      `You are PAN, a personal AI assistant. You listen to the user's speech through their phone microphone. You are conversational — respond naturally like talking to a friend, not like a robot. Keep responses short (1-2 sentences max, this is read aloud via TTS). Never censor the user's words.
${historyBlock}${skillBlock}
The user's microphone just picked up: "${text}"${sensorBlock}

FIRST: Decide if this speech is directed at you (PAN) or ambient.
Rules for deciding:
- If they say your name (Pan/Pam/Ben) → FOR YOU, respond
- If conversation history shows you were JUST talking (last 1-2 exchanges) → continuation, respond
- If the text contains a direct question ("do you know", "can you", "what is", ends with "?") → probably for you, respond
- If someone is narrating to ANOTHER person ("this boy was like", "she said", "he told me") with no question to you → AMBIENT
- If it's clearly a conversation between other people → AMBIENT
- When in doubt and there's recent conversation history → respond
- When in doubt and there's NO conversation history → AMBIENT

If ambient: {"intent": "ambient", "response": "[AMBIENT]"}

If it IS for you, respond with JSON matching one of these:

- Terminal/project: {"intent": "terminal", "action": "open", "project": "C:\\\\path", "name": "name", "response": "spoken response"}
- List terminal panes: {"intent": "terminal", "action": "list-panes", "response": "spoken response"}
- Send text to pane: {"intent": "terminal", "action": "send-text", "pane_id": 0, "text": "command\\n", "response": "spoken response"}
- Read pane output: {"intent": "terminal", "action": "get-text", "pane_id": 0, "response": "spoken response"}
- System command: {"intent": "system", "command": "PowerShell command", "response": "spoken response"}
  Desktop path is the user's OneDrive\\Desktop (NOT the plain Desktop).
- Browser action: {"intent": "browser", "action": "list_tabs|read_tab|activate_tab|type_text|click_element|navigate", "query": "tab name or URL", "text": "text to type or click", "response": "spoken response"}
  Use this for reading web pages, checking messages, typing in browser, switching tabs.
- Memory: {"intent": "memory", "action": "save|recall", "item_type": "type", "content": "content", "response": "spoken response"}
- Calendar: {"intent": "calendar", "response": "spoken response"}
- Music/media: {"intent": "music", "query": "song or artist name", "service": "spotify|youtube|any", "response": "spoken response"}
  Use this when the user wants to play music, a song, a video, or any media. Extract the song/artist name into "query". If they specify a service (Spotify, YouTube), include it. Otherwise use "any".
- Conversation/question: {"intent": "query", "response": "your spoken answer"}

Known projects: ${projectList}
${memoryContext}

Only return JSON.`
    );

    logStep(cmdId, 'unified_response', raw.slice(0, 200));

    const action = JSON.parse(raw);
    return processUnifiedResult(action, text, context);
  } catch (e) {
    console.error('[PAN Router] Unified call error:', e.message);
    return { intent: 'query', response: 'PAN is having trouble thinking right now.' };
  }
}

// Post-process the unified response into the correct return format
async function processUnifiedResult(action, text, context) {
  const intent = action.intent || 'query';

  switch (intent) {
    case 'terminal': {
      if (action.action === 'open') {
        const path = action.project || process.env.USERPROFILE + '\\Desktop';
        const name = action.name || 'PAN Terminal';

        // Try WezTerm CLI first — opens directly without needing the tray agent
        try {
          if (await weztermAvailable()) {
            const result = await weztermOpen(path, name);
            return {
              intent: 'terminal',
              response: action.response || `Opening terminal for ${name}`,
              terminalResult: { ...result, name },
              // No terminalAction — WezTerm handled it directly
            };
          }
        } catch (e) {
          console.error('[PAN Router] WezTerm open failed, falling back to tray:', e.message);
        }

        // Fallback: queue for the tray agent (old behavior)
        return {
          intent: 'terminal',
          response: action.response || `Opening terminal for ${name}`,
          terminalAction: { action: 'open', path, name }
        };
      }

      // WezTerm-specific actions: send-text, get-text, list-panes
      if (action.action === 'send-text' && action.pane_id != null) {
        try {
          if (await weztermAvailable()) {
            await weztermSend(action.pane_id, action.text || '');
            return { intent: 'terminal', response: action.response || `Sent text to pane ${action.pane_id}.` };
          }
        } catch (e) {
          return { intent: 'terminal', response: `Failed to send text: ${e.message}` };
        }
      }

      if (action.action === 'get-text' && action.pane_id != null) {
        try {
          if (await weztermAvailable()) {
            const text = await weztermGet(action.pane_id);
            return { intent: 'terminal', response: text.slice(-1000), paneText: text };
          }
        } catch (e) {
          return { intent: 'terminal', response: `Failed to read pane: ${e.message}` };
        }
      }

      if (action.action === 'list-panes') {
        try {
          if (await weztermAvailable()) {
            const panes = await weztermList();
            const summary = panes.map(p => `Pane ${p.pane_id}: ${p.title || p.cwd || 'untitled'}`).join(', ');
            return { intent: 'terminal', response: action.response || summary || 'No panes open.', panes };
          }
        } catch (e) {
          return { intent: 'terminal', response: `Failed to list panes: ${e.message}` };
        }
      }

      return { intent: 'terminal', response: action.response || 'Terminal action processed.' };
    }

    case 'music': {
      // Music — return route + query so the phone executes via resistance router
      return {
        intent: 'music',
        route: 'music',
        query: action.query || text,
        service: action.service || 'any',
        response: action.response || `Playing ${action.query || 'music'}.`,
      };
    }

    case 'browser': {
      // Try Playwright MCP first, fall back to browser extension
      const act = action.action || 'list_tabs';

      // ── Playwright MCP (primary) ──
      try {
        if (await playwright.isAvailable()) {
          let result;
          switch (act) {
            case 'navigate':
            case 'open_url':
              result = await playwright.navigateTo(action.url);
              return { intent: 'browser', response: action.response || `Navigated to ${action.url}` };
            case 'click':
              result = await playwright.clickElement(action.selector || action.query);
              return { intent: 'browser', response: action.response || 'Clicked.' };
            case 'type':
              result = await playwright.typeText(action.selector || action.query, action.text);
              return { intent: 'browser', response: action.response || 'Typed text.' };
            case 'read_tab':
            case 'read_page':
            case 'snapshot':
              result = await playwright.readPage();
              return { intent: 'browser', response: action.response || (result.text || '').slice(0, 500) };
            case 'screenshot':
              result = await playwright.screenshot();
              return { intent: 'browser', response: action.response || 'Screenshot taken.' };
            case 'list_tabs':
              result = await playwright.listTabs();
              if (result.ok && result.tabs) {
                const tabList = result.tabs.map(t => t.title).slice(0, 10).join(', ');
                return { intent: 'browser', response: action.response || `Tabs: ${tabList}` };
              }
              break; // fall through to extension
            case 'new_tab':
              result = await playwright.newTab(action.url);
              return { intent: 'browser', response: action.response || `Opened new tab: ${action.url}` };
            case 'close_tab':
              result = await playwright.closeTab();
              return { intent: 'browser', response: action.response || 'Tab closed.' };
            default:
              // Try raw passthrough for any Playwright MCP tool
              result = await playwright.raw(`browser_${act}`, {
                url: action.url, text: action.text, element: action.query, ref: action.query
              });
              return { intent: 'browser', response: action.response || result.text || 'Done.' };
          }
        }
      } catch (e) {
        console.log('[PAN Router] Playwright failed, falling back to extension:', e.message);
      }

      // ── Browser extension fallback ──
      try {
        const browserCmd = globalThis._panBrowserCommand;
        if (browserCmd) {
          const result = await browserCmd(act, {
            query: action.query || '',
            text: action.text || '',
            url: action.url || '',
          });

          if (result.ok) {
            if (act === 'read_tab' && result.text) {
              return { intent: 'browser', response: action.response || result.text.slice(0, 500) };
            }
            if (act === 'list_tabs' && result.tabs) {
              const tabList = result.tabs.map(t => t.title).slice(0, 10).join(', ');
              return { intent: 'browser', response: action.response || `You have ${result.tabs.length} tabs open: ${tabList}` };
            }
            return { intent: 'browser', response: action.response || 'Done.' };
          }
          return { intent: 'browser', response: action.response || result.error || 'Browser action failed.' };
        }
        return { intent: 'browser', response: 'No browser automation available — install Playwright or the browser extension.' };
      } catch (e) {
        return { intent: 'browser', response: `Browser error: ${e.message}` };
      }
    }

    case 'system': {
      if (action.command) {
        return {
          intent: 'system',
          response: action.response || 'Executing command.',
          desktopAction: { type: 'command', command: action.command }
        };
      }
      return { intent: 'system', response: action.response || 'Command processed.' };
    }

    case 'memory': {
      if (action.action === 'save') {
        insert(`INSERT INTO memory_items (item_type, content, context, confidence, classified_at)
          VALUES (:type, :content, :ctx, 1.0, datetime('now','localtime'))`, {
          ':type': action.item_type || 'note',
          ':content': action.content || text,
          ':ctx': JSON.stringify({ source: 'voice_command', original: text })
        });
        return { intent: 'memory', response: action.response || `Saved: ${action.content}` };
      }

      if (action.action === 'recall' || action.action === 'list') {
        const items = all(`SELECT * FROM memory_items WHERE item_type = :type OR content LIKE :q ORDER BY created_at DESC LIMIT 10`, {
          ':type': action.item_type || '',
          ':q': `%${action.content || ''}%`
        });

        if (items.length === 0) return { intent: 'memory', response: 'No matching items found.' };

        const list = items.map(i => `- [${i.item_type}] ${i.content}`).join('\n');
        return { intent: 'memory', response: `Found ${items.length} items:\n${list}` };
      }

      return { intent: 'memory', response: action.response || 'Memory action processed.' };
    }

    case 'calendar': {
      insert(`INSERT INTO memory_items (item_type, content, context, confidence, classified_at)
        VALUES (:type, :content, :ctx, 1.0, datetime('now','localtime'))`, {
        ':type': 'calendar_event',
        ':content': text,
        ':ctx': JSON.stringify({ source: 'voice_command', pending_calendar_sync: true })
      });
      return {
        intent: 'calendar',
        response: action.response || `Saved calendar event: "${text}". (Google Calendar sync coming soon.)`
      };
    }

    case 'ambient':
      return { intent: 'ambient', response: '[AMBIENT]' };

    case 'query':
    default:
      return { intent: 'query', response: action.response || 'No response generated.' };
  }
}

async function route(text, context = {}) {
  const cmdId = context._commandId || null;

  logStep(cmdId, 'received', `"${text}" from ${context.source || 'unknown'}, hint=${context.intent_hint || 'none'}`);

  // 1. Quick system commands that need zero Claude calls
  const serverIntent = serverClassify(text);
  if (serverIntent === 'system') {
    const quick = tryQuickSystem(text);
    if (quick) {
      logStep(cmdId, 'classified', 'system (quick, no Claude)');
      logStep(cmdId, 'completed', quick.response?.slice(0, 200));
      insertRouterEvent(text, quick.intent, quick.response, context);
      return quick;
    }
  }

  // 2. Everything else — single unified Claude call (classify + handle in one shot)
  logStep(cmdId, 'routing', 'unified Claude call');
  const result = await handleUnified(text, { ...context, _commandId: cmdId });

  logStep(cmdId, 'completed', result.response?.slice(0, 200));
  insertRouterEvent(text, result.intent, result.response, context);

  return result;
}

function insertRouterEvent(text, intent, response, context) {
  insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
    ':sid': `router-${Date.now()}`,
    ':type': 'RouterCommand',
    ':data': JSON.stringify({ text, intent, result: response, context })
  });
}

// Legacy export — kept for compatibility but no longer used internally
async function classifyIntent(text) {
  try {
    const result = await claude(
      `Classify this user request into exactly ONE category. Return ONLY the category name, nothing else.

Categories:
- terminal: wants to open, control, or interact with a terminal/project/code
- memory: wants to save, recall, or manage information (grocery list, idea, note, reminder)
- calendar: wants to add, check, or modify calendar events
- query: asking a question or wants information/analysis
- system: wants to control PAN itself (stop listening, change settings, status check)

User said: "${text}"`,
      { model: 'haiku', timeout: 15000 }
    );

    const intent = result.toLowerCase().replace(/[^a-z]/g, '');
    const VALID = ['terminal', 'memory', 'calendar', 'query', 'system'];
    return VALID.includes(intent) ? intent : 'query';
  } catch (e) {
    console.error('[PAN Router] Classification failed:', e.message);
    return 'query';
  }
}

export { route, classifyIntent };
