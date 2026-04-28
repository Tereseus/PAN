import { spawn } from 'child_process';
import { insert, all, get, logEvent, allScoped, getScoped } from './db.js';
import { claude } from './claude.js';
import { anonymizeForAI } from './anonymize.js';
import { isAvailable as weztermAvailable, openTerminal as weztermOpen, sendText as weztermSend, getText as weztermGet, listPanes as weztermList } from './wezterm.js';
import * as playwright from './playwright-bridge.js';
import { findSkill, getSkillPrompt, listSkills } from './skills.js';
import { resolvePreference, resolveDeviceAlias } from './routes/preferences.js';

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
  if (lower.match(/(play|pley|plai|payl|p[la]{1,2}y)\s+(some|song|music|something|somthing|anything)/)) return 'music';
  if (lower.match(/(open|lauch|opn|launch)\s+(spotify|youtube|music|apple\s*music)/)) return 'music';
  if (lower.match(/\b(spotify)\b.*\b(open|play|start|launch)\b|\b(open|play|start|launch)\b.*\b(spotify)\b/)) return 'music';
  if (lower.match(/(set|seet)\s+.*(alrm|alarm|timer|timr)/)) return 'calendar';
  if (lower.match(/(remind|remindme|remaind)\s+(me\s+)?(to|about)/)) return 'memory';
  if (lower.match(/^(take|jot)\s+a\s+(note|memo)/)) return 'memory';
  return null;
}

