'use strict'

/* global WebAssembly */

const assert = require('assert')
const net = require('net')
const util = require('./core/util')
const Request = require('./core/request')
const Dispatcher = require('./dispatcher')
const RedirectHandler = require('./handler/redirect')
const {
  RequestContentLengthMismatchError,
  ResponseContentLengthMismatchError,
  TrailerMismatchError,
  InvalidArgumentError,
  RequestAbortedError,
  HeadersTimeoutError,
  HeadersOverflowError,
  ClientDestroyedError,
  ClientClosedError,
  SocketError,
  InformationalError,
  BodyTimeoutError,
  HTTPParserError
} = require('./core/errors')
const makeConnect = require('./core/connect')

const {
  kUrl,
  kReset,
  kServerName,
  kClient,
  kBusy,
  kParser,
  kConnect,
  kResuming,
  kRunning,
  kPending,
  kSize,
  kWriting,
  kQueue,
  kConnected,
  kConnecting,
  kNeedDrain,
  kNoRef,
  kKeepAliveDefaultTimeout,
  kHostHeader,
  kClosed,
  kDestroyed,
  kPendingIdx,
  kRunningIdx,
  kError,
  kOnDestroyed,
  kPipelining,
  kSocket,
  kKeepAliveTimeoutValue,
  kMaxHeadersSize,
  kKeepAliveMaxTimeout,
  kKeepAliveTimeoutThreshold,
  kHeadersTimeout,
  kBodyTimeout,
  kStrictContentLength,
  kConnector,
  kMaxRedirections
} = require('./core/symbols')

class Client extends Dispatcher {
  constructor (url, {
    maxHeaderSize,
    headersTimeout,
    socketTimeout,
    requestTimeout,
    connectTimeout,
    bodyTimeout,
    idleTimeout,
    keepAlive,
    keepAliveTimeout,
    maxKeepAliveTimeout,
    keepAliveMaxTimeout,
    keepAliveTimeoutThreshold,
    socketPath,
    pipelining,
    tls,
    strictContentLength,
    maxCachedSessions,
    maxRedirections,
    connect
  } = {}) {
    super()

    if (keepAlive !== undefined) {
      throw new InvalidArgumentError('unsupported keepAlive, use pipelining=0 instead')
    }

    if (socketTimeout !== undefined) {
      throw new InvalidArgumentError('unsupported socketTimeout, use headersTimeout & bodyTimeout instead')
    }

    if (requestTimeout !== undefined) {
      throw new InvalidArgumentError('unsupported requestTimeout, use headersTimeout & bodyTimeout instead')
    }

    if (idleTimeout !== undefined) {
      throw new InvalidArgumentError('unsupported idleTimeout, use keepAliveTimeout instead')
    }

    if (maxKeepAliveTimeout !== undefined) {
      throw new InvalidArgumentError('unsupported maxKeepAliveTimeout, use keepAliveMaxTimeout instead')
    }

    if (maxHeaderSize != null && !Number.isFinite(maxHeaderSize)) {
      throw new InvalidArgumentError('invalid maxHeaderSize')
    }

    if (socketPath != null && typeof socketPath !== 'string') {
      throw new InvalidArgumentError('invalid socketPath')
    }

    if (connectTimeout != null && (!Number.isFinite(connectTimeout) || connectTimeout < 0)) {
      throw new InvalidArgumentError('invalid connectTimeout')
    }

    if (keepAliveTimeout != null && (!Number.isFinite(keepAliveTimeout) || keepAliveTimeout <= 0)) {
      throw new InvalidArgumentError('invalid keepAliveTimeout')
    }

    if (keepAliveMaxTimeout != null && (!Number.isFinite(keepAliveMaxTimeout) || keepAliveMaxTimeout <= 0)) {
      throw new InvalidArgumentError('invalid keepAliveMaxTimeout')
    }

    if (keepAliveTimeoutThreshold != null && !Number.isFinite(keepAliveTimeoutThreshold)) {
      throw new InvalidArgumentError('invalid keepAliveTimeoutThreshold')
    }

    if (headersTimeout != null && (!Number.isInteger(headersTimeout) || headersTimeout < 0)) {
      throw new InvalidArgumentError('headersTimeout must be a positive integer or zero')
    }

    if (bodyTimeout != null && (!Number.isInteger(bodyTimeout) || bodyTimeout < 0)) {
      throw new InvalidArgumentError('bodyTimeout must be a positive integer or zero')
    }

    if (connect != null && typeof connect !== 'function' && typeof connect !== 'object') {
      throw new InvalidArgumentError('connect must be a function or an object')
    }

    if (maxRedirections != null && (!Number.isInteger(maxRedirections) || maxRedirections < 0)) {
      throw new InvalidArgumentError('maxRedirections must be a positive number')
    }

    if (typeof connect !== 'function') {
      connect = makeConnect({
        ...tls,
        maxCachedSessions,
        socketPath,
        timeout: connectTimeout,
        ...connect
      })
    }

    this[kUrl] = util.parseOrigin(url)
    this[kConnector] = connect
    this[kSocket] = null
    this[kPipelining] = pipelining != null ? pipelining : 1
    this[kMaxHeadersSize] = maxHeaderSize || 16384
    this[kKeepAliveDefaultTimeout] = keepAliveTimeout == null ? 4e3 : keepAliveTimeout
    this[kKeepAliveMaxTimeout] = keepAliveMaxTimeout == null ? 600e3 : keepAliveMaxTimeout
    this[kKeepAliveTimeoutThreshold] = keepAliveTimeoutThreshold == null ? 1e3 : keepAliveTimeoutThreshold
    this[kKeepAliveTimeoutValue] = this[kKeepAliveDefaultTimeout]
    this[kClosed] = false
    this[kDestroyed] = false
    this[kServerName] = null
    this[kOnDestroyed] = []
    this[kResuming] = 0 // 0, idle, 1, scheduled, 2 resuming
    this[kNeedDrain] = 0 // 0, idle, 1, scheduled, 2 resuming
    this[kHostHeader] = `host: ${this[kUrl].hostname}${this[kUrl].port ? `:${this[kUrl].port}` : ''}\r\n`
    this[kBodyTimeout] = bodyTimeout != null ? bodyTimeout : 30e3
    this[kHeadersTimeout] = headersTimeout != null ? headersTimeout : 30e3
    this[kStrictContentLength] = strictContentLength == null ? true : strictContentLength
    this[kMaxRedirections] = maxRedirections

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

  // TODO: Make private?
  get pipelining () {
    return this[kPipelining]
  }

  // TODO: Make private?
  set pipelining (value) {
    this[kPipelining] = value
    resume(this, true)
  }

  get destroyed () {
    return this[kDestroyed]
  }

  get closed () {
    return this[kClosed]
  }

  get [kPending] () {
    return this[kQueue].length - this[kPendingIdx]
  }

  get [kRunning] () {
    return this[kPendingIdx] - this[kRunningIdx]
  }

  get [kSize] () {
    return this[kQueue].length - this[kRunningIdx]
  }

  get [kConnected] () {
    return !!this[kSocket] && !this[kConnecting] && !this[kSocket].destroyed
  }

  get [kBusy] () {
    const socket = this[kSocket]
    return (
      (socket && (socket[kReset] || socket[kWriting])) ||
      (this[kSize] >= (this[kPipelining] || 1)) ||
      this[kPending] > 0
    )
  }

  /* istanbul ignore: only used for test */
  [kConnect] (cb) {
    connect(this)
    this.once('connect', cb)
  }

  dispatch (opts, handler) {
    if (!handler || typeof handler !== 'object') {
      throw new InvalidArgumentError('handler')
    }

    try {
      if (!opts || typeof opts !== 'object') {
        throw new InvalidArgumentError('opts must be a object.')
      }

      if (this[kDestroyed]) {
        throw new ClientDestroyedError()
      }

      if (this[kClosed]) {
        throw new ClientClosedError()
      }

      const { maxRedirections = this[kMaxRedirections] } = opts
      if (maxRedirections != null) {
        handler = new RedirectHandler(this, maxRedirections, opts, handler)
      }

      const request = new Request(opts, handler)

      this[kQueue].push(request)
      if (this[kResuming]) {
        // Do nothing.
      } else if (util.isStream(request.body) || util.isStrictIterable(request.body)) {
        // Wait a tick in case stream/iterator is ended in the same tick.
        this[kResuming] = 1
        process.nextTick(resume, this)
      } else {
        resume(this, true)
      }

      if (this[kResuming] && this[kNeedDrain] !== 2 && this[kBusy]) {
        this[kNeedDrain] = 2
      }
    } catch (err) {
      if (typeof handler.onError !== 'function') {
        throw new InvalidArgumentError('invalid onError method')
      }

      handler.onError(err)
    }

    return this[kNeedDrain] < 2
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
      queueMicrotask(() => callback(new ClientDestroyedError(), null))
      return
    }

    this[kClosed] = true

    if (!this[kSize]) {
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
        queueMicrotask(() => callback(null, null))
      }
      return
    }

