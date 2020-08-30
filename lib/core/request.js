'use strict'

const {
  InvalidArgumentError,
  RequestAbortedError,
  RequestTimeoutError,
  NotSupportedError
} = require('./errors')
const net = require('net')
const util = require('./util')
const {
  kRequestTimeout,
  kResume
} = require('./symbols')
const assert = require('assert')

const kTimeout = Symbol('timeout')
const kHandler = Symbol('handler')

class Request {
  constructor ({
    path,
    method,
    body,
    headers,
    idempotent,
    upgrade,
    requestTimeout
  }, {
    [kRequestTimeout]: defaultRequestTimeout
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
    } else if (util.isBuffer(body)) {
      this.body = body.length ? body : null
    } else if (typeof body === 'string') {
      this.body = body.length ? Buffer.from(body) : null
    } else {
      throw new InvalidArgumentError('body must be a string, a Buffer or a Readable stream')
    }

    this.host = headers && (headers.host || headers.Host)

    if (
      this.host &&
      !/^\[/.test(this.host) &&
      !net.isIP(this.host)
    ) {
      this.servername = this.host
    } else {
      this.servername = null
    }

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

    this[kRequestTimeout] = requestTimeout
    this[kTimeout] = null
    this[kResume] = null
  }

  onConnect (resume) {
    assert(!this.aborted)

    this[kResume] = resume

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

    destroy(this)

    const {
      [kResume]: resume
    } = this

    if (this[kResume]) {
      this[kResume] = null
      resume()
    }

    this[kHandler].onError(err)
  }
}

function destroy (request) {
  const {
    [kTimeout]: timeout
  } = request

  if (timeout) {
    request[kTimeout] = null
    clearTimeout(timeout)
  }
}

module.exports = Request
