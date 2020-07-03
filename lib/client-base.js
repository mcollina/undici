'use strict'

const { URL } = require('url')
const net = require('net')
const tls = require('tls')
// TODO: This is not really allowed by Node but it works for now.
const { HTTPParser } = process.binding('http_parser') // eslint-disable-line
const EventEmitter = require('events')
const Request = require('./request')
const assert = require('assert')
const {
  SocketTimeoutError,
  InvalidArgumentError,
  RequestAbortedError,
  ClientDestroyedError,
  ClientClosedError,
  HeadersTimeoutError,
  SocketError,
  NotSupportedError
} = require('./errors')
const {
  kUrl,
  kWriting,
  kQueue,
  kServerName,
  kSocketTimeout,
  kRequestTimeout,
  kTLSOpts,
  kClosed,
  kDestroyed,
  kPendingIdx,
  kRunningIdx,
  kError,
  kOnDestroyed,
  kPipelining,
  kRetryDelay,
  kRetryTimeout,
  kMaxAbortedPayload,
  kSocket,
  kSocketPath,
  kEnqueue,
  kMaxHeadersSize,
  kHeadersTimeout
} = require('./symbols')

const CRLF = Buffer.from('\r\n', 'ascii')
const TE_CHUNKED = Buffer.from('transfer-encoding: chunked\r\n', 'ascii')
const TE_CHUNKED_EOF = Buffer.from('\r\n0\r\n\r\n', 'ascii')

function nop () {}

const nodeMajorVersion = parseInt(process.version.split('.')[0].slice(1))
const insecureHTTPParser = process.execArgv.includes('--insecure-http-parser')

class ClientBase extends EventEmitter {
  constructor (url, {
    maxAbortedPayload,
    maxHeaderSize,
    headersTimeout,
    socketTimeout,
    socketPath,
    requestTimeout,
    pipelining,
    tls
  } = {}) {
    super()

    if (typeof url === 'string') {
      url = new URL(url)
    }

    if (!url || typeof url !== 'object') {
      throw new InvalidArgumentError('invalid url')
    }

    if (url.port != null && url.port !== '' && !Number.isFinite(parseInt(url.port))) {
      throw new InvalidArgumentError('invalid port')
    }

    if (socketPath != null && typeof socketPath !== 'string') {
      throw new InvalidArgumentError('invalid socketPath')
    }

    if (url.hostname != null && typeof url.hostname !== 'string') {
      throw new InvalidArgumentError('invalid hostname')
    }

    if (!/https?/.test(url.protocol)) {
      throw new InvalidArgumentError('invalid protocol')
    }

    if (/\/.+/.test(url.pathname) || url.search || url.hash) {
      throw new InvalidArgumentError('invalid url')
    }

    if (maxAbortedPayload != null && !Number.isFinite(maxAbortedPayload)) {
      throw new InvalidArgumentError('invalid maxAbortedPayload')
    }

    if (maxHeaderSize != null && !Number.isFinite(maxHeaderSize)) {
      throw new InvalidArgumentError('invalid maxHeaderSize')
    }

    if (socketTimeout != null && !Number.isFinite(socketTimeout)) {
      throw new InvalidArgumentError('invalid socketTimeout')
    }

    if (requestTimeout != null && !Number.isFinite(requestTimeout)) {
      throw new InvalidArgumentError('invalid requestTimeout')
    }

    if (headersTimeout != null && !Number.isFinite(headersTimeout)) {
      throw new InvalidArgumentError('invalid headersTimeout')
    }

    this[kSocket] = null
    this[kPipelining] = pipelining || 1
    this[kMaxHeadersSize] = maxHeaderSize || 16384
    this[kHeadersTimeout] = headersTimeout == null ? 30e3 : headersTimeout
    this[kUrl] = url
    this[kSocketPath] = socketPath
    this[kSocketTimeout] = socketTimeout == null ? 30e3 : socketTimeout
    this[kRequestTimeout] = requestTimeout == null ? 30e3 : requestTimeout
    this[kClosed] = false
    this[kDestroyed] = false
    this[kServerName] = null
    this[kTLSOpts] = tls
    this[kRetryDelay] = 0
    this[kRetryTimeout] = null
    this[kOnDestroyed] = []
    this[kWriting] = false
    this[kMaxAbortedPayload] = maxAbortedPayload || 1048576

    // kQueue is built up of 3 sections separated by
    // the kRunningIdx and kPendingIdx indices.
    // |   complete   |   running   |   pending   |
    //                ^ kRunningIdx ^ kPendingIdx ^ kQueue.length
    // kRunningIdx points to the first running element.
    // kPendingIdx points to the first pending element.
    // This implements a fast queue with an amortized
    // time of O(1).

    this[kQueue] = []
    this[kRunningIdx] = 0
    this[kPendingIdx] = 0
  }