    if (!err) {
      err = new ClientDestroyedError()
    }

    const requests = this[kQueue].splice(this[kPendingIdx])
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i]
      errorRequest(this, request, err)
    }

    this[kClosed] = true
    this[kDestroyed] = true
    this[kOnDestroyed].push(callback)

    const onDestroyed = () => {
      const callbacks = this[kOnDestroyed]
      this[kOnDestroyed] = null
      for (let i = 0; i < callbacks.length; i++) {
        callbacks[i](null, null)
      }
    }

    if (!this[kSocket]) {
      queueMicrotask(onDestroyed)
    } else {
      util.destroy(this[kSocket].on('close', onDestroyed), err)
    }

    resume(this)
  }
}

const { resolve } = require('path')
const { readFileSync } = require('fs')
const constants = require('./llhttp/constants')
const EMPTY_BUF = Buffer.alloc(0)

let mod
try {
  mod = new WebAssembly.Module(readFileSync(resolve(__dirname, './llhttp/llhttp_simd.wasm')))
} catch (e) {
  /* istanbul ignore next */

  // We could check if the error was caused by the simd option not
  // being enabled, but the occurring of this other error
  // * https://github.com/emscripten-core/emscripten/issues/11495
  // got me to remove that check to avoid breaking Node 12.
  mod = new WebAssembly.Module(readFileSync(resolve(__dirname, './llhttp/llhttp.wasm')))
}

