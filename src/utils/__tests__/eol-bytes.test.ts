import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksBinary, normalizeEolBytes } from '../eol-bytes.js'

test('normalizeEolBytes: CRLF → LF', () => {
  assert.deepEqual(normalizeEolBytes(Buffer.from('a\r\nb\r\n')), Buffer.from('a\nb\n'))
})

test('normalizeEolBytes: 纯 LF 原样返回（同一对象，热路径零拷贝）', () => {
  const input = Buffer.from('a\nb\n')
  assert.equal(normalizeEolBytes(input), input)
})

test('normalizeEolBytes: 含 NUL 视为二进制，原样返回', () => {
  const input = Buffer.from([0x61, 0x0d, 0x0a, 0x00, 0x62])
  assert.equal(normalizeEolBytes(input), input)
  assert.equal(looksBinary(input), true)
})

test('normalizeEolBytes: 单独的 CR 不被改写', () => {
  const input = Buffer.from('a\rb')
  assert.equal(normalizeEolBytes(input), input)
  assert.equal(looksBinary(input), false)
})

test('normalizeEolBytes: 尾部 CRLF 不越界', () => {
  const input = Buffer.concat([Buffer.alloc(1024, 0x61), Buffer.from('\r\n')])
  const out = normalizeEolBytes(input)
  assert.equal(out.length, 1025)
  assert.equal(out[1024], 0x0a)
})

test('normalizeEolBytes: 空缓冲安全', () => {
  assert.equal(normalizeEolBytes(Buffer.alloc(0)).length, 0)
})

test('normalizeEolBytes: 混合行尾只去掉 CRLF 里的 CR', () => {
  assert.deepEqual(normalizeEolBytes(Buffer.from('a\r\nb\nc\rd\r\n')), Buffer.from('a\nb\nc\rd\n'))
})
