import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeMessage, decodeMessages, createRpcClient, MAX_LSP_MESSAGE_BYTES, MAX_LSP_HEADER_BYTES } from '../rpc.js'
import { PassThrough } from 'node:stream'

describe('encodeMessage', () => {
  it('encodes a JSON-RPC request with Content-Length header', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, method: 'initialize', params: {} }
    const encoded = encodeMessage(msg)
    const body = JSON.stringify(msg)
    assert.ok(encoded.startsWith(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`))
    assert.ok(encoded.endsWith(body))
  })

  it('encodes a JSON-RPC response', () => {
    const msg = { jsonrpc: '2.0' as const, id: 2, result: { capabilities: {} } }
    const encoded = encodeMessage(msg)
    const body = JSON.stringify(msg)
    assert.ok(encoded.startsWith(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`))
    assert.ok(encoded.endsWith(body))
  })
})

describe('decodeMessages', () => {
  it('decodes a single complete message from buffer', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, result: { capabilities: {} } }
    const raw = encodeMessage(msg)
    const { messages, rest } = decodeMessages(raw)
    assert.equal(messages.length, 1)
    assert.deepEqual(messages[0], msg)
    assert.equal(rest, '')
  })

  it('returns empty when body is incomplete', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    const { messages, rest } = decodeMessages(header + body.slice(0, 5))
    assert.equal(messages.length, 0)
    assert.ok(rest.length > 0)
    assert.ok(rest.length < header.length + body.length)
  })

  it('decodes multiple messages in one buffer', () => {
    const msg1 = { jsonrpc: '2.0' as const, id: 1, result: { a: 1 } }
    const msg2 = { jsonrpc: '2.0' as const, id: 2, result: { b: 2 } }
    const raw = encodeMessage(msg1) + encodeMessage(msg2)
    const { messages } = decodeMessages(raw)
    assert.equal(messages.length, 2)
  })

  it('handles empty input', () => {
    const { messages, rest } = decodeMessages('')
    assert.equal(messages.length, 0)
    assert.equal(rest, '')
  })

  it('returns rest for trailing incomplete message', () => {
    const msg1 = { jsonrpc: '2.0' as const, id: 1, result: { a: 1 } }
    // Content-Length claims 999 bytes but only 5 chars of body follow
    const raw = encodeMessage(msg1) + 'Content-Length: 999\r\n\r\n{"jso'
    const { messages, rest } = decodeMessages(raw)
    assert.equal(messages.length, 1)
    assert.equal(rest, 'Content-Length: 999\r\n\r\n{"jso')
  })

  it('rejects oversized and malformed Content-Length before reading a body', () => {
    for (const length of [String(MAX_LSP_MESSAGE_BYTES + 1), '999999999999999999999999999999999']) {
      assert.throws(() => decodeMessages(`Content-Length: ${length}\r\n\r\n`), /body too large/)
    }
    for (const header of ['Content-Length: -1', 'Content-Length: 1junk', 'Content-Length: 1.5', 'Content-Length: 1\r\nContent-Length: 2', 'Content-Type: application/json']) {
      assert.throws(() => decodeMessages(header + '\r\n\r\n'), /Invalid LSP Content-Length/)
    }
  })

  it('bounds incomplete and complete oversized headers', () => {
    assert.throws(() => decodeMessages('G'.repeat(MAX_LSP_HEADER_BYTES + 1)), /header buffer exceeded/)
    assert.throws(() => decodeMessages('G'.repeat(MAX_LSP_HEADER_BYTES) + '\r\n\r\n'), /header buffer exceeded/)
  })
})