const llhttp = new WebAssembly.Instance(mod, {
  env: {
    /* eslint-disable camelcase */

    wasm_on_url: (p, at, len) => {
      /* istanbul ignore next */
      return 0
    },
    wasm_on_status: (p, at, len) => {
      return 0
    },
    wasm_on_message_begin: (p) => {
      assert.strictEqual(currentParser.ptr, p)
      return currentParser.onMessageBegin() || 0
    },
    wasm_on_header_field: (p, at, len) => {
      assert.strictEqual(currentParser.ptr, p)
      const start = at - currentBufferPtr
      const end = start + len
      return currentParser.onHeaderField(currentBufferRef.slice(start, end)) || 0
    },
    wasm_on_header_value: (p, at, len) => {
      assert.strictEqual(currentParser.ptr, p)
      const start = at - currentBufferPtr
      const end = start + len
      return currentParser.onHeaderValue(currentBufferRef.slice(start, end)) || 0
    },
    wasm_on_headers_complete: (p, statusCode, upgrade, shouldKeepAlive) => {
      assert.strictEqual(currentParser.ptr, p)
      return currentParser.onHeadersComplete(statusCode, Boolean(upgrade), Boolean(shouldKeepAlive)) || 0
    },
    wasm_on_body: (p, at, len) => {
      assert.strictEqual(currentParser.ptr, p)
      const start = at - currentBufferPtr
      const end = start + len
      return currentParser.onBody(currentBufferRef.slice(start, end)) || 0
    },
    wasm_on_message_complete: (p) => {
      assert.strictEqual(currentParser.ptr, p)
      return currentParser.onMessageComplete() || 0
    }

    /* eslint-enable camelcase */
  }
})

let currentParser = null
let currentBufferRef = null
let currentBufferSize = 16384
let currentBufferPtr = llhttp.exports.malloc(currentBufferSize)

const TIMEOUT_HEADERS = 1
const TIMEOUT_BODY = 2
const TIMEOUT_IDLE = 3

class Parser {
  constructor (client, socket) {
    assert(Number.isFinite(client[kMaxHeadersSize]) && client[kMaxHeadersSize] > 0)

    this.ptr = llhttp.exports.llhttp_alloc(constants.TYPE.RESPONSE)
    this.client = client
    this.socket = socket
    this.timeout = null
    this.timeoutValue = null
    this.timeoutType = null
    this.statusCode = null
    this.upgrade = false
    this.headers = []
    this.headersSize = 0
    this.headersMaxSize = client[kMaxHeadersSize]
    this.shouldKeepAlive = false
    this.paused = false
    this.resume = this.resume.bind(this)
    this.currentMessage = {
      request: null,
      trailers: null
    }

    this.bytesRead = 0

    this.trailer = ''
    this.keepAlive = ''
    this.contentLength = ''
  }

  setTimeout (value, type) {
    this.timeoutType = type
    if (value !== this.timeoutValue) {
      clearTimeout(this.timeout)
      if (value) {
        this.timeout = setTimeout(onParserTimeout, value, this)
        // istanbul ignore else: only for jest
        if (this.timeout.unref) {
          this.timeout.unref()
        }
      } else {
        this.timeout = null
      }
      this.timeoutValue = value
    } else if (this.timeout) {
      // istanbul ignore else: only for jest
      if (this.timeout.refresh) {
        this.timeout.refresh()
      }
    }
  }

  resume () {
    if (this.socket.destroyed || !this.paused) {
      return
    }

    assert(this.ptr != null)
    assert(currentParser == null)

    llhttp.exports.llhttp_resume(this.ptr)

    assert(this.timeoutType === TIMEOUT_BODY)
    if (this.timeout) {
      // istanbul ignore else: only for jest
      if (this.timeout.refresh) {
        this.timeout.refresh()
      }
    }

    this.paused = false
    this.socket.resume()
    this.execute(EMPTY_BUF) // Flush parser.
  }

  execute (data) {
    assert(this.ptr != null)
    assert(currentParser == null)
    assert(!this.paused)

    const { socket } = this

    if (data.length > currentBufferSize) {
      llhttp.exports.free(currentBufferPtr)
      currentBufferSize = Math.ceil(data.length / 4096) * 4096
      currentBufferPtr = llhttp.exports.malloc(currentBufferSize)
    }

    // TODO (perf): Can we avoid this copy somehow?
    new Uint8Array(llhttp.exports.memory.buffer, currentBufferPtr, currentBufferSize).set(data)

    // Call `execute` on the wasm parser.
    // We pass the `llhttp_parser` pointer address, the pointer address of buffer view data,
    // and finally the length of bytes to parse.
    // The return value is an error code or `constants.ERROR.OK`.
    try {
      let ret

      try {
        currentBufferRef = data
        currentParser = this
        ret = llhttp.exports.llhttp_execute(this.ptr, currentBufferPtr, data.length)
        /* eslint-disable-next-line no-useless-catch */
      } catch (err) {
        /* istanbul ignore next: difficult to make a test case for */
        throw err
      } finally {
        currentParser = null
        currentBufferRef = null
      }

      const offset = llhttp.exports.llhttp_get_error_pos(this.ptr) - currentBufferPtr

      if (ret === constants.ERROR.PAUSED_UPGRADE) {
        this.onUpgrade(data.slice(offset))
      } else if (ret === constants.ERROR.PAUSED) {
        this.paused = true
        socket.pause()
        socket.unshift(data.slice(offset))
      } else if (ret !== constants.ERROR.OK) {
        const ptr = llhttp.exports.llhttp_get_error_reason(this.ptr)
        let message = ''
        /* istanbul ignore else: difficult to make a test case for */
        if (ptr) {
          const len = new Uint8Array(llhttp.exports.memory.buffer, ptr).indexOf(0)
          message = Buffer.from(llhttp.exports.memory.buffer, ptr, len).toString()
        }
        throw new HTTPParserError(message, constants.ERROR[ret], data.slice(offset))
      }

      this.flush()
    } catch (err) {
      util.destroy(socket, err)
    }
  }

  flush () {
    const { client, request, trailers } = this.currentMessage

    if (!request) {
      return
    }

    try {
      request.onComplete(trailers)
    } catch (err) {
      errorRequest(client, request, err)
    }

    this.currentMessage.request = null
    this.currentMessage.trailers = null
  }

