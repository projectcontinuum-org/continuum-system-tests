import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL, closeFrame, dataFrame, engineMessage, fillPlaceholders, openFrame, parseChannelFrame, parseEnginePacket, parseSocketPacket,
  rawDataFrame, readString, socketBinaryEventHeader, socketConnect, socketEvent, writeString,
} from '../lib/theia-wire.mjs';

const ID = '/services/language-server/kotlin-script';

test('a Theia string is a big-endian byte length and the UTF-8 bytes (multi-byte text counts bytes)', () => {
  const encoded = writeString('héllo ✓');
  assert.equal(encoded.readUInt32BE(0), Buffer.byteLength('héllo ✓'));
  assert.deepEqual(readString(encoded, 0), { value: 'héllo ✓', next: encoded.length });
  assert.deepEqual(readString(Buffer.concat([Buffer.from([9]), writeString('ab')]), 1), { value: 'ab', next: 7 });
});

test('reading a string from a short buffer fails instead of returning a truncated value', () => {
  assert.throws(() => readString(Buffer.from([0, 0]), 0), RangeError);
  assert.throws(() => readString(Buffer.from([0, 0, 0, 5, 65, 66]), 0), /does not fit/);
});

test('open, close and data frames carry their type byte first and the channel id as a string', () => {
  assert.equal(openFrame(ID)[0], CHANNEL.open);
  assert.equal(closeFrame(ID)[0], CHANNEL.close);
  const data = dataFrame(ID, '{"jsonrpc":"2.0"}');
  assert.equal(data[0], CHANNEL.data);
  assert.deepEqual(readString(data, 1).value, ID);
});

test('channel frames decode to their kind, id and text', () => {
  assert.deepEqual(parseChannelFrame(openFrame(ID)), { kind: 'open', id: ID });
  assert.deepEqual(parseChannelFrame(closeFrame(ID)), { kind: 'close', id: ID });
  assert.deepEqual(parseChannelFrame(Buffer.concat([Buffer.from([CHANNEL.ackOpen]), writeString(ID)])), { kind: 'ackOpen', id: ID });
  assert.deepEqual(parseChannelFrame(dataFrame(ID, 'héllo')), { kind: 'data', id: ID, text: 'héllo' });
});

test('a data frame whose payload is not exactly one string keeps its bytes', () => {
  const parsed = parseChannelFrame(rawDataFrame(ID, Buffer.from([1, 2, 3])));
  assert.equal(parsed.kind, 'data');
  assert.equal(parsed.text, undefined);
  assert.deepEqual([...parsed.payload], [1, 2, 3]);
});

test('empty, truncated and unknown channel frames are rejected', () => {
  assert.throws(() => parseChannelFrame(Buffer.alloc(0)), /empty/);
  assert.throws(() => parseChannelFrame(Buffer.from([CHANNEL.open, 0, 0])), RangeError);
  assert.throws(() => parseChannelFrame(Buffer.concat([Buffer.from([9]), writeString(ID)])), /unknown channel frame type 9/);
});

test('Engine.IO packets are recognised by their first character', () => {
  assert.deepEqual(parseEnginePacket('0{"sid":"abc"}'), { type: 'open', data: '{"sid":"abc"}' });
  assert.deepEqual(parseEnginePacket('2'), { type: 'ping', data: '' });
  assert.deepEqual(parseEnginePacket('40/services,'), { type: 'message', data: '0/services,' });
  assert.throws(() => parseEnginePacket(''), /empty/);
  assert.throws(() => parseEnginePacket('9x'), /unknown/);
});

test('the Socket.IO packets a client sends have the shapes Theia expects', () => {
  assert.equal(engineMessage(socketConnect('/services')), '40/services,');
  assert.equal(engineMessage(socketEvent('/services', 'initialConnection', 'front-1')), '42/services,["initialConnection","front-1"]');
  assert.equal(engineMessage(socketBinaryEventHeader('/services', 'message')), '451-/services,["message",{"_placeholder":true,"num":0}]');
});

test('Socket.IO packets parse with and without namespace, attachments and acknowledgement id', () => {
  assert.deepEqual(parseSocketPacket('0/services,'), { type: 0, namespace: '/services', attachments: 0, id: undefined, data: undefined });
  assert.deepEqual(parseSocketPacket('0/services,{"sid":"x"}').data, { sid: 'x' });
  assert.deepEqual(parseSocketPacket('2/services,["initialConnection"]').data, ['initialConnection']);
  const binary = parseSocketPacket('51-/services,["message",{"_placeholder":true,"num":0}]');
  assert.equal(binary.type, 5);
  assert.equal(binary.attachments, 1);
  assert.equal(binary.namespace, '/services');
  assert.deepEqual(parseSocketPacket('2/services,12["x"]').id, 12);
  assert.deepEqual(parseSocketPacket('2["x"]'), { type: 2, namespace: '/', attachments: 0, id: undefined, data: ['x'] });
  assert.throws(() => parseSocketPacket('9/services,'), /unknown Socket.IO packet type/);
  assert.throws(() => parseSocketPacket('5/services,[]'), /attachment count/);
});

test('placeholders in an event are replaced by the received attachments, at any depth', () => {
  const buffer = Buffer.from([1, 2]);
  assert.deepEqual(fillPlaceholders(['message', { _placeholder: true, num: 0 }], [buffer]), ['message', buffer]);
  assert.deepEqual(fillPlaceholders({ a: [{ _placeholder: true, num: 1 }], b: 'x' }, [Buffer.from('p'), buffer]), { a: [buffer], b: 'x' });
});