  get pipelining () {
    return this[kPipelining]
  }

  set pipelining (value) {
    this[kPipelining] = value
    resume(this)
  }

  get connected () {
    return (
      this[kSocket] &&
      this[kSocket].connecting !== true &&
      // Older versions of Node don't set secureConnecting to false.
      (this[kSocket].authorized !== false ||
       this[kSocket].authorizationError
      ) &&
      !this[kSocket].destroyed
    )
  }

  get pending () {
    return this[kQueue].length - this[kPendingIdx]
  }

  get running () {
    return this[kPendingIdx] - this[kRunningIdx]
  }

  get size () {
    return this[kQueue].length - this[kRunningIdx]
  }

  get busy () {
    if (this.size >= this[kPipelining]) {
      return true
    }

    for (let n = this[kRunningIdx]; n < this[kQueue].length; ++n) {
      const { idempotent, streaming } = this[kQueue][n]
      // TOOD: Add test for this.
      if (!idempotent || streaming) {
        return true
      }
    }

    return false
  }

  get destroyed () {
    return this[kDestroyed]
  }

  get closed () {
    return this[kClosed]
  }

  [kEnqueue] (opts, callback) {
    if (typeof callback !== 'function') {
      throw new InvalidArgumentError('invalid callback')
    }

    if (!opts || typeof opts !== 'object') {
      process.nextTick(callback, new InvalidArgumentError('invalid opts'), null)
      return
    }

    if (this[kDestroyed]) {
      process.nextTick(callback, new ClientDestroyedError(), null)
      return
    }

    if (this[kClosed]) {
      process.nextTick(callback, new ClientClosedError(), null)
      return
    }

    if (opts.requestTimeout == null && this[kRequestTimeout]) {
      // TODO: Avoid copy.
      opts = { ...opts, requestTimeout: this[kRequestTimeout] }
    }

    let request
    try {
      request = new Request(opts, this[kUrl].hostname, callback)
    } catch (err) {
      process.nextTick(callback, err, null)
      return
    }

    this[kQueue].push(request)

    resume(this)

    return request
  }

  close (callback) {
    if (callback === undefined) {
      return new Promise((resolve, reject) => {
        this.close((err, data) => {
          return err ? reject(err) : resolve(data)
        })
      })
    }

    if (typeof callback !== 'function') {
      throw new InvalidArgumentError('invalid callback')
    }

    if (this[kDestroyed]) {
      process.nextTick(callback, new ClientDestroyedError(), null)
      return
    }

    this[kClosed] = true
    this[kOnDestroyed].push(callback)

    resume(this)
  }

  destroy (err, callback) {
    if (typeof err === 'function') {
      callback = err
      err = null
    }

    if (callback === undefined) {
      return new Promise((resolve, reject) => {
        this.destroy(err, (err, data) => {
          return err ? /* istanbul ignore next: should never error */ reject(err) : resolve(data)
        })
      })
    }

    if (typeof callback !== 'function') {
      throw new InvalidArgumentError('invalid callback')
    }

    if (this[kDestroyed]) {
      if (this[kOnDestroyed]) {
        this[kOnDestroyed].push(callback)
      } else {
        process.nextTick(callback, null, null)
      }
      return
    }

    clearTimeout(this[kRetryTimeout])
    this[kRetryTimeout] = null
    this[kClosed] = true
    this[kDestroyed] = true
    this[kOnDestroyed].push(callback)

    const onDestroyed = () => {
      const callbacks = this[kOnDestroyed]
      this[kOnDestroyed] = null
      for (const callback of callbacks) {
        callback(null, null)
      }
    }

    if (!this[kSocket] || this[kSocket][kClosed]) {
      process.nextTick(onDestroyed)
    } else {
      // There is a delay between socket.destroy() and socket emitting 'close'.
      // This means that some progress progress is still possible in the time
      // between.
      this[kSocket]
        .on('close', onDestroyed)
        .destroy(err)
    }

    // resume will invoke callbacks and must happen in nextTick
    // TODO: Implement in a more elegant way.
    process.nextTick(resume, this)
  }
}