  finish () {
    try {
      try {
        currentParser = this
        llhttp.exports.llhttp_finish(this.ptr) // TODO (fix): Check ret?
      } finally {
        currentParser = null
      }

      this.flush()
    } catch (err) {
      // TODO (fix): What if socket is already destroyed? Error will be swallowed.
      /* istanbul ignore next: difficult to make a test case for */
      util.destroy(this.socket, err)
    }
  }

  destroy (err) {
    assert(this.ptr != null)
    assert(currentParser == null)

    if (err && err.code !== 'UND_ERR_INFO' && this.currentMessage.request) {
      this.currentMessage.request.onError(err)
      this.currentMessage.request = null
    }

    assert(!this.currentMessage.request)

    llhttp.exports.llhttp_free(this.ptr)
    this.ptr = null

    clearTimeout(this.timeout)
    this.timeout = null
    this.timeoutValue = null
    this.timeoutType = null

    this.paused = false
  }

  onMessageBegin () {
    const { socket, client } = this

    /* istanbul ignore next: difficult to make a test case for */
    if (socket.destroyed) {
      return -1
    }

    const request = client[kQueue][client[kRunningIdx]]
    if (!request) {
      return -1
    }
  }

  onHeaderField (buf) {
    const len = this.headers.length

    if ((len & 1) === 0) {
      this.headers.push(buf)
    } else {
      this.headers[len - 1] = Buffer.concat([this.headers[len - 1], buf])
    }

    this.trackHeader(buf.length)
  }

  onHeaderValue (buf) {
    let len = this.headers.length

    if ((len & 1) === 1) {
      this.headers.push(buf)
      len += 1
    } else {
      this.headers[len - 1] = Buffer.concat([this.headers[len - 1], buf])
    }

    const key = this.headers[len - 2]
    if (key.length === 10 && key.toString().toLowerCase() === 'keep-alive') {
      this.keepAlive += buf.toString()
    } else if (key.length === 7 && key.toString().toLowerCase() === 'trailer') {
      this.trailer += buf.toString()
    } else if (key.length === 14 && key.toString().toLowerCase() === 'content-length') {
      this.contentLength += buf.toString()
    }

    this.trackHeader(buf.length)
  }

  trackHeader (len) {
    this.headersSize += len
    if (this.headersSize >= this.headersMaxSize) {
      util.destroy(this.socket, new HeadersOverflowError())
    }
  }

  onUpgrade (head) {
    const { upgrade, client, socket, headers, statusCode } = this

    assert(upgrade)

    const request = client[kQueue][client[kRunningIdx]]
    assert(request)

    assert(!socket.destroyed)
    assert(socket === client[kSocket])
    assert(!socket.isPaused())
    assert(!this.paused)
    assert(request.upgrade || request.method === 'CONNECT')

    this.statusCode = null
    this.shouldKeepAlive = null

    assert(this.headers.length % 2 === 0)
    this.headers = []
    this.headersSize = 0

    // _readableState.flowing might be `true` if the socket has been
    // explicitly `resume()`:d even if we never registered a 'data'
    // listener.

    // We need to stop unshift from emitting 'data'. However, we cannot
    // call pause()  as that will stop socket from automatically resuming
    // when 'data' listener is registered.

    // Reset socket state to non flowing:
    socket._readableState.flowing = null
    socket.unshift(head)

    socket[kParser].destroy()
    socket[kParser] = null

    socket[kClient] = null
    socket[kError] = null
    socket
      .removeListener('error', onSocketError)
      .removeListener('data', onSocketData)
      .removeListener('end', onSocketEnd)
      .removeListener('close', onSocketClose)

    client[kSocket] = null
    client[kQueue][client[kRunningIdx]++] = null
    client.emit('disconnect', client[kUrl], [client], new InformationalError('upgrade'))

    try {
      request.onUpgrade(statusCode, headers, socket)
    } catch (err) {
      util.destroy(socket, err)
    }

    resume(client)
  }

  onHeadersComplete (statusCode, upgrade, shouldKeepAlive) {
    const { client, socket, headers } = this

    /* istanbul ignore next: difficult to make a test case for */
    if (socket.destroyed) {
      return -1
    }

    const request = client[kQueue][client[kRunningIdx]]

    /* istanbul ignore next: difficult to make a test case for */
    if (!request) {
      return -1
    }

    // TODO: Check for content-length mismatch from server?

    assert(!this.upgrade)
    assert(this.statusCode < 200)

    // TODO: More statusCode validation?

    if (statusCode === 100) {
      util.destroy(socket, new SocketError('bad response'))
      return -1
    }

    /* istanbul ignore if: this can only happen if server is misbehaving */
    if (upgrade && !request.upgrade) {
      util.destroy(socket, new SocketError('bad upgrade'))
      return -1
    }

    assert.strictEqual(this.timeoutType, TIMEOUT_HEADERS)

    this.statusCode = statusCode
    this.shouldKeepAlive = shouldKeepAlive

    if (this.statusCode >= 200) {
      const bodyTimeout = request.bodyTimeout != null
        ? request.bodyTimeout
        : client[kBodyTimeout]
      this.setTimeout(bodyTimeout, TIMEOUT_BODY)
    } else if (this.timeout) {
      // istanbul ignore else: only for jest
      if (this.timeout.refresh) {
        this.timeout.refresh()
      }
    }

    if (request.method === 'CONNECT' && statusCode >= 200 && statusCode < 300) {
      assert(client[kRunning] === 1)
      this.upgrade = true
      return 2
    }

    if (upgrade) {
      assert(client[kRunning] === 1)
      this.upgrade = true
      return 2
    }

    assert(this.headers.length % 2 === 0)
    this.headers = []
    this.headersSize = 0

    if (shouldKeepAlive && client[kPipelining]) {
      const keepAliveTimeout = this.keepAlive ? util.parseKeepAliveTimeout(this.keepAlive) : null

      if (keepAliveTimeout != null) {
        const timeout = Math.min(
          keepAliveTimeout - client[kKeepAliveTimeoutThreshold],
          client[kKeepAliveMaxTimeout]
        )
        if (timeout <= 0) {
          socket[kReset] = true
        } else {
          client[kKeepAliveTimeoutValue] = timeout
        }
      } else {
        client[kKeepAliveTimeoutValue] = client[kKeepAliveDefaultTimeout]
      }
    } else {
      // Stop more requests from being dispatched.
      socket[kReset] = true
    }

    try {
      if (request.onHeaders(statusCode, headers, this.resume) === false) {
        return constants.ERROR.PAUSED
      }
    } catch (err) {
      util.destroy(socket, err)
      return -1
    }

    if (request.method === 'HEAD') {
      assert(socket[kReset])
      return 1
    }

    if (statusCode < 200) {
      return 1
    }
  }

