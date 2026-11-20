'use strict'

const assert = require('node:assert')
const diagnosticsChannel = require('node:diagnostics_channel')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')

const { Agent, Pool, fetch } = require('..')

// https://github.com/nodejs/undici/issues/5845
test('aborting a streaming response does not reconnect for the aborted request', async (t) => {
  const sockets = new Set()
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: ping\ndata: {}\n\n')
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  let pool
  const dispatcher = new Agent({
    keepAliveTimeout: 1000,
    factory (origin, options) {
      pool = new Pool(origin, options)
      return pool
    }
  })

  const port = String(server.address().port)
  const beforeConnect = diagnosticsChannel.channel('undici:client:beforeConnect')
  let connections = 0
  const onBeforeConnect = ({ connectParams }) => {
    if (connectParams.hostname === '127.0.0.1' && connectParams.port === port) {
      connections++
    }
  }
  beforeConnect.subscribe(onBeforeConnect)

  t.after(async () => {
    beforeConnect.unsubscribe(onBeforeConnect)
    await dispatcher.close()
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  })

  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
    dispatcher
  })
  const reader = response.body.getReader()
  await reader.read()

  const disconnected = once(pool, 'disconnect')
  controller.abort()
  await disconnected

  assert.strictEqual(connections, 1)
})
