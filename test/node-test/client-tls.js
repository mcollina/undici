'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { Readable } = require('node:stream')
const tls = require('node:tls')
const { Client, buildConnector } = require('../..')

const tlsRenegFixtures = path.join(__dirname, '..', 'fixtures', 'tls-renegotiation')
const matchingKey = fs.readFileSync(path.join(tlsRenegFixtures, 'matching-key.pem'))
const matchingCert = fs.readFileSync(path.join(tlsRenegFixtures, 'matching-cert.pem'))
const matchingCa = fs.readFileSync(path.join(tlsRenegFixtures, 'ca.pem'))

// A TLS application-data record with a corrupted payload/MAC. OpenSSL reports
// ERR_SSL_* on the TLSSocket without closing the underlying TCP connection.
const CORRUPT_TLS_RECORD = Buffer.concat([
  Buffer.from([0x17, 0x03, 0x03, 0x00, 0x20]),
  Buffer.alloc(32, 0xaa)
])

const TEST_TIMEOUT = 10_000

function localhostLookup (hostname, options, callback) {
  if (options.all === true) {
    callback(null, [{ address: '127.0.0.1', family: 4 }])
  } else {
    callback(null, '127.0.0.1', 4)
  }
}

async function setupTlsClient (t, onConnection, clientOpts = {}) {
  const rawSockets = new Set()
  const server = net.createServer((rawSocket) => {
    rawSockets.add(rawSocket)
    rawSocket.on('close', () => rawSockets.delete(rawSocket))
    rawSocket.on('error', () => {})

    const tlsSocket = new tls.TLSSocket(rawSocket, {
      isServer: true,
      key: matchingKey,
      cert: matchingCert,
      ALPNProtocols: ['http/1.1']
    })
    tlsSocket.on('error', () => {})

    onConnection(rawSocket, tlsSocket)
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const client = new Client(`https://localhost:${server.address().port}`, {
    allowH2: false,
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: {
      ca: matchingCa,
      lookup: localhostLookup
    },
    ...clientOpts
  })

  t.after(async () => {
    await client.destroy()
    for (const s of rawSockets) {
      s.destroy()
    }
    await new Promise((resolve) => server.close(resolve))
  })

  return client
}

test('TLSSocket ERR_SSL_* error without close rejects in-flight request instead of hanging', { timeout: TEST_TIMEOUT }, async (t) => {
  let connNum = 0
  const socketErrorCounts = []
  const baseConnect = buildConnector({
    allowH2: false,
    ca: matchingCa,
    lookup: localhostLookup
  })

  const client = await setupTlsClient(t, (rawSocket, tlsSocket) => {
    const current = ++connNum
    tlsSocket.once('data', () => {
      if (current === 1) {
        rawSocket.write(CORRUPT_TLS_RECORD)
      } else {
        tlsSocket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
      }
    })
  }, {
    connect (opts, cb) {
      return baseConnect(opts, (err, socket) => {
        if (socket) {
          const idx = socketErrorCounts.length
          socketErrorCounts.push(0)
          socket.on('error', () => {
            socketErrorCounts[idx]++
          })
        }
        cb(err, socket)
      })
    }
  })

  const disconnectErrors = []
  client.on('disconnect', (_origin, _targets, err) => {
    disconnectErrors.push(err)
  })

  await assert.rejects(
    client.request({ path: '/', method: 'GET' }),
    (err) => {
      assert.match(err.code, /^ERR_SSL_/)
      return true
    }
  )

  assert.strictEqual(socketErrorCounts[0], 1, 'socket must not emit duplicate error events')
  assert.strictEqual(disconnectErrors.length, 1)
  assert.match(disconnectErrors[0].code, /^ERR_SSL_/)

  const res = await client.request({ path: '/', method: 'GET' })
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(await res.body.text(), 'ok')
  assert.strictEqual(connNum, 2)
})

test('TLSSocket ERR_SSL_* error mid-body rejects response stream instead of hanging', { timeout: TEST_TIMEOUT }, async (t) => {
  let connNum = 0
  const client = await setupTlsClient(t, (rawSocket, tlsSocket) => {
    const current = ++connNum
    tlsSocket.once('data', () => {
      if (current === 1) {
        tlsSocket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial', () => {
          rawSocket.write(CORRUPT_TLS_RECORD)
        })
      } else {
        tlsSocket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
      }
    })
  })

  const res = await client.request({ path: '/', method: 'GET' })
  assert.strictEqual(res.statusCode, 200)

  await assert.rejects(
    res.body.text(),
    (err) => {
      assert.match(err.code, /^ERR_SSL_/)
      return true
    }
  )

  const res2 = await client.request({ path: '/', method: 'GET' })
  assert.strictEqual(res2.statusCode, 200)
  assert.strictEqual(await res2.body.text(), 'ok')
  assert.strictEqual(connNum, 2)
})