  onBody (buf) {
    const { client, socket, statusCode } = this

    if (socket.destroyed) {
      return -1
    }

    const request = client[kQueue][client[kRunningIdx]]
    assert(request)

    assert.strictEqual(this.timeoutType, TIMEOUT_BODY)
    if (this.timeout) {
      // istanbul ignore else: only for jest
      if (this.timeout.refresh) {
        this.timeout.refresh()
      }
    }

    assert(statusCode >= 200)

    this.bytesRead += buf.length

    try {
      if (request.onData(buf) === false) {
        return constants.ERROR.PAUSED
      }
    } catch (err) {
      util.destroy(socket, err)
      return -1
    }
  }

  onMessageComplete () {
    const { client, socket, statusCode, upgrade, trailer, headers, contentLength, bytesRead, shouldKeepAlive } = this

    if (socket.destroyed && (!statusCode || shouldKeepAlive)) {
      return -1
    }

    if (upgrade) {
      return
    }

    const request = client[kQueue][client[kRunningIdx]]
    assert(request)

    assert(statusCode >= 100)

    this.statusCode = null
    this.bytesRead = 0
    this.contentLength = ''
    this.trailer = ''
    this.keepAlive = ''

    assert(this.headers.length % 2 === 0)
    this.headers = []
    this.headersSize = 0

    if (statusCode < 200) {
      return
    }

    const trailers = trailer ? trailer.split(/,\s*/) : []
    for (let i = 0; i < trailers.length; i++) {
      const trailer = trailers[i]
      let found = false
      for (let n = 0; n < headers.length; n += 2) {
        const key = headers[n]
        if (key.length === trailer.length && key.toString().toLowerCase() === trailer.toLowerCase()) {
          found = true
          break
        }
      }
      if (!found) {
        util.destroy(socket, new TrailerMismatchError())
        return -1
      }
    }

    /* istanbul ignore next: should be handled by llhttp? */
    if (request.method !== 'HEAD' && contentLength && bytesRead !== parseInt(contentLength, 10)) {
      util.destroy(socket, new ResponseContentLengthMismatchError())
      return -1
    }

    this.flush()
    assert(!this.currentMessage.request && !this.currentMessage.trailers)
    this.currentMessage.request = request
    this.currentMessage.trailers = headers

    client[kQueue][client[kRunningIdx]++] = null

    if (socket[kWriting]) {
      assert.strictEqual(client[kRunning], 0)
      // Response completed before request.
      util.destroy(socket, new InformationalError('reset'))
      return constants.ERROR.PAUSED
    } else if (!shouldKeepAlive) {
      // TODO: What if running > 0?
      util.destroy(socket, new InformationalError('reset'))
      return constants.ERROR.PAUSED
    } else if (socket[kReset] && client[kRunning] === 0) {
      // Destroy socket once all requests have completed.
      // The request at the tail of the pipeline is the one
      // that requested reset and no further requests should
      // have been queued since then.
      util.destroy(socket, new InformationalError('reset'))
      return constants.ERROR.PAUSED
    } else {
      resume(client)
    }
  }
}

function onParserTimeout (parser) {
  const { socket, timeoutType, client } = parser

  /* istanbul ignore else */
  if (timeoutType === TIMEOUT_HEADERS) {
    if (!socket[kWriting]) {
      assert(!parser.paused, 'cannot be paused while waiting for headers')
      util.destroy(socket, new HeadersTimeoutError())
    }
  } else if (timeoutType === TIMEOUT_BODY) {
    if (!parser.paused) {
      util.destroy(socket, new BodyTimeoutError())
    }
  } else if (timeoutType === TIMEOUT_IDLE) {
    assert(client[kRunning] === 0 && client[kKeepAliveTimeoutValue])
    util.destroy(socket, new InformationalError('socket idle timeout'))
  }
}

function onSocketData (data) {
  const { [kParser]: parser } = this
  parser.execute(data)
}

function onSocketError (err) {
  const { [kParser]: parser } = this

  assert(err.code !== 'ERR_TLS_CERT_ALTNAME_INVALID')

  // On Mac OS, we get an ECONNRESET even if there is a full body to be forwarded
  // to the user.
  if (err.code === 'ECONNRESET' && parser.statusCode && !parser.shouldKeepAlive) {
    // We treat all incoming data so for as a valid response.
    parser.finish()
    return
  }

  this[kError] = err

  onError(this[kClient], err)
}