class Parser extends HTTPParser {
  constructor (client, socket) {
    /* istanbul ignore next */
    if (nodeMajorVersion >= 12) {
      super()
      this.initialize(
        HTTPParser.RESPONSE,
        {},
        client[kMaxHeadersSize],
        insecureHTTPParser,
        client[kHeadersTimeout]
      )
    } else {
      super(HTTPParser.RESPONSE, false)
    }

    this.client = client
    this.socket = socket
    this.resumeSocket = () => socket.resume()
    this.read = 0
    this.body = nop
  }

  [HTTPParser.kOnTimeout] () {
    this.socket.destroy(new HeadersTimeoutError())
  }

  /* istanbul ignore next: we don't support trailers yet */
  [HTTPParser.kOnHeaders] () {
    // TODO: Handle trailers.
  }

  [HTTPParser.kOnExecute] (ret) {
    if (ret instanceof Error) {
      const err = ret
      if (typeof err.reason === 'string') {
        err.message = `Parse Error: ${err.reason}`
      }
      this.socket.destroy(err)
    } else {
      // When underlying `net.Socket` instance is consumed - no
      // `data` events are emitted, and thus `socket.setTimeout` fires the
      // callback even if the data is constantly flowing into the socket.
      // See, https://github.com/nodejs/node/commit/ec2822adaad76b126b5cccdeaa1addf2376c9aa6
      // TOOD: Add test for this.
      this.socket._unrefTimer()
    }
  }

  [HTTPParser.kOnHeadersComplete] (versionMajor, versionMinor, headers, method,
    url, statusCode, statusMessage, upgrade, shouldKeepAlive) {
    const { client } = this
    const request = client[kQueue][client[kRunningIdx]]

    assert(!this.read)

    // TODO: What if !shouldKeepAlive?
    // TODO: What if upgrade?

    if (statusCode === 101) {
      // TODO: Switching Protocols.
      this.socket.destroy(new NotSupportedError('101 response not supported'))
      return true
    }

    if (statusCode < 200) {
      // TODO: Informational response.
      return true
    }

    this.body = request.invoke(null, statusCode, headers, this.resumeSocket) || nop

    return request.method === 'HEAD'
  }

  [HTTPParser.kOnBody] (chunk, offset, length) {
    this.read += length

    const ret = this.body !== nop
      ? this.body(null, chunk.slice(offset, offset + length))
      : null
    if (ret == null && this.read > this.client[kMaxAbortedPayload]) {
      this.socket.destroy()
    } else if (ret === false) {
      this.socket.pause()
    }
  }

  [HTTPParser.kOnMessageComplete] () {
    const { client } = this
    const request = client[kQueue][client[kRunningIdx]]

    this.read = 0
    this.body(null, null)
    this.body = nop

    this.socket.resume()

    if (!request.callback) {
      client[kQueue][client[kRunningIdx]++] = null
      resume(client)
    }
  }

