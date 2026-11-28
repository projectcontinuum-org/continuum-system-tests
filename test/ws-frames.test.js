import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameParser, OPCODE, acceptKeyFor, encodeFrame } from '../lib/ws-frames.mjs';

// Vectors from RFC 6455 section 1.3 and 5.7.

test('the handshake accept key matches the RFC 6455 example', () => {
  assert.equal(acceptKeyFor('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('an unmasked text frame "Hello" is 81 05 48 65 6c 6c 6f', () => {
  assert.equal(encodeFrame(OPCODE.text, 'Hello').toString('hex'), '810548656c6c6f');
});

test('a masked text frame "Hello" matches the RFC example', () => {
  const frame = encodeFrame(OPCODE.text, 'Hello', Buffer.from([0x37, 0xfa, 0x21, 0x3d]));
  assert.equal(frame.toString('hex'), '818537fa213d7f9f4d5158');
});

test('payload lengths switch to the 16-bit and 64-bit forms at 126 and 65536 bytes', () => {
  const medium = encodeFrame(OPCODE.binary, Buffer.alloc(126, 1));
  assert.deepEqual([...medium.subarray(0, 4)], [0x82, 126, 0, 126]);
  assert.equal(medium.length, 4 + 126);
  const large = encodeFrame(OPCODE.binary, Buffer.alloc(65536, 2));
  assert.deepEqual([...large.subarray(0, 10)], [0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.equal(large.length, 10 + 65536);
});

test('a mask must be exactly four bytes', () => {
  assert.throws(() => encodeFrame(OPCODE.text, 'x', Buffer.from([1, 2, 3])), RangeError);
});

test('the parser reads masked and unmasked frames, also one byte at a time', () => {
  const masked = encodeFrame(OPCODE.text, 'Hello', Buffer.from([0x37, 0xfa, 0x21, 0x3d]));
  const parser = new FrameParser();
  const messages = [];
  for (const byte of masked) {
    messages.push(...parser.push(Buffer.from([byte])));
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].opcode, OPCODE.text);
  assert.equal(messages[0].payload.toString(), 'Hello');
  assert.equal(new FrameParser().push(encodeFrame(OPCODE.text, 'Hello'))[0].payload.toString(), 'Hello');
});

test('the parser round-trips 16-bit and 64-bit lengths and several frames in one chunk', () => {
  const a = Buffer.alloc(300, 7);
  const b = Buffer.alloc(70000, 9);
  const parser = new FrameParser();
  const messages = parser.push(Buffer.concat([encodeFrame(OPCODE.binary, a), encodeFrame(OPCODE.text, 'x'), encodeFrame(OPCODE.binary, b, Buffer.from([1, 2, 3, 4]))]));
  assert.deepEqual(messages.map((m) => m.payload.length), [300, 1, 70000]);
  assert.ok(messages[2].payload.equals(b));
});

test('fragmented messages are reassembled and a control frame may sit between the fragments', () => {
  const parser = new FrameParser();
  const first = Buffer.from('010348656c', 'hex'); // text, not final: "Hel"
  const ping = Buffer.from('8900', 'hex');
  const last = Buffer.from('80026c6f', 'hex'); // continuation, final: "lo"
  assert.deepEqual(parser.push(first), []);
  const messages = parser.push(Buffer.concat([ping, last]));
  assert.deepEqual(messages.map((m) => [m.opcode, m.payload.toString()]), [[OPCODE.ping, ''], [OPCODE.text, 'Hello']]);
});

test('a continuation frame with nothing to continue is an error, and so is an absurd frame length', () => {
  assert.throws(() => new FrameParser().push(Buffer.from('80026c6f', 'hex')), /continuation/);
  const huge = Buffer.alloc(10);
  huge[0] = 0x82;
  huge[1] = 127;
  huge.writeBigUInt64BE(1n << 40n, 2);
  assert.throws(() => new FrameParser().push(huge), RangeError);
});
