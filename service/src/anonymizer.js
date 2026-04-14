// PAN Anonymizer — NER-based PII stripping for data export and data dividends
//
// Detects and replaces PII with typed placeholders:
//   [EMAIL], [PHONE], [SSN], [CARD], [IP], [NAME], [ADDRESS], [DOB]
//
// Raw data stays in encrypted DB (personal). Anonymized version is for sharing.

const PII_PATTERNS = [
  // Email addresses
  {
    type: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  },
  // US Social Security Numbers (XXX-XX-XXXX or XXXXXXXXX)
  {
    type: 'SSN',
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    validate: (match) => {
      const digits = match.replace(/[-\s]/g, '');
      if (digits.length !== 9) return false;
      // SSNs don't start with 000, 666, or 9xx
      const area = parseInt(digits.slice(0, 3));
      return area > 0 && area !== 666 && area < 900;
    },
  },
  // Credit card numbers (13-19 digits, with optional spaces/dashes)
  {
    type: 'CARD',
    pattern: /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g,
    validate: (match) => {
      const digits = match.replace(/[-\s]/g, '');
      if (digits.length < 13 || digits.length > 19) return false;
      // Luhn check
      let sum = 0;
      let alt = false;
      for (let i = digits.length - 1; i >= 0; i--) {
        let n = parseInt(digits[i]);
        if (alt) { n *= 2; if (n > 9) n -= 9; }
        sum += n;
        alt = !alt;
      }
      return sum % 10 === 0;
    },
  },
  // US phone numbers — requires at least one separator (dash, dot, space, parens)
  // to avoid matching timestamps, filenames, and other long digit sequences
  {
    type: 'PHONE',
    pattern: /(?<![_/\\\w])(?:\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?![_\w])/g,
    validate: (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 11;
    },
  },
  // IPv4 addresses
  {
    type: 'IP',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    validate: (match) => {
      // Skip common non-PII IPs (localhost, broadcast, private ranges used in code examples)
      if (match === '127.0.0.1' || match === '0.0.0.0' || match === '255.255.255.255') return false;
      return true;
    },
  },
  // Dates of birth (MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD with context)
  {
    type: 'DOB',
    pattern: /\b(?:born|dob|birth(?:day|date)?|b\.?d\.?)\s*[:=]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/gi,
  },
  // US street addresses (number + street name + type)
  {
    type: 'ADDRESS',
    pattern: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Ct|Court|Pl(?:ace)?|Way|Cir(?:cle)?|Pkwy|Parkway|Hwy|Highway)\b\.?(?:\s*(?:#|Apt\.?|Suite|Ste\.?|Unit)\s*\w+)?/gi,
  },
];

// Common first names (top 200 US) for name detection
const COMMON_FIRST_NAMES = new Set([
  'james', 'mary', 'robert', 'patricia', 'john', 'jennifer', 'michael', 'linda',
  'david', 'elizabeth', 'william', 'barbara', 'richard', 'susan', 'joseph', 'jessica',
  'thomas', 'sarah', 'christopher', 'karen', 'charles', 'lisa', 'daniel', 'nancy',
  'matthew', 'betty', 'anthony', 'margaret', 'mark', 'sandra', 'donald', 'ashley',
  'steven', 'dorothy', 'paul', 'kimberly', 'andrew', 'emily', 'joshua', 'donna',
  'kenneth', 'michelle', 'kevin', 'carol', 'brian', 'amanda', 'george', 'melissa',
  'timothy', 'deborah', 'ronald', 'stephanie', 'edward', 'rebecca', 'jason', 'sharon',
  'jeffrey', 'laura', 'ryan', 'cynthia', 'jacob', 'kathleen', 'gary', 'amy',
  'nicholas', 'angela', 'eric', 'shirley', 'jonathan', 'anna', 'stephen', 'brenda',
  'larry', 'pamela', 'justin', 'emma', 'scott', 'nicole', 'brandon', 'helen',
  'benjamin', 'samantha', 'samuel', 'katherine', 'raymond', 'christine', 'gregory', 'debra',
  'frank', 'rachel', 'alexander', 'carolyn', 'patrick', 'janet', 'jack', 'catherine',
  'dennis', 'maria', 'jerry', 'heather', 'tyler', 'diane', 'aaron', 'ruth',
  'jose', 'julie', 'adam', 'olivia', 'nathan', 'joyce', 'henry', 'virginia',
  'peter', 'victoria', 'zachary', 'kelly', 'douglas', 'lauren', 'harold', 'christina',
  'carl', 'joan', 'arthur', 'evelyn', 'gerald', 'judith', 'roger', 'megan',
  'keith', 'andrea', 'jeremy', 'cheryl', 'terry', 'hannah', 'lawrence', 'jacqueline',
  'sean', 'martha', 'albert', 'gloria', 'joe', 'teresa', 'christian', 'ann',
  'austin', 'sara', 'willie', 'madison', 'jesse', 'frances', 'ethan', 'kathryn',
  'billy', 'janice', 'bruce', 'jean', 'bryan', 'abigail', 'ralph', 'alice',
  'roy', 'judy', 'jordan', 'sophia', 'eugene', 'grace', 'wayne', 'denise',
  'dylan', 'amber', 'alan', 'doris', 'juan', 'marilyn', 'louis', 'danielle',
  'russell', 'beverly', 'gabriel', 'isabella', 'randy', 'theresa', 'philip', 'diana',
  'vincent', 'natalie', 'bobby', 'brittany', 'johnny', 'charlotte', 'logan', 'marie',
  'noah', 'kayla', 'liam', 'alexis', 'mason', 'lori', 'luke', 'alyssa',
]);

// Words that look like names but aren't (skip these)
const NOT_NAMES = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now',
  'old', 'see', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'use',
  'pan', 'api', 'url', 'sql', 'css', 'npm', 'git', 'cli', 'app', 'web',
  'node', 'java', 'code', 'file', 'data', 'null', 'true', 'false', 'void',
  'main', 'test', 'build', 'start', 'stop', 'error', 'debug', 'info', 'warn',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'claude', 'anthropic', 'google', 'microsoft', 'android', 'windows', 'linux',
  'chrome', 'firefox', 'safari', 'electron', 'svelte', 'react', 'express',
  'sqlite', 'cerebras', 'tailscale', 'github', 'discord', 'slack',
  'server', 'client', 'router', 'dashboard', 'terminal', 'sensor', 'device',
  'project', 'session', 'memory', 'config', 'settings', 'status', 'health',
  'image', 'audio', 'video', 'photo', 'screen', 'camera', 'button',
  'string', 'number', 'object', 'array', 'function', 'class', 'import', 'export',
  'const', 'async', 'await', 'return', 'select', 'insert', 'update', 'delete',
  'service', 'system', 'desktop', 'mobile', 'phone', 'pendant',
]);