  destroy (err) {
    const { client } = this

    assert(err)

    this.unconsume()

    // Make sure the parser's stack has unwound before deleting the
    // corresponding C++ object through .close().
    setImmediate(() => this.close())

    if (client[kRunningIdx] >= client[kPendingIdx]) {
      assert(!this.read)
      return
    }

    this.read = 0
    this.body(err, null)
    this.body = nop

    // Retry all idempotent requests except for the one
    // at the head of the pipeline.

    const retryRequests = []
    const errorRequests = []

    errorRequests.push(client[kQueue][client[kRunningIdx]++])

    for (const request of client[kQueue].slice(client[kRunningIdx], client[kPendingIdx])) {
      const { idempotent, streaming } = request
      assert(idempotent && !streaming)
      retryRequests.push(request)
    }

    client[kQueue].splice(0, client[kPendingIdx], ...retryRequests)

    client[kPendingIdx] = 0
    client[kRunningIdx] = 0

    for (const request of errorRequests) {
      request.invoke(err, null)
    }
  }
}

function connect (client) {
  assert(!client[kSocket])
  assert(!client[kRetryTimeout])

  const { protocol, port, hostname } = client[kUrl]
  const servername = client[kServerName] || (client[kTLSOpts] && client[kTLSOpts].servername)

  let socket
  if (protocol === 'https:') {
    const tlsOpts = { ...client[kTLSOpts], servername }
    socket = client[kSocketPath]
      ? tls.connect(client[kSocketPath], tlsOpts)
      : tls.connect(port || /* istanbul ignore next */ 443, hostname, tlsOpts)
  } else {
    socket = client[kSocketPath]
      ? net.connect(client[kSocketPath])
      : net.connect(port || /* istanbul ignore next */ 80, hostname)
  }

  client[kSocket] = socket

  const parser = new Parser(client, socket)

  /* istanbul ignore next */
  if (nodeMajorVersion >= 12) {
    assert(socket._handle)
    parser.consume(socket._handle)
  } else {
    assert(socket._handle && socket._handle._externalStream)
    parser.consume(socket._handle._externalStream)
  }

  socket[kClosed] = false
  socket[kError] = null
  socket.setTimeout(client[kSocketTimeout], function () {
    this.destroy(new SocketTimeoutError())
  })
  socket
    .setNoDelay(true)
    .on(protocol === 'https:' ? 'secureConnect' : 'connect', function () {
      client[kRetryDelay] = 0
      client.emit('connect')
      resume(client)
    })
    .on('data', function () {
      assert(false)
    })
    .on('error', function (err) {
      if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        assert(!client.running)
        while (client.pending && client[kQueue][client[kPendingIdx]].servername === servername) {
          client[kQueue][client[kPendingIdx]++].invoke(err, null)
        }
      } else if (
        !client.running &&
        err.code !== 'ECONNRESET' &&
        err.code !== 'ECONNREFUSED' &&
        err.code !== 'EHOSTUNREACH' &&
        err.code !== 'EHOSTDOWN' &&
        err.code !== 'UND_ERR_SOCKET'
      ) {
        assert(client[kPendingIdx] === client[kRunningIdx])
        // Error is not caused by running request and not a recoverable
        // socket error.
        for (const request of client[kQueue].splice(client[kRunningIdx])) {
          request.invoke(err, null)
        }
      }

      this[kError] = err
    })
    .on('end', function () {
      this.destroy(new SocketError('other side closed'))
    })
    .on('close', function () {
      socket[kClosed] = true

      if (!socket[kError]) {
        socket[kError] = new SocketError('closed')
      }

      parser.destroy(socket[kError])

      if (client.destroyed) {
        resume(client)
        return
      }

      client[kSocket] = null

      if (client.pending > 0) {
        if (client[kRetryDelay]) {
          client[kRetryTimeout] = setTimeout(() => {
            client[kRetryTimeout] = null
            connect(client)
          }, client[kRetryDelay])
          client[kRetryDelay] = Math.min(client[kRetryDelay] * 2, client[kSocketTimeout])
        } else {
          connect(client)
          client[kRetryDelay] = 1e3
        }
      }

      client.emit('disconnect', socket[kError])

      resume(client)
    })
}

