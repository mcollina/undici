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
  kParser,
  kSocket,
  kEnqueue,
  kClient,
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
      if (!this[kQueue].idempotent || this[kQueue].streaming) {
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
    this.body = null
  }

  [HTTPParser.kOnTimeout] () {
    const { socket } = this

    socket.destroy(new HeadersTimeoutError())
  }

  /* istanbul ignore next: we don't support trailers yet */
  [HTTPParser.kOnHeaders] () {
    // TODO: Handle trailers.
  }

  [HTTPParser.kOnExecute] (ret) {
    const { socket } = this

    if (ret instanceof Error && !socket.destroyed) {
      const err = ret
      if (typeof err.reason === 'string') {
        err.message = `Parse Error: ${err.reason}`
      }
      socket.destroy(err)
    }
  }

  [HTTPParser.kOnHeadersComplete] (versionMajor, versionMinor, headers, method,
    url, statusCode, statusMessage, upgrade, shouldKeepAlive) {
    const { client, resumeSocket } = this
    const request = client[kQueue][client[kRunningIdx]]
    const { signal, opaque } = request
    const skipBody = request.method === 'HEAD'

    assert(!this.read)
    assert(!this.body)

    if (statusCode === 101) {
      request.invoke(new NotSupportedError('101 response not supported'))
      return true
    }

    if (statusCode < 200) {
      // TODO: Informational response.
      return true
    }

    let body = request.invoke(null, {
      statusCode,
      headers: parseHeaders(headers),
      opaque,
      resume: resumeSocket
    })

    if (body && skipBody) {
      body(null, null)
      body = null
    }

    if (body) {
      this.body = body

      if (signal) {
        signal.once('error', body)
      }
    } else {
      this.next()
    }

    return skipBody
  }

  [HTTPParser.kOnBody] (chunk, offset, length) {
    this.read += length

    const { client, socket, body, read } = this

    const ret = body
      ? body(null, chunk.slice(offset, offset + length))
      : null

    if (ret == null && read > client[kMaxAbortedPayload]) {
      socket.destroy()
    } else if (ret === false) {
      socket.pause()
    }
  }

  [HTTPParser.kOnMessageComplete] () {
    const { body } = this

    this.read = 0
    this.body = null

    if (body) {
      body(null, null)
      this.next()
    }
  }

  next () {
    const { client, resumeSocket } = this

    resumeSocket()

    client[kQueue][client[kRunningIdx]++] = null

    resume(client)
  }

  destroy (err) {
    const { client, body } = this

    assert(err)

    this.unconsume()

    // Make sure the parser's stack has unwound before deleting the
    // corresponding C++ object through .close().
    setImmediate(() => this.close())

    if (client[kRunningIdx] >= client[kPendingIdx]) {
      assert(!body)
      return
    }

    this.read = 0
    this.body = null

    // Retry all idempotent requests except for the one
    // at the head of the pipeline.

    const retryRequests = []
    const errorRequests = []

    errorRequests.push(client[kQueue][client[kRunningIdx]++])

    for (const request of client[kQueue].slice(client[kRunningIdx], client[kPendingIdx])) {
      const { idempotent, streaming } = request
      /* istanbul ignore else: can't happen because of guard in resume */
      /* istanbul ignore next: can't happen because of guard in resume */
      if (idempotent && !streaming) {
        retryRequests.push(request)
      } else {
        errorRequests.push(request)
      }
    }

    client[kQueue].splice(0, client[kPendingIdx], ...retryRequests)

    client[kPendingIdx] = 0
    client[kRunningIdx] = 0

    if (body) {
      body(err, null)
    }

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
  const socket = protocol === 'https:'
    ? tls.connect(port || /* istanbul ignore next */ 443, hostname, {
      ...client[kTLSOpts],
      servername
    })
    : net.connect(port || /* istanbul ignore next */ 80, hostname)

  client[kSocket] = socket

  const parser = new Parser(client, socket)

  if (nodeMajorVersion >= 12) {
    assert(socket._handle)
    parser.consume(socket._handle)
  } else {
    assert(socket._handle && socket._handle._externalStream)
    parser.consume(socket._handle._externalStream)
  }

  socket[kClient] = client
  socket[kParser] = parser
  socket[kClosed] = false
  socket[kError] = null
  socket.setTimeout(client[kSocketTimeout], function () {
    this.destroy(new SocketTimeoutError())
  })
  socket
    .setNoDelay(true)
    .on(protocol === 'https:' ? 'secureConnect' : 'connect', function () {
      const client = this[kClient]

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
        // Error is not caused by running request and not a recoverable
        // socket error.
        for (const request of client[kQueue].splice(client[kPendingIdx])) {
          request.invoke(err, null)
        }
      }

      this[kError] = err
    })
    .on('end', function () {
      this.destroy(new SocketError('other side closed'))
    })
    .on('close', function () {
      const client = this[kClient]
      const parser = this[kParser]

      this[kClient] = null
      this[kParser] = null
      this[kClosed] = true

      if (!socket[kError]) {
        socket[kError] = new SocketError('closed')
      }

      const err = socket[kError]

      parser.destroy(err)

      resume(client)

      if (client.destroyed) {
        return
      }

      // reset events
      client[kSocket]
        .removeAllListeners('data')
        .removeAllListeners('end')
        .removeAllListeners('finish')
        .removeAllListeners('error')
      client[kSocket]
        .on('error', nop)
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

      client.emit('disconnect', err)
    })
}

function resume (client) {
  while (true) {
    if (client[kDestroyed]) {
      const requests = client[kQueue].splice(client[kPendingIdx])
      for (const request of requests) {
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
        client[kSocket].destroy()
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
    socket.uncork()
  } else if (!streaming) {
    socket.write(CRLF)
    socket.write(body)
    socket.write(CRLF)
    socket.uncork()
  } else {
    if (chunked) {
      socket.write(TE_CHUNKED)
    } else {
      socket.write(CRLF)
    }

    const onData = (chunk) => {
      if (chunked) {
        socket.write(`\r\n${Buffer.byteLength(chunk).toString(16)}\r\n`, 'ascii')
      }
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
        if (chunked) {
          socket.write(TE_CHUNKED_EOF)
        } else {
          socket.write(CRLF)
        }
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
      .uncork()

    client[kWriting] = true
  }
}

function parseHeaders (headers) {
  const obj = {}
  for (var i = 0; i < headers.length; i += 2) {
    var key = headers[i].toLowerCase()
    var val = obj[key]
    if (!val) {
      obj[key] = headers[i + 1]
    } else {
      if (!Array.isArray(val)) {
        val = [val]
        obj[key] = val
      }
      val.push(headers[i + 1])
    }
  }
  return obj
}

module.exports = ClientBase
