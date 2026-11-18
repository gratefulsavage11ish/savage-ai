// Dependency-free Server-Sent Events parser.
//
// Shared by the provider adapters (upstream provider -> server) and the browser
// client (server -> browser). It owns only wire parsing: chunk boundaries, CRLF,
// multiline `data:` fields, UTF-8 sequences split across chunks, `[DONE]` and
// trailing bytes. Callers decide what an incomplete stream means.
//
// Wire rules implemented (WHATWG SSE):
//   - lines end in CRLF, LF or CR
//   - a blank line dispatches the frame collected so far
//   - multiple `data:` lines are joined with "\n"
//   - a single leading space after the colon is stripped
//   - lines starting with ":" are comments and are ignored
//   - `event:` / `id:` / `retry:` are parsed but not interpreted here
//
// OpenAI-style `[DONE]` is treated as a terminal marker: once seen, the parser
// reports `done = true`, emits { type: 'done' } and ignores everything after it.

const DONE_MARKER = '[DONE]';

function byteLength(chunk) {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk).length;
  if (chunk && typeof chunk.byteLength === 'number') return chunk.byteLength;
  return 0;
}

export class SseParser {
  #decoder = null;
  #buffer = '';
  #data = [];
  #lastEventId = null;

  constructor({ doneMarker = DONE_MARKER } = {}) {
    this.doneMarker = doneMarker;
    this.done = false;
    this.frames = 0;
    this.bytesAfterDone = 0;
    this.#decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: false }) : null;
  }

  /** Feed one chunk (string, Uint8Array, Buffer or ArrayBuffer). Returns completed events. */
  feed(chunk) {
    if (chunk == null) return [];
    if (this.done) { this.bytesAfterDone += byteLength(chunk); return []; }
    const text = typeof chunk === 'string'
      ? chunk
      : this.#decoder
        ? this.#decoder.decode(chunk, { stream: true })
        : String(chunk);
    if (!text) return [];
    this.#buffer += text;
    return this.#drain(false);
  }

  /**
   * Flush at end of stream: emits the final decoder bytes, a trailing line with
   * no terminator, and any frame that never got its blank line. Callers must
   * still check `done` to distinguish a complete stream from a truncated one.
   */
  flush() {
    if (this.done) return [];
    if (this.#decoder) {
      const tail = this.#decoder.decode();
      if (tail) this.#buffer += tail;
    }
    return this.#drain(true);
  }

  get pendingData() { return this.#data.length; }

  #drain(final) {
    const out = [];
    for (;;) {
      const buffer = this.#buffer;
      if (!buffer.length) break;
      let index = -1;
      let width = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const code = buffer.charCodeAt(i);
        if (code === 10) { index = i; width = 1; break; }
        if (code === 13) {
          // A CR at the very end of the buffer may be the first half of CRLF.
          if (i + 1 < buffer.length) { index = i; width = buffer.charCodeAt(i + 1) === 10 ? 2 : 1; }
          break;
        }
      }
      if (index < 0) {
        if (!final) break;
        // No terminator at all: the remaining text is the last line.
        this.#buffer = '';
        this.#line(buffer.replace(/\r$/, ''), out);
        break;
      }
      this.#buffer = buffer.slice(index + width);
      this.#line(buffer.slice(0, index), out);
      if (this.done) break;
    }
    if (final && this.#data.length) this.#emit(out);
    return out;
  }

  #line(line, out) {
    if (line === '') { this.#emit(out); return; }
    if (line.startsWith(':')) return; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'id') this.#lastEventId = value;
    // `event:` and `retry:` are accepted but not interpreted.
  }

  #emit(out) {
    if (!this.#data.length) return;
    const data = this.#data.join('\n');
    this.#data = [];
    this.frames += 1;
    if (data === this.doneMarker) {
      this.done = true;
      this.#buffer = ''; // bytes after [DONE] are ignored on purpose
      out.push({ type: 'done', data });
      return;
    }
    out.push({ type: 'event', data, id: this.#lastEventId });
  }
}

/** Convenience wrapper for a complete string body (useful in tests and fixtures). */
export function parseAll(text, options) {
  const parser = new SseParser(options);
  return [...parser.feed(text), ...parser.flush()];
}

export { DONE_MARKER };