function onError (client, err) {
  if (
    client[kRunning] === 0 &&
    err.code !== 'UND_ERR_INFO' &&
    err.code !== 'UND_ERR_SOCKET'
  ) {
    // Error is not caused by running request and not a recoverable
    // socket error.

    assert(client[kPendingIdx] === client[kRunningIdx])

    const requests = client[kQueue].splice(client[kRunningIdx])
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i]
      errorRequest(client, request, err)
    }
    assert(client[kSize] === 0)
  }
}

function onSocketEnd () {
  const { [kParser]: parser } = this

  if (parser.statusCode && !parser.shouldKeepAlive) {
    // We treat all incoming data so far as a valid response.
    parser.finish()
    return
  }

  util.destroy(this, new SocketError('other side closed'))
}

function onSocketClose () {
  const { [kClient]: client } = this

  this[kParser].destroy(this[kError])
  this[kParser] = null

  const err = this[kError] || new SocketError('closed')

  client[kSocket] = null

  if (client[kDestroyed]) {
    assert(client[kPending] === 0)

    // Fail entire queue.
    const requests = client[kQueue].splice(client[kRunningIdx])
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i]
      errorRequest(client, request, err)
    }
  } else if (client[kRunning] > 0 && err.code !== 'UND_ERR_INFO') {
    // Fail head of pipeline.
    const request = client[kQueue][client[kRunningIdx]]
    client[kQueue][client[kRunningIdx]++] = null

    errorRequest(client, request, err)
  }

  client[kPendingIdx] = client[kRunningIdx]

  assert(client[kRunning] === 0)

  client.emit('disconnect', client[kUrl], [client], err)

  resume(client)
}

function connect (client) {
  assert(!client[kConnecting])
  assert(!client[kSocket])

  let { host, hostname, protocol, port } = client[kUrl]

  // Resolve ipv6
  if (hostname.startsWith('[')) {
    const idx = hostname.indexOf(']')

    assert(idx !== -1)
    const ip = hostname.substr(1, idx - 1)

    assert(net.isIP(ip))
    hostname = ip
  }

  client[kConnecting] = true
  client[kConnector]({
    host,
    hostname,
    protocol,
    port,
    servername: client[kServerName]
  }, function (err, socket) {
    client[kConnecting] = false

    if (err) {
      if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        assert(client[kRunning] === 0)
        while (client[kPending] > 0 && client[kQueue][client[kPendingIdx]].servername === client[kServerName]) {
          const request = client[kQueue][client[kPendingIdx]++]
          errorRequest(client, request, err)
        }
      } else {
        onError(client, err)
      }

      client.emit('connectionError', client[kUrl], [client], err)
    } else {
      assert(socket)

      client[kSocket] = socket

      socket[kNoRef] = false
      socket[kWriting] = false
      socket[kReset] = false
      socket[kError] = null
      socket[kParser] = new Parser(client, socket)
      socket[kClient] = client
      socket
        .on('error', onSocketError)
        .on('data', onSocketData)
        .on('end', onSocketEnd)
        .on('close', onSocketClose)

      client.emit('connect', client[kUrl], [client])
    }

    resume(client)
  })
}

function emitDrain (client) {
  client[kNeedDrain] = 0
  client.emit('drain', client[kUrl], [client])
}

function resume (client, sync) {
  if (client[kResuming] === 2) {
    return
  }

  client[kResuming] = 2
  _resume(client, sync)
  client[kResuming] = 0

  if (client[kRunningIdx] > 256) {
    client[kQueue].splice(0, client[kRunningIdx])
    client[kPendingIdx] -= client[kRunningIdx]
    client[kRunningIdx] = 0
  }
}

function _resume (client, sync) {
  while (true) {
    if (client[kDestroyed]) {
      assert(client[kPending] === 0)
      return
    }

    if (client[kClosed] && !client[kSize]) {
      client.destroy(util.nop)
      continue
    }

    const socket = client[kSocket]

    if (socket) {
      if (client[kSize] === 0) {
        if (!socket[kNoRef] && socket.unref) {
          socket.unref()
          socket[kNoRef] = true
        }
      } else if (socket[kNoRef] && socket.ref) {
        socket.ref()
        socket[kNoRef] = false
      }

      if (client[kSize] === 0) {
        if (socket[kParser].timeoutType !== TIMEOUT_IDLE) {
          socket[kParser].setTimeout(client[kKeepAliveTimeoutValue], TIMEOUT_IDLE)
        }
      } else if (client[kRunning] > 0 && socket[kParser].statusCode < 200) {
        if (socket[kParser].timeoutType !== TIMEOUT_HEADERS) {
          const request = client[kQueue][client[kRunningIdx]]
          const headersTimeout = request.headersTimeout != null
            ? request.headersTimeout
            : client[kHeadersTimeout]
          socket[kParser].setTimeout(headersTimeout, TIMEOUT_HEADERS)
        }
      }
    }

    if (client[kBusy]) {
      client[kNeedDrain] = 2
    } else if (client[kNeedDrain] === 2) {
      if (sync) {
        client[kNeedDrain] = 1
        process.nextTick(emitDrain, client)
      } else {
        emitDrain(client)
      }
      continue
    }

    if (client[kPending] === 0) {
      return
    }

    if (client[kRunning] >= (client[kPipelining] || 1)) {
      return
    }

    const request = client[kQueue][client[kPendingIdx]]

    if (client[kUrl].protocol === 'https:' && client[kServerName] !== request.servername) {
      if (client[kRunning] > 0) {
        return
      }

      client[kServerName] = request.servername

      if (socket && socket.servername !== request.servername) {
        util.destroy(socket, new InformationalError('servername changed'))
        return
      }
    }

    if (client[kConnecting]) {
      return
    }

    if (!socket) {
      connect(client)
      continue
    }

    if (socket.destroyed || socket[kWriting] || socket[kReset]) {
      return
    }

    if (client[kRunning] > 0 && !request.idempotent) {
      // Non-idempotent request cannot be retried.
      // Ensure that no other requests are inflight and
      // could cause failure.
      return
    }

    if (client[kRunning] > 0 && (request.upgrade || request.method === 'CONNECT')) {
      // Don't dispatch an upgrade until all preceding requests have completed.
      // A misbehaving server might upgrade the connection before all pipelined
      // request has completed.
      return
    }

    if (util.isStream(request.body) && util.bodyLength(request.body) === 0) {
      request.body
        .on('data', /* istanbul ignore next */ function () {
          /* istanbul ignore next */
          assert(false)
        })
        .on('error', function (err) {
          errorRequest(client, request, err)
        })
        .on('end', function () {
          util.destroy(this)
        })

      request.body = null
    }

    if (client[kRunning] > 0 &&
      (util.isStream(request.body) || util.isStrictIterable(request.body))) {
      // Request with stream or iterator body can error while other requests
      // are inflight and indirectly error those as well.
      // Ensure this doesn't happen by waiting for inflight
      // to complete before dispatching.

      // Request with stream or iterator body cannot be retried.
      // Ensure that no other requests are inflight and
      // could cause failure.
      return
    }

    if (!request.aborted && write(client, request)) {
      client[kPendingIdx]++
    } else {
      client[kQueue].splice(client[kPendingIdx], 1)
    }
  }
}