// Detect likely person names: "Firstname Lastname" pattern
// Uses common first name list + capitalization heuristic
function detectNames(text) {
  const nameMatches = [];

  // Pattern: Capitalized word followed by another capitalized word
  // Must start with a common first name OR both words capitalized and not in NOT_NAMES
  const namePattern = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,20})\b/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const first = match[1].toLowerCase();
    const second = match[2].toLowerCase();

    // Skip if either word is a known non-name
    if (NOT_NAMES.has(first) || NOT_NAMES.has(second)) continue;

    // Accept if first word is a common first name
    if (COMMON_FIRST_NAMES.has(first)) {
      nameMatches.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
  }

  return nameMatches;
}

/**
 * Anonymize text by replacing PII with typed placeholders.
 *
 * @param {string} text - Raw text to anonymize
 * @param {object} options - Which PII types to strip
 * @param {boolean} options.emails - Strip emails (default: true)
 * @param {boolean} options.phones - Strip phone numbers (default: true)
 * @param {boolean} options.ssns - Strip SSNs (default: true)
 * @param {boolean} options.cards - Strip credit cards (default: true)
 * @param {boolean} options.ips - Strip IP addresses (default: true)
 * @param {boolean} options.dobs - Strip dates of birth (default: true)
 * @param {boolean} options.addresses - Strip street addresses (default: true)
 * @param {boolean} options.names - Strip person names (default: true)
 * @returns {{ text: string, replacements: Array<{type: string, original: string, position: number}> }}
 */
function anonymize(text, options = {}) {
  if (!text || typeof text !== 'string') return { text: text || '', replacements: [] };

  const opts = {
    emails: true,
    phones: true,
    ssns: true,
    cards: true,
    ips: true,
    dobs: true,
    addresses: true,
    names: true,
    ...options,
  };

  // Collect all replacements with positions so we can apply them without overlap
  const replacements = [];

  // Type mapping for options
  const typeEnabled = {
    EMAIL: opts.emails,
    PHONE: opts.phones,
    SSN: opts.ssns,
    CARD: opts.cards,
    IP: opts.ips,
    DOB: opts.dobs,
    ADDRESS: opts.addresses,
  };

  // Run regex patterns
  for (const { type, pattern, validate } of PII_PATTERNS) {
    if (!typeEnabled[type]) continue;
    // Reset regex state
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (validate && !validate(match[0])) continue;
      replacements.push({
        type,
        original: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // Run name detection
  if (opts.names) {
    const names = detectNames(text);
    for (const n of names) {
      replacements.push({
        type: 'NAME',
        original: n.text,
        start: n.start,
        end: n.end,
      });
    }
  }

  if (replacements.length === 0) return { text, replacements: [] };

  // Sort by position (start), longest first for overlaps
  replacements.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  // Remove overlapping matches (keep the first/longest)
  const filtered = [];
  let lastEnd = 0;
  for (const r of replacements) {
    if (r.start >= lastEnd) {
      filtered.push(r);
      lastEnd = r.end;
    }
  }

  // Apply replacements from end to start to preserve positions
  let result = text;
  const applied = [];
  for (let i = filtered.length - 1; i >= 0; i--) {
    const r = filtered[i];
    result = result.slice(0, r.start) + `[${r.type}]` + result.slice(r.end);
    applied.unshift({ type: r.type, original: r.original, position: r.start });
  }

  return { text: result, replacements: applied };
}

/**
 * Anonymize a JSON data string (as stored in events table).
 * Walks through string values and anonymizes each one.
 *
 * @param {string} dataStr - JSON string
 * @param {object} options - Anonymization options
 * @returns {{ data: string, totalReplacements: number }}
 */
function anonymizeEventData(dataStr, options = {}) {
  if (!dataStr) return { data: dataStr, totalReplacements: 0 };

  let data;
  try { data = JSON.parse(dataStr); } catch { return { data: dataStr, totalReplacements: 0 }; }

  let totalReplacements = 0;

  function walkAndAnonymize(obj) {
    if (typeof obj === 'string') {
      const result = anonymize(obj, options);
      totalReplacements += result.replacements.length;
      return result.text;
    }
    if (Array.isArray(obj)) {
      return obj.map(walkAndAnonymize);
    }
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(obj)) {
        out[key] = walkAndAnonymize(value);
      }
      return out;
    }
    return obj;
  }

  const anonymized = walkAndAnonymize(data);
  return { data: JSON.stringify(anonymized), totalReplacements };
}

/**
 * Quick stats: count PII instances in text without replacing
 */
function detectPII(text) {
  const result = anonymize(text);
  return result.replacements;
}

export { anonymize, anonymizeEventData, detectPII };