function resume (client) {
  while (true) {
    if (client[kDestroyed]) {
      for (const request of client[kQueue].splice(client[kPendingIdx])) {
        request.invoke(new ClientDestroyedError(), null)
      }
      return
    }

    if (client.size === 0) {
      if (client[kClosed]) {
        client.destroy(nop)
      }
      if (client[kRunningIdx] > 0) {
        client[kQueue].length = 0
        client[kPendingIdx] = 0
        client[kRunningIdx] = 0
      }
      return
    }

    if (client[kRunningIdx] > 256) {
      client[kQueue].splice(0, client[kRunningIdx])
      client[kPendingIdx] -= client[kRunningIdx]
      client[kRunningIdx] = 0
    }

    if (client.running >= client.pipelining) {
      return
    }

    if (!client.pending) {
      return
    }

    const request = client[kQueue][client[kPendingIdx]]

    if (!request.callback) {
      // Request was aborted.
      // TODO: Avoid splice one by one.
      client[kQueue].splice(client[kPendingIdx], 1)
      continue
    }

    if (client[kServerName] !== request.servername) {
      if (client.running) {
        return
      }

      client[kServerName] = request.servername

      if (client[kSocket]) {
        // TODO: This will emit disconnect with an error, even
        // though the disconnect is expected.
        client[kSocket].destroy()
        return
      }
    }

    if (!client[kSocket] && !client[kRetryTimeout]) {
      connect(client)
      return
    }

    if (!client.connected) {
      return
    }

    if (client[kWriting]) {
      return
    }

    if (!request.idempotent && client.running) {
      // Non-idempotent request cannot be retried.
      // Ensure that no other requests are inflight and
      // could cause failure.
      return
    }

    if (request.streaming && client.running) {
      // Request with stream body can error while other requests
      // are inflight and indirectly error those as well.
      // Ensure this doesn't happen by waiting for inflight
      // to complete before dispatching.

      // TODO: This is to strict. Would be better if when
      // request body fails, the client waits for inflight
      // before resetting the connection.
      return
    }

    client[kPendingIdx]++

    write(client, request)

    // Release memory for no longer required properties.
    request.headers = null
    request.body = null
  }
}

function write (client, {
  header,
  body,
  streaming,
  chunked,
  signal
}) {
  const socket = client[kSocket]

  socket.cork()
  socket.write(header)

  if (!body) {
    socket.write(CRLF)
  } else if (!streaming) {
    socket.write(CRLF)
    socket.write(body)
    socket.write(CRLF)
  } else {
    socket.write(chunked ? TE_CHUNKED : CRLF)

    const onData = (chunk) => {
      if (chunked) {
        socket.write(`\r\n${Buffer.byteLength(chunk).toString(16)}\r\n`, 'ascii')
      }

      // TODO (fix): Improve test coverage.
      if (!socket.write(chunk) && body.pause) {
        body.pause()
      }
    }
    const onDrain = () => {
      // TODO (fix): Improve test coverage.
      if (body.resume) {
        body.resume()
      }
    }
    const onAbort = () => {
      onFinished(new RequestAbortedError())
    }

    let finished = false
    const onFinished = (err) => {
      if (finished) {
        return
      }
      finished = true

      err = err || socket[kError]

      if (signal) {
        signal.removeListener('error', onFinished)
      }

      socket
        .removeListener('drain', onDrain)
        .removeListener('error', onFinished)
        .removeListener('close', onFinished)
      body
        .removeListener('data', onData)
        .removeListener('end', onFinished)
        .removeListener('error', onFinished)
        .removeListener('close', onAbort)
        .on('error', nop)

      if (err) {
        if (typeof body.destroy === 'function' && !body.destroyed) {
          body.destroy(err)
        }

        // TODO (fix): Improve test coverage.
        if (!socket.destroyed) {
          assert(client.running)
          socket.destroy(err)
        }
      } else {
        socket.write(chunked ? TE_CHUNKED_EOF : CRLF)
      }

      client[kWriting] = false
      resume(client)
    }

    if (signal) {
      signal.on('error', onFinished)
    }

    body
      .on('data', onData)
      .on('end', onFinished)
      .on('error', onFinished)
      .on('close', onAbort)

    socket
      .on('drain', onDrain)
      .on('error', onFinished)
      .on('close', onFinished)

    client[kWriting] = true
  }

  socket.uncork()
}

module.exports = ClientBase