function write (client, request) {
  const { body, method, path, host, upgrade, headers } = request

  // https://tools.ietf.org/html/rfc7231#section-4.3.1
  // https://tools.ietf.org/html/rfc7231#section-4.3.2
  // https://tools.ietf.org/html/rfc7231#section-4.3.5

  // Sending a payload body on a request that does not
  // expect it can cause undefined behavior on some
  // servers and corrupt connection state. Do not
  // re-use the connection for further requests.

  const expectsPayload = (
    method === 'PUT' ||
    method === 'POST' ||
    method === 'PATCH'
  )

  if (body && typeof body.read === 'function') {
    // Try to read EOF in order to get length.
    body.read(0)
  }

  let contentLength = util.bodyLength(body)

  if (contentLength === null) {
    contentLength = request.contentLength
  }

  if (contentLength === 0 && !expectsPayload) {
    // https://tools.ietf.org/html/rfc7230#section-3.3.2
    // A user agent SHOULD NOT send a Content-Length header field when
    // the request message does not contain a payload body and the method
    // semantics do not anticipate such a body.

    contentLength = null
  }

  if (request.contentLength !== null && request.contentLength !== contentLength) {
    if (client[kStrictContentLength]) {
      errorRequest(client, request, new RequestContentLengthMismatchError())
      return false
    }

    process.emitWarning(new RequestContentLengthMismatchError())
  }

  const socket = client[kSocket]

  try {
    request.onConnect((err) => {
      if (request.aborted || request.completed) {
        return
      }

      errorRequest(client, request, err || new RequestAbortedError())

      util.destroy(socket, new InformationalError('aborted'))
    })
  } catch (err) {
    errorRequest(client, request, err)
  }

  if (request.aborted) {
    return false
  }

  if (method === 'HEAD') {
    // https://github.com/mcollina/undici/issues/258

    // Close after a HEAD request to interop with misbehaving servers
    // that may send a body in the response.

    socket[kReset] = true
  }

  if (upgrade || method === 'CONNECT') {
    // On CONNECT or upgrade, block pipeline from dispatching further
    // requests on this connection.

    socket[kReset] = true
  }

  // TODO: Expect: 100-continue

  let header

  if (upgrade) {
    let connectionString = 'upgrade'
    if (headers.toLowerCase().includes('http2-settings')) {
      connectionString += ', http2-settings'
    }
    header = `${method} ${path} HTTP/1.1\r\nconnection: ${connectionString}\r\nupgrade: ${upgrade}\r\n`
  } else if (client[kPipelining]) {
    header = `${method} ${path} HTTP/1.1\r\nconnection: keep-alive\r\n`
  } else {
    header = `${method} ${path} HTTP/1.1\r\nconnection: close\r\n`
  }

  if (!host) {
    header += client[kHostHeader]
  }

  if (headers) {
    header += headers
  }

  /* istanbul ignore else: assertion */
  if (!body) {
    if (contentLength === 0) {
      socket.write(`${header}content-length: 0\r\n\r\n`, 'ascii')
    } else {
      assert(contentLength === null, 'no body must not have content length')
      socket.write(`${header}\r\n`, 'ascii')
    }
  } else if (util.isBuffer(body)) {
    assert(contentLength !== null, 'buffer body must have content length')

    socket.cork()
    socket.write(`${header}content-length: ${contentLength}\r\n\r\n`, 'ascii')
    socket.write(body)
    socket.uncork()
    request.onBodySent(body)
    if (!expectsPayload) {
      socket[kReset] = true
    }
  } else if (util.isStream(body)) {
    writeStream({ client, request, socket, contentLength, header, expectsPayload })
  } else if (util.isStrictIterable(body)) {
    writeIterable({ client, request, socket, contentLength, header, expectsPayload })
  } else {
    assert(false)
  }

  return true
}