describe('createRpcClient', () => {
  /**
   * Create a pair of connected PassThrough streams.
   * Client writes to toServer → server reads from fromClient (same stream, readable side).
   * Server writes to toClient → client reads from fromServer (same stream, readable side).
   */
  function connect() {
    const toServer = new PassThrough()
    const toClient = new PassThrough()
    // fromClient = toServer (readable side of what client writes)
    // fromServer = toClient (readable side of what server writes)
    return { toServer, toClient, fromClient: toServer, fromServer: toClient }
  }

  it('sends request and resolves response by id', async () => {
    const { toServer, toClient, fromClient } = connect()

    // Client: reads from toClient (server responses), writes to toServer
    const client = createRpcClient(toClient, toServer)

    // Server: reads from fromClient, writes responses to toClient
    let serverBuf = ''
    fromClient.on('data', (chunk: Buffer) => {
      serverBuf += chunk.toString()
      const { messages, rest } = decodeMessages(serverBuf)
      serverBuf = rest
      for (const msg of messages) {
        if ('method' in msg && msg.method === 'test' && 'id' in msg) {
          toClient.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id: msg.id,
            result: { ok: true },
          }))
        }
      }
    })

    const result = await client.request('test', { foo: 'bar' })
    assert.deepEqual(result, { ok: true })
    client.dispose()
  })

  it('rejects on error response', async () => {
    const { toServer, toClient, fromClient } = connect()
    const client = createRpcClient(toClient, toServer)

    let serverBuf = ''
    fromClient.on('data', (chunk: Buffer) => {
      serverBuf += chunk.toString()
      const { messages, rest } = decodeMessages(serverBuf)
      serverBuf = rest
      for (const msg of messages) {
        if ('method' in msg && msg.method === 'bad' && 'id' in msg) {
          toClient.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id: msg.id,
            error: { code: -32600, message: 'Invalid Request' },
          }))
        }
      }
    })

    await assert.rejects(
      () => client.request('bad', {}),
      /Invalid Request/,
    )
    client.dispose()
  })

  it('handles notifications via onNotification', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)

    const received: unknown[] = []
    client.onNotification('window/logMessage', (params) => {
      received.push(params)
    })

    // Push notification from server side directly to client's readable stream
    toClient.push(encodeMessage({
      jsonrpc: '2.0' as const,
      method: 'window/logMessage',
      params: { message: 'hello' },
    }))

    await new Promise(r => setTimeout(r, 20))
    assert.equal(received.length, 1)
    assert.deepEqual(received[0], { message: 'hello' })
    client.dispose()
  })

  it('times out a request that never receives a response', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer, { requestTimeoutMs: 25 })

    await assert.rejects(
      () => client.request('initialize', {}),
      /LSP request initialize timed out after 0.025s/,
    )
    client.dispose()
  })

  it('abortAllPending rejects every in-flight request', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)

    const pending = client.request('initialize', {})
    client.abortAllPending(new Error('LSP process died'))

    await assert.rejects(() => pending, /LSP process died/)
    client.dispose()
  })

  it('dispose rejects pending requests instead of leaving them hanging', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)

    const pending = client.request('initialize', {})
    client.dispose()

    await assert.rejects(() => pending, /RPC client disposed/)
  })

  it('dispose does not throw', () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)
    client.dispose()
  })

  it('kills oversized claims and headerless input, rejecting every pending request', async () => {
    for (const input of [`Content-Length: ${MAX_LSP_MESSAGE_BYTES + 1}\r\n\r\n`, 'G'.repeat(MAX_LSP_HEADER_BYTES + 1)]) {
      const { toServer, toClient } = connect()
      const client = createRpcClient(toClient, toServer)
      const first = assert.rejects(client.request('initialize', {}), /LSP transport failed/)
      const second = assert.rejects(client.request('diagnostics', {}), /LSP transport failed/)
      toClient.emit('data', Buffer.from(input))
      await Promise.all([first, second])
      assert.equal(toClient.listenerCount('data'), 0, 'failed RPC must detach its input handler')
      toClient.emit('data', Buffer.alloc(1024 * 1024))
      client.dispose()
    }
  })

  it('accepts a body exactly at the cap including header overhead', () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)
    let received = 0
    client.onNotification('fixture', params => { assert.equal((params.text as string).length, size); received++ })
    const prefix = '{"jsonrpc":"2.0","method":"fixture","params":{"text":"', suffix = '"}}'
    const size = MAX_LSP_MESSAGE_BYTES - Buffer.byteLength(prefix + suffix)
    const frame = Buffer.from(`Content-Length: ${MAX_LSP_MESSAGE_BYTES}\r\n\r\n${prefix}${'x'.repeat(size)}${suffix}`)
    assert.doesNotThrow(() => assert.equal(decodeMessages(frame).messages.length, 1))
    toClient.emit('data', frame)
    assert.equal(received, 1)
    client.dispose()
  })

  it('accepts coalesced legal frames whose combined bytes exceed the cap', () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)
    let received = 0
    client.onNotification('fixture', () => { received++ })
    const frame = encodeMessage({ jsonrpc: '2.0', method: 'fixture', params: { text: 'x'.repeat(9 * 1024 * 1024) } })
    toClient.emit('data', Buffer.from(frame + frame))
    assert.equal(received, 2)
    assert.equal(toClient.listenerCount('data'), 1)
    client.dispose()
  })

  it('preserves fragmented Unicode and frame boundaries across arbitrary byte chunks', () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)
    const received: unknown[] = []
    client.onNotification('fixture', params => received.push(params.text))
    const text = '中文🧭é'
    const frame = Buffer.from(encodeMessage({ jsonrpc: '2.0', method: 'fixture', params: { text } }))
    for (const byte of frame) toClient.emit('data', Buffer.from([byte]))
    toClient.emit('data', Buffer.from('Content-Length: 4\r\n\r\nnullContent-Length: 0\r\n\r\n'))
    toClient.emit('data', frame)
    assert.deepEqual(received, [text, text])
    client.dispose()
  })

  it('rejects new requests immediately after transport failure without writing', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)
    let writes = 0
    toServer.on('data', () => { writes++ })
    toClient.emit('data', Buffer.from(`Content-Length: ${MAX_LSP_MESSAGE_BYTES + 1}\r\n\r\n`))
    const request = client.request('after-failure', {}, 20)
    const check = assert.rejects(request, /LSP transport failed/)
    // A timer must not be necessary to observe rejection after a terminal failure.
    await Promise.resolve()
    client.notify('after-failure', {})
    assert.equal(writes, 0)
    await check
    client.dispose()
  })

  it('read/write errors, close and dispose remain terminal without removing unrelated listeners', async () => {
    for (const kind of ['read', 'write', 'close', 'dispose']) {
      const { toServer, toClient } = connect()
      const observer = () => {}
      toClient.on('data', observer)
      toClient.on('error', observer)
      const client = createRpcClient(toClient, toServer)
      if (kind === 'read') toClient.emit('error', new Error('fixture'))
      if (kind === 'write') toServer.emit('error', new Error('fixture'))
      if (kind === 'close') toClient.emit('close')
      if (kind === 'dispose') client.dispose()
      await assert.rejects(client.request('after-death', {}, 20), /LSP transport|disposed/)
      client.dispose()
      assert.equal(toClient.listeners('data').includes(observer), true)
      assert.equal(toClient.listeners('error').includes(observer), true)
    }
  })
})
