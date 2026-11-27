// A fault report's detail with nothing of the person's in it (fault-reports.js). Pure, so it is
// tested on its own: __tests__/fault-detail.test.js.

const MAX_DETAIL = 160;

/**
 * An error message with nothing of the person's left in it: anything in quotes or brackets (a
 * prompt, a name, a file) becomes "…", web and file paths go, and it is one short line.
 */
export function plainDetail(msg) {
  return String(msg ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`|\[[^\]]*\]|\{[^}]*\}/g, '…')
    .replace(/\b(?:https?:\/\/|file:\/\/)\S+/gi, '…')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.-]+[\\/])+[\w.-]*/g, '…')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '…')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
}

