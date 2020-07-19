'use strict'

const { URL } = require('url')
const net = require('net')
const tls = require('tls')
// TODO: This is not really allowed by Node but it works for now.
const { HTTPParser } = process.binding('http_parser') // eslint-disable-line
const EventEmitter = require('events')
const assert = require('assert')
const util = require('./util')
const {
  ContentLengthMismatchError,
  SocketTimeoutError,
  InvalidArgumentError,
  RequestAbortedError,
  ClientDestroyedError,
  HeadersTimeoutError,
  SocketError,
  InformationalError,
  NotSupportedError
} = require('./errors')
const {
  kUrl,
  kReset,
  kResume,
  kConnect,
  kResuming,
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
    this[kReset] = false
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
    this[kResuming] = false
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
    if (this.running >= this[kPipelining]) {
      return true
    }

    if (this.size >= this[kPipelining]) {
      return true
    }

    if (this[kReset] || this[kWriting]) {
      return true
    }

    if (this[kResuming]) {
      for (let n = this[kPendingIdx]; n < this[kQueue].length; n++) {
        const { idempotent, body } = this[kQueue][n]
        if (!idempotent) {
          return true
        }
        if (util.isStream(body) && util.bodyLength(body) !== 0) {
          return true
        }
      }
    } else if (this.pending > 0) {
      return true
    }

    return false
  }

  get destroyed () {
    return this[kDestroyed]
  }

  get closed () {
    return this[kClosed]
  }

  [kResume] () {
    resume(this)
  }

  [kConnect] (cb) {
    connect(this)
    if (cb) {
      if (this.connected) {
        process.nextTick(cb)
      } else {
        this.once('connect', cb)
      }
    }
  }

  [kEnqueue] (request) {
    this[kQueue].push(request)
    if (this[kResuming]) {
      // Do nothing.
    } else if (util.isStream(request.body)) {
      this[kResuming] = true
      process.nextTick(resume, this)
    } else {
      resume(this)
    }
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

    if (this.size === 0) {
      this.destroy(callback)
    } else {
      this[kOnDestroyed].push(callback)
    }
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

    if (!this[kSocket]) {
      process.nextTick(onDestroyed)
    } else {
      // There is a delay between socket.destroy() and socket emitting 'close'.
      // This means that some progress progress is still possible in the time
      // between.
      util.destroy(this[kSocket], err).on('close', onDestroyed)
    }

    resume(this)
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

    this.statusCode = null
    this.headers = null
    this.read = 0
  }

  [HTTPParser.kOnTimeout] () {
    util.destroy(this.socket, new HeadersTimeoutError())
  }

  [HTTPParser.kOnHeaders] (rawHeaders) {
    this.headers = util.parseHeaders(rawHeaders, this.headers)
  }

  [HTTPParser.kOnExecute] (ret) {
    if (ret instanceof Error) {
      const err = ret
      if (typeof err.reason === 'string') {
        err.message = `Parse Error: ${err.reason}`
      }
      util.destroy(this.socket, err)
    } else {
      // When the underlying `net.Socket` instance is consumed - no
      // `data` events are emitted, and thus `socket.setTimeout` fires the
      // callback even if the data is constantly flowing into the socket.
      // See, https://github.com/nodejs/node/commit/ec2822adaad76b126b5cccdeaa1addf2376c9aa6
      this.socket._unrefTimer()
    }
  }

  [HTTPParser.kOnHeadersComplete] (versionMajor, versionMinor, rawHeaders, method,
    url, statusCode, statusMessage, upgrade, shouldKeepAlive) {
    const { client, socket, resumeSocket, headers } = this

    if (socket.destroyed) {
      return true
    }

    const request = client[kQueue][client[kRunningIdx]]

    // TODO: What if !shouldKeepAlive?
    // TODO: What if upgrade?
    // TODO: What if request.method === 'CONNECT'?
    // TODO: Check for content-length mismatch?

    assert(this.statusCode < 200)

    this.headers = null
    this.statusCode = statusCode

    if (statusCode === 101) {
      // TODO: Switching Protocols.
      util.destroy(socket, new NotSupportedError('101 response is not supported'))
      return true
    }

    request.runInAsyncScope(
      request.onHeaders,
      request,
      statusCode,
      util.parseHeaders(rawHeaders, headers),
      resumeSocket
    )

    return request.method === 'HEAD' || statusCode < 200
  }

  [HTTPParser.kOnBody] (chunk, offset, length) {
    const { client, socket, statusCode } = this

    assert(statusCode >= 200)

    if (socket.destroyed) {
      return
    }

    const request = client[kQueue][client[kRunningIdx]]

    this.read += length

    const ret = request.runInAsyncScope(
      request.onBody,
      request,
      chunk,
      offset,
      length
    )
    if (ret == null && this.read > client[kMaxAbortedPayload]) {
      util.destroy(socket, new InformationalError('max aborted payload'))
    } else if (ret === false) {
      socket.pause()
    }
  }

  [HTTPParser.kOnMessageComplete] () {
    const { client, socket, statusCode, headers } = this

    const request = client[kQueue][client[kRunningIdx]]

    assert(statusCode >= 100)

    if (socket.destroyed && statusCode < 200) {
      return
    }

    this.statusCode = null
    this.headers = null

    request.runInAsyncScope(
      request.onComplete,
      request,
      headers
    )

    if (statusCode >= 200) {
      this.read = 0
      client[kQueue][client[kRunningIdx]++] = null
      if (client[kReset]) {
        // https://tools.ietf.org/html/rfc7231#section-4.3.1
        // https://tools.ietf.org/html/rfc7231#section-4.3.2
        // https://tools.ietf.org/html/rfc7231#section-4.3.5

        // Sending a payload body on a request that does not
        // expect it can cause undefined behavior on some
        // servers and corrupt connection state. Do not
        // re-use the connection for further requests.

        util.destroy(socket, new InformationalError('request reset'))
      } else {
        resume(client)
      }
    }

    socket.resume()
  }

  destroy (err) {
    const { client } = this

    assert(err)

    this.unconsume()

    // Make sure the parser's stack has unwound before deleting the
    // corresponding C++ object through .close().
    setImmediate(() => this.close())

    if (client[kRunningIdx] >= client[kPendingIdx]) {
      return
    }

    // Retry all idempotent requests except for the one
    // at the head of the pipeline.

    {
      const request = client[kQueue][client[kRunningIdx]++]
      request.runInAsyncScope(request.onError, request, err)
    }

    const retryRequests = []
    for (const request of client[kQueue].slice(client[kRunningIdx], client[kPendingIdx])) {
      const { idempotent, body } = request
      assert(idempotent && !util.isStream(body))
      retryRequests.push(request)
    }

    client[kQueue].splice(0, client[kPendingIdx], ...retryRequests)
    client[kPendingIdx] = 0
    client[kRunningIdx] = 0
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

  socket[kError] = null
  socket.setTimeout(client[kSocketTimeout], function () {
    util.destroy(this, new SocketTimeoutError())
  })
  socket
    .setNoDelay(true)
    .on(protocol === 'https:' ? 'secureConnect' : 'connect', function () {
      client[kReset] = false
      client[kRetryDelay] = 0
      client.emit('connect')
      resume(client)
    })
    .on('data', function () {
      /* istanbul ignore next */
      assert(false)
    })
    .on('error', function (err) {
      this[kError] = err

      if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        assert(!client.running)
        while (client.pending && client[kQueue][client[kPendingIdx]].servername === servername) {
          const request = client[kQueue][client[kPendingIdx]++]
          request.runInAsyncScope(request.onError, request, err)
        }
      } else if (
        !client.running &&
        err.code !== 'ECONNRESET' &&
        err.code !== 'ECONNREFUSED' &&
        err.code !== 'EHOSTUNREACH' &&
        err.code !== 'EHOSTDOWN' &&
        err.code !== 'UND_ERR_SOCKET' &&
        err.code !== 'UND_ERR_INFO'
      ) {
        assert(client[kPendingIdx] === client[kRunningIdx])
        // Error is not caused by running request and not a recoverable
        // socket error.
        for (const request of client[kQueue].splice(client[kRunningIdx])) {
          request.runInAsyncScope(request.onError, request, err)
        }
      }
    })
    .on('end', function () {
      util.destroy(this, new SocketError('other side closed'))
    })
    .on('close', function () {
      if (!this[kError]) {
        this[kError] = new SocketError('closed')
      }

      client[kSocket] = null

      parser.destroy(this[kError])

      if (client.destroyed) {
        resume(client)
        return
      }

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

      client.emit('disconnect', this[kError])

      resume(client)
    })
}

