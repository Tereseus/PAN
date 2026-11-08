// safe-files.js — file names and paths built from what a caller sent.
//
// The screenshot and clipboard routes save and serve files named from request
// fields. Without these checks a caller could put "..\" in a field and read or
// write outside the folder (found 2026-11-08; docs/INSTALL-PLAN.md, "Found while
// testing").

import { resolve, sep } from 'path';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'bmp']);

/** The file extension for an image MIME type like "image/png"; 'png' for anything else. */
export function imageExt(mimeType) {
  const ext = String(mimeType || '').split('/')[1]?.toLowerCase();
  return IMAGE_EXT.has(ext) ? ext : 'png';
}

/** s when it is a short tag (letters, digits, dash), else the fallback. Safe inside a file name. */
export function safeTag(s, fallback) {
  const t = String(s ?? '');
  return /^[A-Za-z0-9-]{1,32}$/.test(t) ? t : fallback;
}

/** The full path of p when it lies inside dir, else null. Case-insensitive on Windows. */
export function insideDir(dir, p) {
  if (typeof p !== 'string' || p === '') return null;
  const base = resolve(dir) + sep;
  const full = resolve(p);
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  return norm(full).startsWith(norm(base)) ? full : null;
}
