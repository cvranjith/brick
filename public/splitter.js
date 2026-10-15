// Splits a pty text stream into plain terminal data and out-of-band hooks.
// Hook wire format:
//   ESC P $ d <hex(utf8(JSON))> ESC \
// Hex keeps the payload free of ESC/ST bytes, so the end marker can be found with a plain search.

const START = '\x1bP$d';
const END = '\x1b\\';
const MAX_PENDING = 1 << 20;

export function decodeHook(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class HookSplitter {
  constructor({ onData, onHook }) {
    this.onData = onData;
    this.onHook = onHook;
    this.buf = '';
  }

  push(chunk) {
    this.buf += chunk;
    for (;;) {
      const start = this.buf.indexOf(START);
      if (start < 0) {
        // Hold back a tail that could be the beginning of START split across chunks.
        const keep = partialPrefixLength(this.buf);
        const out = this.buf.slice(0, this.buf.length - keep);
        if (out) this.onData(out);
        this.buf = this.buf.slice(this.buf.length - keep);
        return;
      }
      if (start > 0) this.onData(this.buf.slice(0, start));
      const end = this.buf.indexOf(END, start + START.length);
      if (end < 0) {
        this.buf = this.buf.slice(start);
        if (this.buf.length > MAX_PENDING) { this.onData(this.buf); this.buf = ''; }
        return;
      }
      const hex = this.buf.slice(start + START.length, end);
      this.buf = this.buf.slice(end + END.length);
      try { this.onHook(decodeHook(hex)); } catch { this.onData(START + hex + END); }
    }
  }
}

function partialPrefixLength(s) {
  const max = Math.min(START.length - 1, s.length);
  for (let n = max; n > 0; n--) if (START.startsWith(s.slice(s.length - n))) return n;
  return 0;
}