function resume (client) {
  client[kResuming] = false
  while (true) {
    if (client[kDestroyed]) {
      const err = new ClientDestroyedError()
      for (const request of client[kQueue].splice(client[kPendingIdx])) {
        request.runInAsyncScope(request.onError, request, err)
      }
      return
    }

    if (client.size === 0) {
      if (client[kClosed]) {
        client.destroy(util.nop)
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
    if (request.aborted) {
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
        util.destroy(client[kSocket], new InformationalError('servername changed'))
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

    if (client[kReset]) {
      return
    }

    if (client[kWriting]) {
      return
    }

    if (client.running && !request.idempotent) {
      // Non-idempotent request cannot be retried.
      // Ensure that no other requests are inflight and
      // could cause failure.
      return
    }

    if (util.isStream(request.body) && util.bodyLength(request.body) === 0) {
      request.body
        .on('data', () => {
          assert(false)
        })
        .on('error', (err) => {
          request.runInAsyncScope(request.onError, request, err)
        })
        .on('end', () => {
          util.destroy(this)
        })
      request.body = null
    }

    if (client.running && util.isStream(request.body)) {
      // Request with stream body can error while other requests
      // are inflight and indirectly error those as well.
      // Ensure this doesn't happen by waiting for inflight
      // to complete before dispatching.

      // Request with stream body cannot be retried.
      // Ensure that no other requests are inflight and
      // could cause failure.
      return
    }

    try {
      write(client, request)
      client[kPendingIdx]++
    } catch (err) {
      request.runInAsyncScope(request.onError, request, err)
    }
  }
}

function write (client, request) {
  const { method } = request

  if (method === 'CONNECT') {
    throw new NotSupportedError('CONNECT method is not supported')
  }

  let contentLength = util.bodyLength(request.body, true)

  if (contentLength === undefined) {
    contentLength = request.contentLength
  }

  // TODO: What other methods expect a payload?
  const expectsPayload = (
    method === 'PUT' ||
    method === 'POST' ||
    method === 'PATCH'
  )

  if (contentLength === 0 && !expectsPayload) {
    // https://tools.ietf.org/html/rfc7230#section-3.3.2
    // A user agent SHOULD NOT send a Content-Length header field when
    // the request message does not contain a payload body and the method
    // semantics do not anticipate such a body.

    contentLength = undefined
  }

  if (request.contentLength !== undefined && request.contentLength !== contentLength) {
    throw new ContentLengthMismatchError()
  }

  const { body, header, hostname } = request
  const socket = client[kSocket]

  socket.cork()
  socket.write(header)

  if (contentLength !== undefined) {
    socket.write(`content-length: ${contentLength}\r\n`, 'ascii')
  }

  if (!hostname) {
    socket.write(`host: ${client[kUrl].hostname}\r\n`, 'ascii')
  }

  // TODO: An HTTP/1.1 user agent MUST NOT preface
  // or follow a request with an extra CRLF.
  // https://tools.ietf.org/html/rfc7230#section-3.5

  if (!body) {
    socket.write(CRLF)
    if (contentLength === 0) {
      socket.write(CRLF)
    } else {
      assert(contentLength === undefined, 'no body must not have content length')
    }
  } else if (body instanceof Uint8Array) {
    assert(contentLength !== undefined, 'buffer body must have content length')

    socket.write(CRLF)
    client[kReset] = !expectsPayload

    socket.write(body)
    socket.write(CRLF)
  } else if (util.isStream(body)) {
    assert(contentLength !== 0 || !client.running, 'stream body cannot be pipelined')

    let finished = false
    let bytesWritten = 0

    const chunked = contentLength === undefined

    const onData = function (chunk) {
      assert(!finished)

      const len = Buffer.byteLength(chunk)
      if (!len) {
        return
      }

      // TODO: What if not ended and bytesWritten === contentLength?
      // We should defer writing chunks.
      if (contentLength !== undefined && bytesWritten + len > contentLength) {
        util.destroy(this, new ContentLengthMismatchError())
        return
      }

      if (bytesWritten === 0) {
        socket.write(chunked ? 'transfer-encoding: chunked\r\n' : '\r\n', 'ascii')
        client[kReset] = !expectsPayload
      }

      if (chunked) {
        socket.write(`\r\n${len.toString(16)}\r\n`, 'ascii')
      }

      bytesWritten += len

      if (!socket.write(chunk) && this.pause) {
        this.pause()
      }
    }
    const onDrain = function () {
      assert(!finished)

      if (body.resume) {
        body.resume()
      }
    }
    const onAbort = function () {
      onFinished(new RequestAbortedError())
    }
    const onFinished = function (err) {
      if (finished) {
        return
      }

      finished = true

      assert(client[kWriting])
      client[kWriting] = false

      if (!err) {
        err = socket[kError]
      }

      if (!err && contentLength !== undefined && bytesWritten !== contentLength) {
        err = new ContentLengthMismatchError()
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

      util.destroy(body, err)

      if (err) {
        util.destroy(socket, err)
        return
      }

      if (bytesWritten === 0) {
        if (contentLength === undefined && expectsPayload) {
          // https://tools.ietf.org/html/rfc7230#section-3.3.2
          // A user agent SHOULD send a Content-Length in a request message when
          // no Transfer-Encoding is sent and the request method defines a meaning
          // for an enclosed payload body.

          socket.write('content-length: 0\r\n\r\n', 'ascii')
        }
      } else if (chunked) {
        socket.write('\r\n0\r\n', 'ascii')
      }

      socket.write(CRLF)
      resume(client)
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
  } else {
    /* istanbul ignore next */
    assert(false)
  }

  socket.uncork()
}

module.exports = ClientBase