function writeStream ({ client, request, socket, contentLength, header, expectsPayload }) {
  const { body } = request

  assert(contentLength !== 0 || client[kRunning] === 0, 'stream body cannot be pipelined')

  let finished = false

  const writer = new AsyncWriter({ socket, request, contentLength, client, expectsPayload, header })

  const onData = function (chunk) {
    try {
      assert(!finished)

      if (!writer.write(chunk) && this.pause) {
        this.pause()
      }
    } catch (err) {
      util.destroy(this, err)
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

    assert(socket.destroyed || (socket[kWriting] && client[kRunning] <= 1))

    socket
      .off('drain', onDrain)
      .off('error', onFinished)

    body
      .removeListener('data', onData)
      .removeListener('end', onFinished)
      .removeListener('error', onFinished)
      .removeListener('close', onAbort)

    if (!err) {
      try {
        writer.end()
      } catch (er) {
        err = er
      }
    }

    writer.destroy(err)

    // TODO (fix): Avoid using err.message for logic.
    if (err && (err.code !== 'UND_ERR_INFO' || err.message !== 'reset')) {
      util.destroy(body, err)
    } else {
      util.destroy(body)
    }
  }

  body
    .on('data', onData)
    .on('end', onFinished)
    .on('error', onFinished)
    .on('close', onAbort)

  socket
    .on('drain', onDrain)
    .on('error', onFinished)
}

async function writeIterable ({ client, request, socket, contentLength, header, expectsPayload }) {
  const { body } = request

  assert(contentLength !== 0 || client[kRunning] === 0, 'iterator body cannot be pipelined')

  let callback = null
  function onDrain () {
    if (callback) {
      const cb = callback
      callback = null
      cb()
    }
  }

  const waitForDrain = () => new Promise((resolve, reject) => {
    assert(callback === null)

    if (socket[kError]) {
      reject(socket[kError])
    } else {
      callback = resolve
    }
  })

  socket
    .on('close', onDrain)
    .on('drain', onDrain)

  const writer = new AsyncWriter({ socket, request, contentLength, client, expectsPayload, header })
  try {
    // TODO (fix): What if socket errors while waiting for body?
    // It's up to the user to somehow abort the async iterable.
    for await (const chunk of body) {
      if (socket[kError]) {
        throw socket[kError]
      }

      if (!writer.write(chunk)) {
        await waitForDrain()
      }
    }

    writer.end()
  } catch (err) {
    writer.destroy(err)
  } finally {
    socket
      .off('close', onDrain)
      .off('drain', onDrain)
  }
}

class AsyncWriter {
  constructor ({ socket, request, contentLength, client, expectsPayload, header }) {
    this.socket = socket
    this.request = request
    this.contentLength = contentLength
    this.client = client
    this.bytesWritten = 0
    this.expectsPayload = expectsPayload
    this.header = header

    socket[kWriting] = true
  }

  write (chunk) {
    const { socket, request, contentLength, client, bytesWritten, expectsPayload, header } = this

    if (socket[kError]) {
      throw socket[kError]
    }

    if (socket.destroyed) {
      return false
    }

    const len = Buffer.byteLength(chunk)
    if (!len) {
      return true
    }

    // TODO: What if not ended and bytesWritten === contentLength?
    // We should defer writing chunks.
    if (contentLength !== null && bytesWritten + len > contentLength) {
      if (client[kStrictContentLength]) {
        throw new RequestContentLengthMismatchError()
      }

      process.emitWarning(new RequestContentLengthMismatchError())
    }

    if (bytesWritten === 0) {
      if (!expectsPayload) {
        socket[kReset] = true
      }

      if (contentLength === null) {
        socket.write(`${header}transfer-encoding: chunked\r\n`, 'ascii')
      } else {
        socket.write(`${header}content-length: ${contentLength}\r\n\r\n`, 'ascii')
      }
    }

    if (contentLength === null) {
      socket.write(`\r\n${len.toString(16)}\r\n`, 'ascii')
    }

    this.bytesWritten += len

    const ret = socket.write(chunk)
    request.onBodySent(chunk)
    return ret
  }

  end () {
    const { socket, contentLength, client, bytesWritten, expectsPayload, header } = this

    socket[kWriting] = false

    if (socket[kError]) {
      throw socket[kError]
    }

    if (socket.destroyed) {
      return
    }

    if (bytesWritten === 0) {
      if (expectsPayload) {
        // https://tools.ietf.org/html/rfc7230#section-3.3.2
        // A user agent SHOULD send a Content-Length in a request message when
        // no Transfer-Encoding is sent and the request method defines a meaning
        // for an enclosed payload body.

        socket.write(`${header}content-length: 0\r\n\r\n`, 'ascii')
      } else {
        socket.write(`${header}\r\n`, 'ascii')
      }
    } else if (contentLength === null) {
      socket.write('\r\n0\r\n\r\n', 'ascii')
    }

    if (contentLength !== null && bytesWritten !== contentLength) {
      if (client[kStrictContentLength]) {
        throw new RequestContentLengthMismatchError()
      } else {
        process.emitWarning(new RequestContentLengthMismatchError())
      }
    }

    // TODO (fix): Add comment clarifying what this does?
    if (socket[kParser].timeout && socket[kParser].timeoutType === TIMEOUT_HEADERS) {
      // istanbul ignore else: only for jest
      if (socket[kParser].timeout.refresh) {
        socket[kParser].timeout.refresh()
      }
    }

    resume(client)
  }

  destroy (err) {
    const { socket, client } = this

    socket[kWriting] = false

    if (err) {
      assert(client[kRunning] <= 1, 'pipeline should only contain this request')
      util.destroy(socket, err)
    }
  }
}

function errorRequest (client, request, err) {
  try {
    request.onError(err)
    assert(request.aborted)
  } catch (err) {
    client.emit('error', err)
  }
}

module.exports = Client