// Fast ambient pre-filter — detects speech clearly not directed at PAN without LLM call
// Only fires for voice/mic input (dashboard input is always a command)
function quickAmbientCheck(text) {
  const t = text.trim();
  // 1. Addressing someone else by name: "hey John", "hi Sarah", "hello guys"
  if (/^(?:hey|hi|hello)\s+(?!pan\b|pam\b)[a-z]{2,}/i.test(t)) return true;
  // 2. Common person nouns as direct address at start
  if (/^(?:mom|dad|honey|babe|sis|bro|buddy|guys|everyone|y'all|folks)\b/i.test(t)) return true;
  // 3. "I'll be there / meet you / call you back" — talking to someone else
  if (/^I'(?:ll|m)\s+(?:be\s+there|meet\s+you|call\s+you\s+back|see\s+you)/i.test(t)) return true;
  // 4. Name + "I'll meet/be/call" — "Sarah I'll meet you..."
  if (/^[A-Z][a-z]+\s+I'(?:ll|m)\s+/i.test(t)) return true;
  // 5. Filler acknowledgement followed by "call/meet/be" — "ok I'll call you back"
  if (/^(?:ok|okay|alright|yeah|sure|cool|got\s*it)[,.]?\s+I'(?:ll|m)\s+/i.test(t)) return true;
  return false;
}

// Quick system handlers that need no Claude call at all
async function tryQuickSystem(text) {
  const lower = text.toLowerCase();

  if (lower.includes('status')) {
    const stats = getScoped(null, `SELECT
      (SELECT COUNT(*) FROM events WHERE org_id = :org_id) as events,
      (SELECT COUNT(*) FROM memory_items WHERE org_id = :org_id) as memories,
      (SELECT COUNT(*) FROM projects WHERE org_id = :org_id) as projects
    `);
    return {
      intent: 'system',
      response: `PAN status: ${stats.events} events, ${stats.memories} memories, ${stats.projects} projects.`
    };
  }

  if (lower.includes('stop') || lower.includes('pause') || lower.includes('sleep')) {
    return { intent: 'system', response: 'PAN paused. Say "PAN wake up" to resume.', action: 'pause' };
  }

  // Incognito status check
  if (lower.match(/incognito|private\s*mode/)) {
    try {
      const row = get("SELECT value FROM settings WHERE key LIKE 'incognito_active_%'");
      if (row) {
        const state = JSON.parse(row.value);
        if (state.active) {
          return { intent: 'system', response: `Incognito is on. Started ${Math.round((Date.now() - state.started_at) / 60000)} minutes ago. Events are temporary.` };
        }
      }
      return { intent: 'system', response: 'Incognito is off. All events are being recorded normally.' };
    } catch {
      return { intent: 'system', response: 'Incognito is off.' };
    }
  }

  // Screen recording
  if (lower.match(/start\s+(screen\s+)?record/)) {
    const { startRecording } = await import('./screen-recorder.js');
    const result = startRecording({ fps: 2 });
    if (result.error) return { intent: 'system', response: `Already recording: ${result.file}` };
    return { intent: 'system', response: `Recording started at 2 FPS. Say "stop recording" when done.` };
  }

  if (lower.match(/stop\s+(screen\s+)?record/)) {
    const { stopRecording } = await import('./screen-recorder.js');
    const result = stopRecording();
    if (result.error) return { intent: 'system', response: 'Not currently recording.' };
    return { intent: 'system', response: `Recording saved (${result.duration} seconds). File: ${result.file}` };
  }

  return null;
}

// Single unified Claude call — classifies AND handles in one shot
async function handleUnified(text, context) {
  const cmdId = context._commandId || null;

  // Build project list for context
  const projects = allScoped(null, "SELECT name, path FROM projects WHERE org_id = :org_id ORDER BY name");
  const projectList = projects.map(p => `- ${p.name}: ${p.path.replace(/\//g, '\\')}`).join('\n');

  // Pull relevant memories for query context
  const memories = allScoped(null, `SELECT content, item_type FROM memory_items
    WHERE org_id = :org_id AND content LIKE :q ORDER BY created_at DESC LIMIT 5`, {
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
  // findSkill returns { skill, params } or null
  const skillMatch = findSkill(text);
  const skillBlock = skillMatch
    ? (logStep(cmdId, 'skill_matched', `${skillMatch.skill.name}${Object.keys(skillMatch.params).length ? ' params:' + JSON.stringify(skillMatch.params) : ''}`), getSkillPrompt(skillMatch))
    : '';

  logStep(cmdId, 'unified_call', 'single Claude call for classify+handle');

  let raw = '';
  try {
    const isDash = context.source === 'dashboard';
    // Load personality from settings
    let personality = '';
    try {
      const row = get("SELECT value FROM settings WHERE key = 'personality'");
      if (row) personality = row.value.replace(/^"|"$/g, '').trim();
    } catch {}
    const personalityBlock = personality ? `\nPersonality: ${personality}\nAlways stay in character.` : '';
    // Anonymize user text ONLY — sensor data (GPS, etc.) must pass through
    // so location-aware queries work. The sensor block is structured data the
    // user consented to share; the text may contain unintentional PII.
    const safeText = anonymizeForAI(text);

    const hintBlock = context.intent_hint
      ? `\nOVERRIDE: Server pattern matched — your response MUST use {"intent":"${context.intent_hint}",...}. Do not use a different intent.\n`
      : '';
    raw = await claude(
      `You are PAN, a personal AI. Be conversational, short (1-2 sentences, TTS). Return only JSON.${personalityBlock}
${historyBlock}${skillBlock}${sensorBlock}${hintBlock}
${isDash ? `User typed: "${safeText}"` : `Mic heard (may have STT typos/garbling — infer the most likely intent): "${safeText}"`}

${isDash ? 'Always respond.' : 'CRITICAL: If speech is clearly NOT directed at you (PAN), return EXACTLY: {"intent":"ambient","response":"[AMBIENT]"}'}
${isDash ? '' : `NEVER return ambient for: questions (what/when/where/how/why/who/can you), commands (play/open/set/remind/add), anything addressed to "Pan"/"Pam".
Return ambient for: side-conversations to another person, personal statements/thoughts NOT asking PAN anything ("I'll call you back", "I told him yesterday", "hold on let me finish this", "yeah that makes sense").
Ambient examples: "no no I told him it was fine" → ambient. "I was thinking we could go to dinner" → ambient. "yeah that makes sense" → ambient. "the weather looks nice today" → ambient.
Not ambient: "what the weather" (question). "remind me to buy milk" (command). "what time is it" (question). "open spotify" (command).
Rule: if there is no question and no command for PAN — return ambient.`}

Every response must include "speech_act" field:
"command" — direct instruction to execute something
"query" — question expecting an answer
"note" — first-person thought/diary, no action needed
"monologue" — long stream-of-consciousness, thinking out loud
"social" — talking to someone else in the room, not PAN
"ambient" — background speech, not directed at anyone

Response formats:
{"intent":"query","speech_act":"query","response":"answer"} — questions/conversation
{"intent":"terminal","speech_act":"command","action":"open|send-text|get-text|list-panes","project":"path","name":"name","pane_id":0,"text":"cmd","response":"msg"}
{"intent":"system","speech_act":"command","command":"PowerShell cmd","response":"msg"}
{"intent":"browser","speech_act":"command","action":"list_tabs|read_tab|activate_tab|type_text|click_element|navigate","query":"tab/URL","text":"input","response":"msg"}
{"intent":"memory","speech_act":"note","action":"save|recall","item_type":"type","content":"data","response":"msg"}
{"intent":"music","speech_act":"command","query":"song","service":"spotify|youtube|any","response":"msg"}
{"intent":"calendar","speech_act":"command","response":"msg"}

Projects: ${projectList}
${memoryContext}`,
      { caller: 'router', _skipAnonymize: true }
    );

    logStep(cmdId, 'unified_response', raw.slice(0, 200));

    // Strip thinking tags (Qwen 235B sometimes wraps in <think>...</think>)
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Extract JSON if wrapped in other text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    const action = JSON.parse(cleaned);
    return processUnifiedResult(action, text, context);
  } catch (e) {
    console.error('[PAN Router] Unified call error:', e.message, '| raw:', typeof raw === 'string' ? raw.slice(0, 300) : raw);
    return { intent: 'query', response: 'PAN is having trouble thinking right now.' };
  }
}

// Post-process the unified response into the correct return format
async function processUnifiedResult(action, text, context) {
  const intent = action.intent || 'query';
  // Propagate speech_act through all return paths
  const speech_act = action.speech_act || (intent === 'ambient' ? 'ambient' : 'command');

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
        insert(`INSERT INTO memory_items (item_type, content, context, confidence, classified_at, org_id)
          VALUES (:type, :content, :ctx, 1.0, datetime('now','localtime'), :org_id)`, {
          ':type': action.item_type || 'note',
          ':content': action.content || text,
          ':ctx': JSON.stringify({ source: 'voice_command', original: text }),
          ':org_id': 'org_personal'
        });
        return { intent: 'memory', response: action.response || `Saved: ${action.content}` };
      }

      if (action.action === 'recall' || action.action === 'list') {
        const items = allScoped(null, `SELECT * FROM memory_items WHERE org_id = :org_id AND (item_type = :type OR content LIKE :q) ORDER BY created_at DESC LIMIT 10`, {
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
      insert(`INSERT INTO memory_items (item_type, content, context, confidence, classified_at, org_id)
        VALUES (:type, :content, :ctx, 1.0, datetime('now','localtime'), :org_id)`, {
        ':type': 'calendar_event',
        ':content': text,
        ':ctx': JSON.stringify({ source: 'voice_command', pending_calendar_sync: true }),
        ':org_id': 'org_personal'
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
      return { intent: 'query', speech_act, response: action.response || 'No response generated.' };
  }
}

/**
 * Given a classified intent + the request context, determine WHERE and HOW to execute it.
 * Checks preference store first (user → org → unknown).
 * Returns { device_id, device_type, app, needsClarification, clarifyQuestion }
 */
async function resolveActionTarget(intent, text, user_id, org_id, activeDevices = []) {
  const ACTION_MAP = {
    'play_music':   'play_music',
    'play_movie':   'play_movie',
    'play_video':   'play_movie',
    'browse':       'open_browser',
    'browser':      'open_browser',
    'open_app':     'open_app',
    'navigate':     'navigate',
    'notification': 'show_notification',
    'terminal':     'terminal',
    'system':       'run_command',
  };
  const action_type = ACTION_MAP[intent] || intent;

  // Check preference store (user → org)
  const pref = resolvePreference(null, action_type, user_id, org_id);
  if (pref) {
    return {
      device_id: pref.device_id,
      device_type: pref.device_type,
      app: pref.app,
      action_type,
      needsClarification: false,
      source: pref.source,
    };
  }

  // Hard defaults that need no preference
  if (intent === 'terminal') return { device_type: 'desktop', action_type, needsClarification: false, source: 'default' };
  if (intent === 'system')   return { device_type: 'desktop', action_type, needsClarification: false, source: 'default' };
  if (intent === 'navigate') return { device_type: 'phone',   action_type, needsClarification: false, source: 'default' };
  if (intent === 'music')    return { device_type: 'phone',   action_type: 'play_music', needsClarification: false, source: 'default' };

  const pcDevices = activeDevices.filter(d => d.device_type === 'pc' || d.device_type === 'desktop');

  if (intent === 'play_movie' || intent === 'play_video') {
    if (pcDevices.length === 1) {
      const apps = getAvailableAppsForAction(action_type, pcDevices[0]);
      if (apps.length <= 1) {
        return { device_id: pcDevices[0].hostname, app: apps[0] || null, action_type, needsClarification: false, source: 'inferred' };
      }
      return {
        needsClarification: true,
        action_type,
        device_id: pcDevices[0].hostname,
        clarifyQuestion: `I can play that with ${apps.join(', ')} on ${pcDevices[0].name || pcDevices[0].hostname}. Which would you like?`,
        options: apps,
      };
    }
    if (pcDevices.length > 1) {
      const names = pcDevices.map(d => d.name || d.hostname).join(', ');
      return {
        needsClarification: true,
        action_type,
        clarifyQuestion: `Which device should I play it on? ${names}`,
        options: pcDevices.map(d => d.name || d.hostname),
      };
    }
  }

  // Fallback — no targeting info
  return { action_type, needsClarification: false, source: 'fallback' };
}

function getAvailableAppsForAction(action_type, device) {
  let caps = [];
  try { caps = JSON.parse(device.capabilities || '[]'); } catch {}
  const appCaps = caps.filter(c => c.startsWith('app:')).map(c => c.replace('app:', ''));

  const APP_AFFINITY = {
    'play_movie':   ['vlc', 'mpv', 'chrome', 'firefox'],
    'open_browser': ['chrome', 'firefox'],
    'play_music':   ['spotify', 'chrome', 'firefox'],
  };
  const preferred = APP_AFFINITY[action_type] || [];
  const available = preferred.filter(a => appCaps.includes(a));
  return available.length > 0 ? available : appCaps;
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

  // 1.5 Ambient pre-filter — voice input only, no LLM needed for obvious side-conversations
  const isVoice = context.source === 'voice' || context.source === 'mic' || context.source === 'benchmark';
  if (isVoice && context.source !== 'dashboard' && quickAmbientCheck(text)) {
    logStep(cmdId, 'classified', 'ambient (quick pre-filter, no Claude)');
    const r = { intent: 'ambient', response: '[AMBIENT]' };
    insertRouterEvent(text, r.intent, r.response, context);
    return r;
  }

  // 2. Everything else — single unified Claude call (classify + handle in one shot)
  // Pass serverClassify hint so LLM can use it for garbled/ambiguous text
  const hintedContext = serverIntent && serverIntent !== 'system'
    ? { ...context, intent_hint: serverIntent, _commandId: cmdId }
    : { ...context, _commandId: cmdId };

  logStep(cmdId, 'routing', 'unified Claude call');
  const result = await handleUnified(text, hintedContext);

  // Resolve where the action should execute (preference store → defaults → clarify)
  if (result.intent && result.intent !== 'ambient' && result.intent !== 'query') {
    try {
      let activeDevices = [];
      try {
        activeDevices = all(
          `SELECT hostname, name, device_type, capabilities FROM devices
           WHERE last_seen >= datetime('now', '-5 minutes', 'localtime') AND org_id = :o`,
          { ':o': context.org_id || 'org_personal' }
        ) || [];
      } catch {}

      const user_id = context.user_id || context.device_id || 'default';
      const org_id  = context.org_id  || 'org_personal';

      const target = await resolveActionTarget(result.intent, text, user_id, org_id, activeDevices);

      if (target.needsClarification) {
        result.response = target.clarifyQuestion;
        result.intent   = 'clarification';
        result.clarification = {
          action_type:   target.action_type,
          options:       target.options,
          pending_query: text,
        };
      } else if (target.device_id || target.device_type) {
        result.action_target = target;
      }
    } catch (e) {
      console.error('[PAN Router] resolveActionTarget failed:', e.message);
    }
  }

  logStep(cmdId, 'completed', result.response?.slice(0, 200));
  insertRouterEvent(text, result.intent, result.response, context);

  return result;
}

function insertRouterEvent(text, intent, response, context) {
  logEvent(`router-${Date.now()}`, 'RouterCommand', { text, intent, result: response, context });
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
      { model: 'haiku', timeout: 15000, caller: 'router' }
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
