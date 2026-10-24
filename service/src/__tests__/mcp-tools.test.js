// MCP tool-schema unit tests — runs standalone, no server needed
// Usage: node service/src/__tests__/mcp-tools.test.js
//
// The `pan` tool dispatches on a string that must match its own enum, and
// nothing ties the two together at runtime:
//
//   - a new `case` with no enum entry is UNREACHABLE. The schema rejects the
//     action before the handler ever runs, so the feature looks broken with no
//     error pointing at the cause.
//   - a stale enum entry passes validation and falls through to `default:`,
//     which reports "Unknown action" for something the schema just advertised.
//
// The enum is also what the client's tool-discovery layer indexes, so it is the
// only reason these actions are visible at all. This test is that tie.
//
// Schemas are read from the REAL registration (via a stub server) rather than
// parsed out of the source, so it tests what clients actually receive.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerPanTools } from '../mcp/pan-tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(__dirname, '..', 'mcp', 'pan-tools.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

/** Run the real registration against a stub, keeping each tool's schema. */
function collectTools() {
  const tools = {};
  const server = {
    tool(...args) {
      const name = args[0];
      // Signature varies: (name, schema, handler) or (name, description, schema, handler).
      const schema = args.slice(1).find(
        (a) => a && typeof a === 'object' && !Array.isArray(a));
      tools[name] = schema || {};
    },
    resource() {},
    prompt() {},
  };
  registerPanTools(server, { panBaseUrl: 'http://localhost:7777' });
  return tools;
}

/** Pull the allowed values out of a zod enum (zod 4 keeps them on .options). */
function enumValues(shape) {
  if (!shape) return null;
  if (Array.isArray(shape.options)) return [...shape.options];
  const def = shape._zod?.def ?? shape._def;
  const entries = def?.entries ?? def?.values;
  if (!entries) return null;
  return Array.isArray(entries) ? [...entries] : Object.values(entries);
}

console.log('\nMCP tool schemas\n');

const tools = collectTools();
const src = readFileSync(SOURCE, 'utf8');

// The case extraction below assumes a single switch in the file. If a second one
// is ever added, this test fails first and says so, rather than the sync test
// silently comparing against cases from the wrong switch.
test('pan-tools.js contains exactly one action switch', () => {
  const switches = src.match(/switch \(action\)/g) || [];
  assert(switches.length === 1,
    `expected 1 "switch (action)", found ${switches.length} — update the case extraction in this test`);
});

const cases = [...src.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]);
const actionEnum = enumValues(tools.pan?.action);

test('pan tool is registered', () => {
  assert(tools.pan, 'no tool named "pan" was registered');
  assert(tools.pan.action, 'the pan tool has no "action" parameter');
});

test('pan action is an enum, not a free string', () => {
  assert(actionEnum !== null,
    'action is not a zod enum — a bare z.string() hides every action from client tool discovery');
  assert(actionEnum.length > 0, 'action enum is empty');
});

test('the switch declares at least one case', () => {
  assert(cases.length > 0, 'no case labels found — the extraction regex may be stale');
});

test('every switch case is offered by the enum', () => {
  const offered = new Set(actionEnum || []);
  const missing = cases.filter((c) => !offered.has(c));
  assert(missing.length === 0,
    `unreachable action(s), the schema rejects them before the handler runs: ${missing.join(', ')}`);
});

test('every enum value has a switch case', () => {
  const handled = new Set(cases);
  const extra = (actionEnum || []).filter((e) => !handled.has(e));
  assert(extra.length === 0,
    `advertised but unhandled, these fall through to default: ${extra.join(', ')}`);
});

test('enum has no duplicate values', () => {
  const seen = new Set();
  const dupes = (actionEnum || []).filter((e) => seen.size === seen.add(e).size);
  assert(dupes.length === 0, `duplicate enum value(s): ${dupes.join(', ')}`);
});

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);
process.exit(failed > 0 ? 1 : 0);
