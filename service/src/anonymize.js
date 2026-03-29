// PAN Data Anonymization Layer
// Strips PII from text before it goes to any cloud AI provider.
// Runs on-device (server-side) — data never leaves unprotected.

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s]?\d{4,14})/g;
const SSN_REGEX = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const IP_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const GPS_REGEX = /[-+]?\d{1,3}\.\d{4,}[,\s]+[-+]?\d{1,3}\.\d{4,}/g;

// Common address patterns (street numbers + common suffixes)
const ADDRESS_REGEX = /\b\d{1,5}\s+[\w\s]{2,30}\b(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|court|ct|way|place|pl|circle|cir)\b/gi;

/**
 * Anonymize text by replacing PII with placeholders.
 * @param {string} text - Raw text that may contain PII
 * @param {object} options
 * @param {boolean} options.stripEmails - Replace email addresses (default: true)
 * @param {boolean} options.stripPhones - Replace phone numbers (default: true)
 * @param {boolean} options.stripSSN - Replace SSN-like patterns (default: true)
 * @param {boolean} options.stripCards - Replace credit card numbers (default: true)
 * @param {boolean} options.stripGPS - Replace GPS coordinates (default: true)
 * @param {boolean} options.stripIPs - Replace IP addresses (default: false — needed for networking context)
 * @param {boolean} options.stripAddresses - Replace street addresses (default: true)
 * @param {string[]} options.customPatterns - Additional regex patterns to strip
 * @param {string[]} options.preserveWords - Words/phrases to NOT strip even if they match
 * @returns {{ anonymized: string, stripped: object[] }}
 */
function anonymize(text, options = {}) {
  const {
    stripEmails = true,
    stripPhones = true,
    stripSSN = true,
    stripCards = true,
    stripGPS = true,
    stripIPs = false,
    stripAddresses = true,
    customPatterns = [],
    preserveWords = []
  } = options;

  if (!text || typeof text !== 'string') return { anonymized: text, stripped: [] };

  let result = text;
  const stripped = [];

  function replace(regex, type, placeholder) {
    result = result.replace(regex, (match) => {
      // Don't strip preserved words
      if (preserveWords.some(w => match.toLowerCase().includes(w.toLowerCase()))) {
        return match;
      }
      stripped.push({ type, original: match });
      return placeholder;
    });
  }

  if (stripSSN) replace(SSN_REGEX, 'ssn', '[SSN-REDACTED]');
  if (stripCards) replace(CREDIT_CARD_REGEX, 'credit_card', '[CARD-REDACTED]');
  if (stripEmails) replace(EMAIL_REGEX, 'email', '[EMAIL-REDACTED]');
  if (stripPhones) replace(PHONE_REGEX, 'phone', '[PHONE-REDACTED]');
  if (stripGPS) replace(GPS_REGEX, 'gps', '[GPS-REDACTED]');
  if (stripIPs) replace(IP_REGEX, 'ip', '[IP-REDACTED]');
  if (stripAddresses) replace(ADDRESS_REGEX, 'address', '[ADDRESS-REDACTED]');

  // Custom patterns
  for (const pattern of customPatterns) {
    try {
      const regex = new RegExp(pattern, 'g');
      replace(regex, 'custom', '[REDACTED]');
    } catch {}
  }

  return { anonymized: result, stripped };
}

/**
 * Anonymize for AI prompts — strips PII but keeps the text readable.
 * Used before sending to cloud AI providers.
 */
function anonymizeForAI(text, options = {}) {
  return anonymize(text, { ...options, stripIPs: false }).anonymized;
}

/**
 * Anonymize for data export/staking — more aggressive stripping.
 * Used before data leaves the device for the data dividend system.
 */
function anonymizeForExport(text, options = {}) {
  return anonymize(text, { ...options, stripIPs: true, stripGPS: true, stripAddresses: true }).anonymized;
}

export { anonymize, anonymizeForAI, anonymizeForExport };
