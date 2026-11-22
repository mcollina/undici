'use strict'

const { test } = require('node:test')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { WebSocket } = require('../..')
const { tspl } = require('@matteo.collina/tspl')

test('first error than close event is fired on failed connection', async (t) => {
  const { strictEqual, completed } = tspl(t, { plan: 6 })
  const ws = new WebSocket('ws://localhost:1')

  let orderOfEvents = 0

  ws.addEventListener('error', () => {
    strictEqual(orderOfEvents++, 0)
    strictEqual(ws.readyState, WebSocket.CLOSED)
  })

  ws.addEventListener('close', (event) => {
    strictEqual(orderOfEvents++, 1)
    strictEqual(ws.readyState, WebSocket.CLOSED)
    strictEqual(event.code, 1006)
    strictEqual(event.wasClean, false)
  })

  await completed
})

test('close event is fired once when the opening handshake is invalid', async (t) => {
  const { strictEqual, completed } = tspl(t, { plan: 3 })

  const server = createServer()
  server.on('upgrade', (req, socket) => {
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: invalid\r\n\r\n'
    )
  })
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())

  const ws = new WebSocket(`ws://localhost:${server.address().port}`)

  let closeEvents = 0

  ws.addEventListener('close', (event) => {
    closeEvents++
    strictEqual(event.code, 1006)
    strictEqual(ws.readyState, WebSocket.CLOSED)
  })

  await once(ws, 'close')
  // A second close event, if any, would be fired on the socket's close.
  await new Promise((resolve) => setTimeout(resolve, 100))
  strictEqual(closeEvents, 1)

  await completed
})

test('close() while connecting fires error and close once', async (t) => {
  const { strictEqual, completed } = tspl(t, { plan: 1 })

  // Accepts the upgrade request but never answers it.
  const server = createServer()
  server.on('upgrade', () => {})
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())

  const ws = new WebSocket(`ws://localhost:${server.address().port}`)

  const events = []
  ws.addEventListener('error', () => events.push('error'))
  ws.addEventListener('close', () => events.push('close'))

  ws.close()

  await new Promise((resolve) => setTimeout(resolve, 100))
  strictEqual(events.join(), 'error,close')

  await completed
})
