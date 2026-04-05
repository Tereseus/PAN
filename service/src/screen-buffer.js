// PAN Screen Buffer — lightweight VT100 terminal emulator
// Processes PTY output into a screen grid, renders to HTML.
// No xterm.js dependency — pure JS, runs server-side.

const PALETTE = [
  '#45475a','#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#cba6f7','#94e2d5','#bac2de',
  '#585b70','#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#cba6f7','#94e2d5','#a6adc8',
];

function color256(n) {
  if (n < 16) return PALETTE[n] || '#cdd6f4';
  if (n < 232) {
    const i = n - 16;
    return `rgb(${Math.floor(i/36)*51},${Math.floor((i%36)/6)*51},${(i%6)*51})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const FG_MAP = { 30:'#45475a',31:'#f38ba8',32:'#a6e3a1',33:'#f9e2af',34:'#89b4fa',35:'#cba6f7',36:'#94e2d5',37:'#bac2de',
                 90:'#585b70',91:'#f38ba8',92:'#a6e3a1',93:'#f9e2af',94:'#89b4fa',95:'#cba6f7',96:'#94e2d5',97:'#a6adc8' };

// Simple Unicode width check — full-width CJK and some symbols take 2 columns
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp <= 0x1F || (cp >= 0x7F && cp <= 0x9F)) return 0; // control chars
  // CJK Unified Ideographs, CJK Compatibility, Hangul, fullwidth forms
  if ((cp >= 0x1100 && cp <= 0x115F) || // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0x303E) || // CJK Radicals
      (cp >= 0x3040 && cp <= 0x33BF) || // Hiragana, Katakana, CJK
      (cp >= 0x3400 && cp <= 0x4DBF) || // CJK Extension A
      (cp >= 0x4E00 && cp <= 0xA4CF) || // CJK Unified
      (cp >= 0xAC00 && cp <= 0xD7AF) || // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) || // CJK Compatibility Ideographs
      (cp >= 0xFE30 && cp <= 0xFE6F) || // CJK Compatibility Forms
      (cp >= 0xFF01 && cp <= 0xFF60) || // Fullwidth forms
      (cp >= 0xFFE0 && cp <= 0xFFE6) || // Fullwidth signs
      (cp >= 0x20000 && cp <= 0x2FA1F) || // CJK Extension B-F
      (cp >= 0x1F300 && cp <= 0x1F9FF)) { // Emoji
    return 2;
  }
  return 1;
}

class ScreenBuffer {
  constructor(cols = 120, rows = 30) {
    this.cols = cols;
    this.rows = rows;
    this.scrollback = [];
    this.maxScrollback = 2000;
    this.cx = 0;
    this.cy = 0;
    this.savedCx = 0;
    this.savedCy = 0;
    this.altSavedCx = 0;
    this.altSavedCy = 0;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.altScreen = false;
    this.wraparound = true;
    this.style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, reverse: false };

    this.screen = [];
    this.altScreenBuf = null;
    for (let y = 0; y < rows; y++) {
      this.screen.push(this._emptyRow());
    }
  }

  _emptyRow() {
    const row = [];
    for (let x = 0; x < this.cols; x++) {
      row.push({ ch: ' ', style: { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, reverse: false } });
    }
    return row;
  }

  _cloneStyle() {
    return { ...this.style };
  }

  resize(cols, rows) {
    while (this.screen.length < rows) this.screen.push(this._emptyRow());
    while (this.screen.length > rows) {
      const removed = this.screen.shift();
      this.scrollback.push(this._renderLine(removed));
      if (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
    }
    if (cols !== this.cols) {
      for (let y = 0; y < this.screen.length; y++) {
        while (this.screen[y].length < cols) this.screen[y].push({ ch: ' ', style: this._cloneStyle() });
        if (this.screen[y].length > cols) this.screen[y].length = cols;
      }
    }
    this.cols = cols;
    this.rows = rows;
    this.scrollBottom = rows - 1;
    this.cx = Math.min(this.cx, cols - 1);
    this.cy = Math.min(this.cy, rows - 1);
  }

  _scrollUp() {
    const removed = this.screen.splice(this.scrollTop, 1)[0];
    if (this.scrollTop === 0 && !this.altScreen) {
      this.scrollback.push(this._renderLine(removed));
      if (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
    }
    this.screen.splice(this.scrollBottom, 0, this._emptyRow());
  }

  _scrollDown() {
    this.screen.splice(this.scrollBottom + 1, 1);
    this.screen.splice(this.scrollTop, 0, this._emptyRow());
  }

  write(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      const code = ch.charCodeAt(0);

      // ESC sequence
      if (ch === '\x1b') {
        i++;
        if (i >= data.length) break;
        const next = data[i];

        if (next === '[') {
          // CSI sequence — parse properly
          i++;
          let prefix = ''; // '?' or '>' or '!' etc.
          let params = '';
          let intermediate = '';

          // Collect prefix (private mode indicators: ?, >, =, !)
          if (i < data.length && (data[i] === '?' || data[i] === '>' || data[i] === '=' || data[i] === '!')) {
            prefix = data[i++];
          }

          // Collect parameter bytes (0-9, ;, :)
          while (i < data.length && ((data[i] >= '0' && data[i] <= '9') || data[i] === ';' || data[i] === ':')) {
            params += data[i++];
          }

          // Collect intermediate bytes (space through /)
          while (i < data.length && data[i] >= '\x20' && data[i] <= '\x2f') {
            intermediate += data[i++];
          }

          // Final byte
          const final = i < data.length ? data[i++] : '';
          this._handleCSI(prefix, params, intermediate, final);

        } else if (next === ']') {
          // OSC — skip until BEL or ST
          i++;
          while (i < data.length) {
            if (data[i] === '\x07') { i++; break; }
            if (data[i] === '\x1b' && i + 1 < data.length && data[i+1] === '\\') { i += 2; break; }
            i++;
          }
        } else if (next === '(' || next === ')' || next === '*' || next === '+') {
          i++; // skip charset designation char
          if (i < data.length) i++; // skip the charset identifier (B, 0, etc.)
          continue;
        } else {
          // Simple two-byte ESC sequences
          if (next === '7') { this.savedCx = this.cx; this.savedCy = this.cy; }
          else if (next === '8') { this.cx = this.savedCx; this.cy = this.savedCy; }
          else if (next === 'M') {
            if (this.cy === this.scrollTop) this._scrollDown();
            else if (this.cy > 0) this.cy--;
          }
          else if (next === 'D') {
            if (this.cy === this.scrollBottom) this._scrollUp();
            else this.cy++;
          }
          else if (next === 'E') {
            this.cx = 0;
            if (this.cy === this.scrollBottom) this._scrollUp();
            else this.cy++;
          }
          else if (next === 'c') {
            this._clearAll();
            this.cx = 0; this.cy = 0;
            this.style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, reverse: false };
          }
          // =, >, #, etc. — ignore
          i++; // advance past the ESC identifier byte
          continue;
        }
        continue; // CSI and OSC already advanced i
      }

      // Control characters
      if (code < 32 || code === 127) {
        if (ch === '\r') { this.cx = 0; }
        else if (ch === '\n') {
          if (this.cy === this.scrollBottom) this._scrollUp();
          else if (this.cy < this.rows - 1) this.cy++;
        }
        else if (ch === '\x08') { if (this.cx > 0) this.cx--; } // Backspace
        else if (ch === '\t') {
          this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8);
        }
        // Bell, other control chars — ignore
        i++;
        continue;
      }

      // Regular character — handle Unicode code points (including surrogate pairs)
      let codePoint = code;
      let charStr = ch;
      // Handle surrogate pairs for chars above U+FFFF
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < data.length) {
        const low = data.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          codePoint = ((code - 0xD800) << 10) + (low - 0xDC00) + 0x10000;
          charStr = data[i] + data[i + 1];
          i++; // consume extra char
        }
      }

      const w = charWidth(charStr);

      // Auto-wrap at end of line
      if (this.cx + w > this.cols) {
        if (this.wraparound) {
          this.cx = 0;
          if (this.cy === this.scrollBottom) this._scrollUp();
          else if (this.cy < this.rows - 1) this.cy++;
        } else {
          this.cx = this.cols - w;
        }
      }

      if (this.cy >= 0 && this.cy < this.rows && this.cx >= 0 && this.cx < this.cols) {
        this.screen[this.cy][this.cx] = { ch: charStr, style: this._cloneStyle() };
        if (w === 2 && this.cx + 1 < this.cols) {
          // Wide char takes 2 cells — second cell is empty placeholder
          this.screen[this.cy][this.cx + 1] = { ch: '', style: this._cloneStyle() };
        }
        this.cx += w;
      }
      i++;
    }
  }

  _handleCSI(prefix, params, intermediate, final) {
    const parts = params ? params.split(';').map(s => parseInt(s) || 0) : [0];
    const p0 = parts[0] || 0;
    const p1 = parts[1] || 0;

    // Private mode sequences (prefix = '?', '>', etc.)
    if (prefix === '?') {
      if (final === 'h' || final === 'l') {
        // Parse all mode numbers
        for (const mode of parts) {
          if (mode === 1049 || mode === 47) {
            if (final === 'h') {
              // Save cursor + switch to alt screen
              this.altSavedCx = this.cx; this.altSavedCy = this.cy;
              this.altScreenBuf = this.screen;
              this.screen = [];
              for (let y = 0; y < this.rows; y++) this.screen.push(this._emptyRow());
              this.altScreen = true;
              this.cx = 0; this.cy = 0;
            } else {
              // Switch back + restore cursor
              if (this.altScreenBuf) {
                this.screen = this.altScreenBuf;
                this.altScreenBuf = null;
              }
              this.altScreen = false;
              this.cx = this.altSavedCx; this.cy = this.altSavedCy;
            }
          } else if (mode === 7) {
            this.wraparound = (final === 'h');
          }
          // 25: cursor visible, 1: cursor keys, 2004: bracketed paste — all ignored
        }
      }
      // ?J (DECSED), ?K (DECSEL) — treat like normal J/K
      if (final === 'J') {
        if (p0 === 0) this._clearFrom(this.cy, this.cx);
        else if (p0 === 1) this._clearTo(this.cy, this.cx);
        else if (p0 === 2 || p0 === 3) this._clearAll();
      }
      if (final === 'K') {
        if (p0 === 0) this._clearLineFrom(this.cy, this.cx);
        else if (p0 === 1) this._clearLineTo(this.cy, this.cx);
        else if (p0 === 2) this._clearFullLine(this.cy);
      }
      return;
    }

    // '>' prefix sequences (like >c for secondary DA) — ignore
    if (prefix === '>' || prefix === '=' || prefix === '!') return;

    switch (final) {
      case 'm': this._handleSGR(parts); break;
      case 'A': this.cy = Math.max(this.scrollTop, this.cy - (p0 || 1)); break;
      case 'B': this.cy = Math.min(this.scrollBottom, this.cy + (p0 || 1)); break;
      case 'C': this.cx = Math.min(this.cols - 1, this.cx + (p0 || 1)); break;
      case 'D': this.cx = Math.max(0, this.cx - (p0 || 1)); break;
      case 'E': this.cy = Math.min(this.scrollBottom, this.cy + (p0 || 1)); this.cx = 0; break;
      case 'F': this.cy = Math.max(this.scrollTop, this.cy - (p0 || 1)); this.cx = 0; break;
      case 'G': this.cx = Math.min(this.cols - 1, Math.max(0, (p0 || 1) - 1)); break;
      case 'H': case 'f':
        this.cy = Math.min(this.rows - 1, Math.max(0, (p0 || 1) - 1));
        this.cx = Math.min(this.cols - 1, Math.max(0, (p1 || 1) - 1));
        break;
      case 'J':
        if (p0 === 0) this._clearFrom(this.cy, this.cx);
        else if (p0 === 1) this._clearTo(this.cy, this.cx);
        else if (p0 === 2 || p0 === 3) this._clearAll();
        break;
      case 'K':
        if (p0 === 0) this._clearLineFrom(this.cy, this.cx);
        else if (p0 === 1) this._clearLineTo(this.cy, this.cx);
        else if (p0 === 2) this._clearFullLine(this.cy);
        break;
      case 'L':
        for (let n = 0; n < (p0 || 1); n++) this._scrollDown();
        break;
      case 'M':
        for (let n = 0; n < (p0 || 1); n++) this._scrollUp();
        break;
      case 'S':
        for (let n = 0; n < (p0 || 1); n++) this._scrollUp();
        break;
      case 'T':
        for (let n = 0; n < (p0 || 1); n++) this._scrollDown();
        break;
      case 'P':
        if (this.cy < this.rows) {
          const row = this.screen[this.cy];
          const n = Math.min(p0 || 1, this.cols - this.cx);
          row.splice(this.cx, n);
          for (let j = 0; j < n; j++) row.push({ ch: ' ', style: this._cloneStyle() });
        }
        break;
      case '@':
        if (this.cy < this.rows) {
          const row = this.screen[this.cy];
          const n = Math.min(p0 || 1, this.cols - this.cx);
          for (let j = 0; j < n; j++) row.splice(this.cx, 0, { ch: ' ', style: this._cloneStyle() });
          row.length = this.cols;
        }
        break;
      case 'r':
        this.scrollTop = Math.max(0, (p0 || 1) - 1);
        this.scrollBottom = Math.min(this.rows - 1, (p1 || this.rows) - 1);
        this.cx = 0; this.cy = 0;
        break;
      case 's': this.savedCx = this.cx; this.savedCy = this.cy; break;
      case 'u': this.cx = this.savedCx; this.cy = this.savedCy; break;
      case 'X':
        for (let n = 0; n < (p0 || 1) && this.cx + n < this.cols; n++) {
          if (this.cy < this.rows) {
            this.screen[this.cy][this.cx + n] = { ch: ' ', style: this._cloneStyle() };
          }
        }
        break;
      case 'd':
        this.cy = Math.min(this.rows - 1, Math.max(0, (p0 || 1) - 1));
        break;
      case 'b': // Repeat previous character
        // Not commonly needed, skip
        break;
      case 'c': // Device attributes — ignore
        break;
      case 'n': // Device status report — ignore
        break;
      case 't': // Window manipulation — ignore
        break;
    }
  }

  _handleSGR(codes) {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0 || isNaN(c)) {
        this.style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, reverse: false };
      } else if (c === 1) this.style.bold = true;
      else if (c === 2) this.style.dim = true;
      else if (c === 3) this.style.italic = true;
      else if (c === 4) this.style.underline = true;
      else if (c === 7) this.style.reverse = true; // Reverse video flag
      else if (c === 9) this.style.strike = true;
      else if (c === 22) { this.style.bold = false; this.style.dim = false; }
      else if (c === 23) this.style.italic = false;
      else if (c === 24) this.style.underline = false;
      else if (c === 27) this.style.reverse = false; // Reverse off
      else if (c === 29) this.style.strike = false;
      else if (c >= 30 && c <= 37) this.style.fg = FG_MAP[c];
      else if (c >= 90 && c <= 97) this.style.fg = FG_MAP[c];
      else if (c === 38) {
        if (codes[i+1] === 5) { this.style.fg = color256(codes[i+2] || 0); i += 2; }
        else if (codes[i+1] === 2) { this.style.fg = `rgb(${codes[i+2]||0},${codes[i+3]||0},${codes[i+4]||0})`; i += 4; }
      }
      else if (c === 39) this.style.fg = null;
      else if (c >= 40 && c <= 47) this.style.bg = FG_MAP[c - 10];
      else if (c >= 100 && c <= 107) this.style.bg = FG_MAP[c - 10];
      else if (c === 48) {
        if (codes[i+1] === 5) { this.style.bg = color256(codes[i+2] || 0); i += 2; }
        else if (codes[i+1] === 2) { this.style.bg = `rgb(${codes[i+2]||0},${codes[i+3]||0},${codes[i+4]||0})`; i += 4; }
      }
      else if (c === 49) this.style.bg = null;
    }
  }

  _clearFrom(y, x) {
    for (let i = x; i < this.cols; i++) {
      if (y < this.rows) this.screen[y][i] = { ch: ' ', style: this._cloneStyle() };
    }
    for (let row = y + 1; row < this.rows; row++) {
      this.screen[row] = this._emptyRow();
    }
  }

  _clearTo(y, x) {
    for (let row = 0; row < y; row++) this.screen[row] = this._emptyRow();
    for (let i = 0; i <= x && i < this.cols; i++) {
      if (y < this.rows) this.screen[y][i] = { ch: ' ', style: this._cloneStyle() };
    }
  }

  _clearAll() {
    for (let y = 0; y < this.rows; y++) this.screen[y] = this._emptyRow();
  }

  _clearLineFrom(y, x) {
    if (y >= this.rows) return;
    for (let i = x; i < this.cols; i++) {
      this.screen[y][i] = { ch: ' ', style: this._cloneStyle() };
    }
  }

  _clearLineTo(y, x) {
    if (y >= this.rows) return;
    for (let i = 0; i <= x && i < this.cols; i++) {
      this.screen[y][i] = { ch: ' ', style: this._cloneStyle() };
    }
  }

  _clearFullLine(y) {
    if (y >= this.rows) return;
    this.screen[y] = this._emptyRow();
  }

  _renderLine(row) {
    let html = '';
    let curStyle = '';

    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      if (cell.ch === '') continue; // skip wide char placeholder

      // Apply reverse video at render time — swap fg/bg
      let fg = cell.style.fg;
      let bg = cell.style.bg;
      if (cell.style.reverse) {
        fg = cell.style.bg || '#1e1e2e';
        bg = cell.style.fg || '#cdd6f4';
      }

      const parts = [];
      if (fg) parts.push(`color:${fg}`);
      if (bg) parts.push(`background:${bg}`);
      if (cell.style.bold) parts.push('font-weight:bold');
      if (cell.style.dim) parts.push('opacity:0.6');
      if (cell.style.italic) parts.push('font-style:italic');
      if (cell.style.underline) parts.push('text-decoration:underline');
      if (cell.style.strike) parts.push('text-decoration:line-through');
      const style = parts.join(';');

      if (style !== curStyle) {
        if (curStyle) html += '</span>';
        if (style) html += `<span style="${style}">`;
        curStyle = style;
      }

      const ch = cell.ch;
      if (ch === '<') html += '&lt;';
      else if (ch === '>') html += '&gt;';
      else if (ch === '&') html += '&amp;';
      else html += ch;
    }
    if (curStyle) html += '</span>';
    return html.replace(/ +$/, '');
  }

  renderScreen() {
    return this.screen.map(row => this._renderLine(row));
  }

  getScrollback(maxLines = 500) {
    return this.scrollback.slice(-maxLines);
  }
}

export { ScreenBuffer };