test('TLSSocket ERR_SSL_* error on idle keep-alive socket destroys socket before reuse', { timeout: TEST_TIMEOUT }, async (t) => {
  let connNum = 0
  let firstRawSocket = null
  const client = await setupTlsClient(t, (rawSocket, tlsSocket) => {
    const current = ++connNum
    if (current === 1) {
      firstRawSocket = rawSocket
    }
    tlsSocket.once('data', () => {
      if (current === 1) {
        tlsSocket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok')
      } else {
        tlsSocket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nfresh')
      }
    })
  })

  const res1 = await client.request({ path: '/', method: 'GET' })
  assert.strictEqual(res1.statusCode, 200)
  assert.strictEqual(await res1.body.text(), 'ok')

  const disconnected = once(client, 'disconnect')
  firstRawSocket.write(CORRUPT_TLS_RECORD)
  const [, , disconnectErr] = await disconnected
  assert.match(disconnectErr.code, /^ERR_SSL_/)

  const res2 = await client.request({ path: '/', method: 'GET' })
  assert.strictEqual(res2.statusCode, 200)
  assert.strictEqual(await res2.body.text(), 'fresh')
  assert.strictEqual(connNum, 2)
})

test('TLSSocket ERR_SSL_* error during streaming request body rejects with TLS error and reconnects', { timeout: TEST_TIMEOUT }, async (t) => {
  let connNum = 0
  const client = await setupTlsClient(t, (rawSocket, tlsSocket) => {
    const current = ++connNum
    tlsSocket.once('data', () => {
      if (current === 1) {
        rawSocket.write(CORRUPT_TLS_RECORD)
      } else {
        tlsSocket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
      }
    })
  })

  const disconnected = once(client, 'disconnect')

  const body = new Readable({ read () {} })
  body.push('hello')
  const bodyError = once(body, 'error')

  await assert.rejects(
    client.request({ path: '/', method: 'POST', body }),
    (err) => {
      assert.match(err.code, /^ERR_SSL_/)
      return true
    }
  )

  const [streamErr] = await bodyError
  assert.match(streamErr.code, /^ERR_SSL_/)
  const [, , disconnectErr] = await disconnected
  assert.match(disconnectErr.code, /^ERR_SSL_/)

  const res2 = await client.request({ path: '/', method: 'GET' })
  assert.strictEqual(res2.statusCode, 200)
  assert.strictEqual(await res2.body.text(), 'ok')
  assert.strictEqual(connNum, 2)
})

test('TLSSocket ERR_SSL_* error with pipelining fails head request and retries remaining', { timeout: TEST_TIMEOUT }, async (t) => {
  let connNum = 0
  const client = await setupTlsClient(t, (rawSocket, tlsSocket) => {
    const current = ++connNum
    let received = ''
    tlsSocket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      if (current === 1) {
        // Wait until both pipelined requests are in flight before injecting the error.
        if (received.includes('GET /1 ') && received.includes('GET /2 ')) {
          rawSocket.write(CORRUPT_TLS_RECORD)
        }
      } else if (received.includes('GET /2 ')) {
        tlsSocket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
      }
    })
  }, {
    pipelining: 2
  })

  const [, res2] = await Promise.all([
    assert.rejects(
      client.request({ path: '/1', method: 'GET', blocking: false }),
      (err) => {
        assert.match(err.code, /^ERR_SSL_/)
        return true
      }
    ),
    client.request({ path: '/2', method: 'GET', blocking: false })
  ])

  assert.strictEqual(res2.statusCode, 200)
  assert.strictEqual(await res2.body.text(), 'ok')
  assert.strictEqual(connNum, 2)
})
