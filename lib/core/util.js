'use strict'

const assert = require('assert')
const { kDestroyed } = require('./symbols')
const { IncomingMessage } = require('http')
const net = require('net')
const { InvalidArgumentError } = require('./errors')

function nop () {}

function isReadable (obj) {
  return !!(obj && typeof obj.pipe === 'function' &&
    typeof obj.on === 'function')
}

function isWritable (obj) {
  return !!(obj && typeof obj.write === 'function' &&
    typeof obj.on === 'function')
}

function isStream (obj) {
  return isReadable(obj) || isWritable(obj)
}

function parseURL (url) {
  if (typeof url === 'string') {
    url = new URL(url)
  }

  if (!url || typeof url !== 'object') {
    throw new InvalidArgumentError('invalid url')
  }

  if (url.port != null && url.port !== '' && !Number.isFinite(parseInt(url.port))) {
    throw new InvalidArgumentError('invalid port')
  }

  if (url.path != null && typeof url.path !== 'string') {
    throw new InvalidArgumentError('invalid path')
  }

  if (url.pathname != null && typeof url.pathname !== 'string') {
    throw new InvalidArgumentError('invalid pathname')
  }

  if (url.hostname != null && typeof url.hostname !== 'string') {
    throw new InvalidArgumentError('invalid hostname')
  }

  if (url.origin != null && typeof url.origin !== 'string') {
    throw new InvalidArgumentError('invalid origin')
  }

  if (!/^https?:/.test(url.origin || url.protocol)) {
    throw new InvalidArgumentError('invalid protocol')
  }

  if (!(url instanceof URL)) {
    const port = url.port != null
      ? url.port
      : (url.protocol === 'https:' ? 443 : 80)
    const origin = url.origin != null
      ? url.origin
      : `${url.protocol}//${url.hostname}:${port}`
    const path = url.path != null
      ? url.path
      : `${url.pathname || ''}${url.search || ''}`

    url = new URL(path, origin)
  }

  return url
}

function parseOrigin (url) {
  url = parseURL(url)

  if (url.pathname !== '/' || url.search || url.hash) {
    throw new InvalidArgumentError('invalid url')
  }

  return url
}

function getServerName (host) {
  if (!host) {
    return null
  }

  assert.strictEqual(typeof host, 'string')

  let servername = host

  if (servername[0] === '[') {
    const idx = servername.indexOf(']')

    assert(idx !== -1)
    servername = servername.substr(1, idx - 1)
  } else {
    servername = servername.split(':', 1)[0]
  }

  if (net.isIP(servername)) {
    servername = null
  }

  return servername
}

function deepClone (obj) {
  return JSON.parse(JSON.stringify(obj))
}

function isIterable (obj) {
  return !!(obj != null && (typeof obj[Symbol.iterator] === 'function' || typeof obj[Symbol.asyncIterator] === 'function'))
}

function isStrictIterable (obj) {
  return obj && !isStream(obj) && typeof obj !== 'string' && !isBuffer(obj) && isIterable(obj)
}

function bodyLength (body) {
  if (body && typeof body.on === 'function') {
    const state = body._readableState
    return state && state.ended === true && Number.isFinite(state.length)
      ? state.length
      : null
  } else if (isStrictIterable(body)) {
    return null
  }

  assert(!body || Number.isFinite(body.byteLength))

  return body ? body.byteLength : 0
}

function isDestroyed (stream) {
  return !stream || !!(stream.destroyed || stream[kDestroyed])
}

function destroy (stream, err) {
  if (!isStream(stream) || isDestroyed(stream)) {
    return
  }

  if (typeof stream.destroy === 'function') {
    if (Object.getPrototypeOf(stream).constructor === IncomingMessage) {
      // See: https://github.com/nodejs/node/pull/38505/files
      stream.socket = null
    }
    stream.destroy(err)
  } else if (err) {
    process.nextTick((stream, err) => {
      stream.emit('error', err)
    }, stream, err)
  }

  if (stream.destroyed !== true) {
    stream[kDestroyed] = true
  }
}

const KEEPALIVE_TIMEOUT_EXPR = /timeout=(\d+)/
function parseKeepAliveTimeout (val) {
  const m = val.toString().match(KEEPALIVE_TIMEOUT_EXPR)
  return m ? parseInt(m[1], 10) * 1000 : null
}

function parseHeaders (headers, obj = {}) {
  for (let i = 0; i < headers.length; i += 2) {
    const key = headers[i].toString().toLowerCase()
    let val = obj[key]
    if (!val) {
      obj[key] = headers[i + 1].toString()
    } else {
      if (!Array.isArray(val)) {
        val = [val]
        obj[key] = val
      }
      val.push(headers[i + 1].toString())
    }
  }
  return obj
}

function isBuffer (buffer) {
  // See, https://github.com/mcollina/undici/pull/319
  return buffer instanceof Uint8Array || Buffer.isBuffer(buffer)
}

function validateHandler (handler, method, upgrade) {
  if (!handler || typeof handler !== 'object') {
    throw new InvalidArgumentError('handler must be an object')
  }

  if (typeof handler.onConnect !== 'function') {
    throw new InvalidArgumentError('invalid onConnect method')
  }

  if (typeof handler.onError !== 'function') {
    throw new InvalidArgumentError('invalid onError method')
  }

  if (typeof handler.onBodySent !== 'function' && handler.onBodySent !== undefined) {
    throw new InvalidArgumentError('invalid onBodySent method')
  }

  if (upgrade || method === 'CONNECT') {
    if (typeof handler.onUpgrade !== 'function') {
      throw new InvalidArgumentError('invalid onUpgrade method')
    }
  } else {
    if (typeof handler.onHeaders !== 'function') {
      throw new InvalidArgumentError('invalid onHeaders method')
    }

    if (typeof handler.onData !== 'function') {
      throw new InvalidArgumentError('invalid onData method')
    }

    if (typeof handler.onComplete !== 'function') {
      throw new InvalidArgumentError('invalid onComplete method')
    }
  }
}

module.exports = {
  nop,
  parseOrigin,
  parseURL,
  getServerName,
  isStream,
  isReadable,
  isIterable,
  isStrictIterable,
  isDestroyed,
  parseHeaders,
  parseKeepAliveTimeout,
  destroy,
  bodyLength,
  deepClone,
  isBuffer,
  validateHandler
}
