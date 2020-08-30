'use strict'

const {
  InvalidArgumentError,
  RequestAbortedError,
  RequestTimeoutError,
  NotSupportedError
} = require('./errors')
const util = require('./util')
const {
  kRequestTimeout,
  kResume
} = require('./symbols')
const assert = require('assert')

const kAbort = Symbol('abort')
const kTimeout = Symbol('timeout')
const kSignal = Symbol('signal')
const kHandler = Symbol('handler')

class Request {
  constructor ({
    path,
    method,
    body,
    headers,
    idempotent,
    upgrade,
    signal,
    requestTimeout
  }, {
    [kRequestTimeout]: defaultRequestTimeout,
    [kResume]: resume
  }, handler) {
    if (typeof path !== 'string' || path[0] !== '/') {
      throw new InvalidArgumentError('path must be a valid path')
    }

    if (typeof method !== 'string') {
      throw new InvalidArgumentError('method must be a string')
    }

    if (upgrade && typeof upgrade !== 'string') {
      throw new InvalidArgumentError('upgrade must be a string')
    }

    if (signal && typeof signal.on !== 'function' && typeof signal.addEventListener !== 'function') {
      throw new InvalidArgumentError('signal must be an EventEmitter or EventTarget')
    }

    requestTimeout = requestTimeout == null && defaultRequestTimeout
      ? defaultRequestTimeout
      : requestTimeout

    if (requestTimeout != null && (!Number.isInteger(requestTimeout) || requestTimeout < 0)) {
      throw new InvalidArgumentError('requestTimeout must be a positive integer or zero')
    }

    this[kHandler] = handler

    this.method = method

    if (body == null) {
      this.body = null
    } else if (util.isStream(body)) {
      this.body = body
      // TODO: Cleanup listeners?
      this.body.on('error', (err) => {
        // TODO: Ignore error if body has ended?
        this.onError(err)
      })
    } else if (util.isBuffer(body)) {
      this.body = body.length ? body : null
    } else if (typeof body === 'string') {
      this.body = body.length ? Buffer.from(body) : null
    } else {
      throw new InvalidArgumentError('body must be a string, a Buffer or a Readable stream')
    }

    this.host = (headers && (headers.host || headers.Host)) || null

    this.aborted = false

    this.upgrade = !!upgrade

    this.path = path

    this.idempotent = idempotent == null
      ? method === 'HEAD' || method === 'GET'
      : idempotent

    this.contentLength = null

    this.headers = ''

    if (headers) {
      for (const [key, val] of Object.entries(headers)) {
        if (typeof val === 'object') {
          throw new InvalidArgumentError(`invalid ${key} header`)
        } else if (val === undefined) {
          continue
        }

        if (
          this.contentLength === null &&
          key.length === 14 &&
          key.toLowerCase() === 'content-length'
        ) {
          this.contentLength = parseInt(val)
          if (!Number.isFinite(this.contentLength)) {
            throw new InvalidArgumentError('invalid content-length header')
          }
        } else if (
          key.length === 17 &&
          key.toLowerCase() === 'transfer-encoding'
        ) {
          throw new InvalidArgumentError('invalid transfer-encoding header')
        } else if (
          key.length === 10 &&
          key.toLowerCase() === 'connection'
        ) {
          throw new InvalidArgumentError('invalid connection header')
        } else if (
          key.length === 10 &&
          key.toLowerCase() === 'keep-alive'
        ) {
          throw new InvalidArgumentError('invalid keep-alive header')
        } else if (
          key.length === 7 &&
          key.toLowerCase() === 'upgrade'
        ) {
          throw new InvalidArgumentError('invalid upgrade header')
        } else if (
          key.length === 6 &&
          key.toLowerCase() === 'expect'
        ) {
          throw new NotSupportedError('expect header not supported')
        } else {
          this.headers += `${key}: ${val}\r\n`
        }
      }
    }

    if (signal) {
      this[kSignal] = signal
      this[kAbort] = () => {
        this.onError(new RequestAbortedError())
      }
      if ('addEventListener' in signal) {
        signal.addEventListener('abort', this[kAbort])
      } else {
        signal.addListener('abort', this[kAbort])
      }
    } else {
      this[kSignal] = null
      this[kAbort] = null
    }

    this[kRequestTimeout] = requestTimeout
    this[kTimeout] = null
    this[kResume] = resume
  }

  onConnect () {
    assert(!this.aborted)

    if (this[kRequestTimeout]) {
      if (this[kTimeout]) {
        clearTimeout(this[kTimeout])
      }

      this[kTimeout] = setTimeout((self) => {
        self.onError(new RequestTimeoutError())
      }, this[kRequestTimeout], this)
    }

    this[kHandler].onConnect((err) => {
      this.onError(err || new RequestAbortedError())
    })
  }

  onHeaders (statusCode, headers, resume) {
    assert(!this.aborted)

    const {
      [kTimeout]: timeout
    } = this

    if (timeout) {
      this[kTimeout] = null
      clearTimeout(timeout)
    }

    this[kHandler].onHeaders(statusCode, headers, resume)
  }

  onBody (chunk, offset, length) {
    assert(!this.aborted)

    return this[kHandler].onData(chunk.slice(offset, offset + length))
  }

  onUpgrade (statusCode, headers, socket) {
    assert(!this.aborted)

    destroy(this)

    this[kHandler].onUpgrade(statusCode, headers, socket)
  }

  onComplete (trailers) {
    assert(!this.aborted)

    destroy(this)

    this[kHandler].onComplete(trailers)
  }

  onError (err) {
    if (this.aborted) {
      return
    }
    this.aborted = true

    util.destroy(this.body, err)

    destroy(this)

    this[kResume]()

    this[kHandler].onError(err)
  }
}

function destroy (request) {
  const {
    [kTimeout]: timeout,
    [kSignal]: signal
  } = request

  if (timeout) {
    request[kTimeout] = null
    clearTimeout(timeout)
  }

  if (signal) {
    request[kSignal] = null
    if ('removeEventListener' in signal) {
      signal.removeEventListener('abort', request[kAbort])
    } else {
      signal.removeListener('abort', request[kAbort])
    }
  }
}

module.exports = Request
