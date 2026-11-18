import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, parseAll } from '../src/sse.js';

const encoder = new TextEncoder();
const dataOf = events => events.filter(event => event.type === 'event').map(event => event.data);

test('frames split across chunks are reassembled (one byte at a time)', () => {
  const parser = new SseParser();
  const events = [];
  for (const byte of encoder.encode('data: {"a":1}\n\ndata: {"b":2}\n\n')) {
    events.push(...parser.feed(Uint8Array.of(byte)));
  }
  assert.deepEqual(dataOf(events), ['{"a":1}', '{"b":2}']);
});

test('CRLF and bare CR line endings are both accepted', () => {
  assert.deepEqual(dataOf(parseAll('data: one\r\n\r\ndata: two\r\n\r\n')), ['one', 'two']);
  assert.deepEqual(dataOf(parseAll('data: one\r\rdata: two\r\r')), ['one', 'two']);
});

test('CRLF split across two chunks is not mistaken for a blank line', () => {
  const parser = new SseParser();
  const events = [...parser.feed('data: split\r'), ...parser.feed('\n\r'), ...parser.feed('\n')];
  assert.deepEqual(dataOf(events), ['split']);
});

test('multiline data fields are joined with a newline', () => {
  assert.deepEqual(dataOf(parseAll('data: line one\ndata: line two\n\n')), ['line one\nline two']);
});

test('UTF-8 code points split across chunks survive', () => {
  const parser = new SseParser();
  const bytes = encoder.encode('data: héllo 🚀\n\n');
  const events = [];
  for (const byte of bytes) events.push(...parser.feed(Uint8Array.of(byte)));
  assert.deepEqual(dataOf(events), ['héllo 🚀']);
});

test('comments, empty frames and fields without a colon are handled', () => {
  assert.deepEqual(dataOf(parseAll(': keep-alive\n\n\n\ndata: real\n\n')), ['real']);
  assert.deepEqual(dataOf(parseAll('data:no-space\n\ndata:  two-spaces\n\n')), ['no-space', ' two-spaces']);
});

test('[DONE] terminates the stream and trailing bytes are ignored', () => {
  const parser = new SseParser();
  const events = [...parser.feed('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"late":true}\n\n')];
  assert.equal(parser.done, true);
  assert.equal(events.at(-1).type, 'done');
  assert.deepEqual(dataOf(events), ['{"a":1}']);
  assert.deepEqual(parser.feed('data: after-close\n\n'), []);
  assert.ok(parser.bytesAfterDone > 0);
});

test('a stream that never sends [DONE] stays explicitly incomplete', () => {
  const parser = new SseParser();
  assert.deepEqual(dataOf(parser.feed('data: partial\n\n')), ['partial']);
  assert.deepEqual(parser.flush(), []);
  assert.equal(parser.done, false);
});

test('flush emits a trailing frame with no closing blank line', () => {
  const parser = new SseParser();
  assert.deepEqual(dataOf(parser.feed('data: tail')), []);
  assert.deepEqual(dataOf(parser.flush()), ['tail']);
});

test('an event id is surfaced without being interpreted', () => {
  const events = parseAll('id: 42\ndata: payload\n\n');
  assert.equal(events[0].id, '42');
  assert.equal(events[0].data, 'payload');
});
