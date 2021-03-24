const { InvalidArgumentError } = require('./core/errors')
const util = require('./core/util')
const { getGlobalAgent } = require('./agent')
const assert = require('assert')

const kMaxRedirections = Symbol('maxRedirections')
const kAgent = Symbol('agent')
const kRedirectTag = Symbol('redirectTag')

class RedirectHandler {
  constructor ({ agent, opts, handler }) {
    this.agent = agent
    this.location = null
    this.abort = null
    this.opts = opts
    this.handler = handler
    this.destroyed = false
  }

  destroy (err) {
    this.destroyed = true

    if (this.abort) {
      this.abort()
    }

    this.handler.onError(err)
  }

  get (origin) {
    return this[kAgent].get(origin)
  }

  onConnect (abort) {
    if (this.destroyed) {
      abort()
    } else {
      this.abort = abort
      this.handler.onConnect(abort)
    }
  }

  onUpgrade (statusCode, headers, socket) {
    this.handler.onUpgrade(statusCode, headers, socket)
  }

  onError (error) {
    this.handler.onError(error)
  }

  onHeaders (statusCode, headers, resume) {
    if ([300, 301, 302, 303, 307, 308].indexOf(statusCode) === -1) {
      return this.handler.onHeaders(statusCode, headers, resume)
    }

    this.location = parseLocation(headers)

    if (!this.location) {
      return this.handler.onHeaders(statusCode, headers, resume)
    }

    const { origin, pathname, search } = util.parseURL(new URL(this.location, this.opts.origin))
    const path = search ? `${pathname || '/'}${search || ''}` : pathname

    this.opts = { ...this.opts }

    // Remove headers referring to the original URL.
    // By default it is Host only, unless it's a 303 (see below), which removes also all Content-* headers.
    // https://tools.ietf.org/html/rfc7231#section-6.4
    this.opts.headers = cleanRequestHeaders(this.opts.headers, statusCode === 303)
    this.opts.path = path
    this.opts.origin = origin

    // https://tools.ietf.org/html/rfc7231#section-6.4.4
    // In case of HTTP 303, always replace method to be either HEAD or GET
    if (statusCode === 303 && this.opts.method !== 'HEAD') {
      this.opts.method = 'GET'
      this.opts.body = null
    }
  }

  onData (chunk) {
    if (!this.location) {
      return this.handler.onData(chunk)
    }
  }

  onComplete (trailers) {
    if (this.location) {
      this.agent.dispatch(this.opts, this.handler)
    } else {
      this.handler.onComplete(trailers)
    }
  }
}

class RedirectAgent {
  constructor ({ maxRedirections = 10, agent } = {}) {
    if (!Number.isInteger(maxRedirections) || maxRedirections < 0) {
      throw new InvalidArgumentError('maxRedirections must be a positive number')
    }

    if (agent != null && typeof agent.dispatch !== 'function') {
      throw new InvalidArgumentError('invalid opts.agent')
    }

    this[kMaxRedirections] = maxRedirections
    this[kAgent] = agent
    this[kRedirectTag] = Symbol('redirectTag')
  }

  dispatch (opts, handler) {
    const { maxRedirections = this[kMaxRedirections] } = opts

    if (!Number.isInteger(maxRedirections) || maxRedirections < 0) {
      throw new InvalidArgumentError('maxRedirections must be a positive number')
    }

    opts = { ...opts }

    assert(!opts[kRedirectTag] || (opts[kRedirectTag] === this[kRedirectTag]), 'circular dispatch')
    opts[kRedirectTag] = this[kRedirectTag]

    const { [kAgent]: agent = getGlobalAgent() } = this

    if (!maxRedirections) {
      agent.dispatch(opts, handler)
      return
    }

    if (util.isStream(opts.body) && util.bodyLength(opts.body) !== 0) {
      // TODO (fix): Provide some way for the user to cache the file to e.g. /tmp
      // so that it can be dispatched again?
      // TODO (fix): Do we need 100-expect support to provide a way to do this properly?
      agent.dispatch(opts, handler)
      return
    }

    const redirectHandler = new RedirectHandler({ agent: this, opts, handler })

    if (util.isStream(opts.body)) {
      opts.body
        .on('data', /* istanbul ignore next */ function () {
          /* istanbul ignore next */
          assert(false)
        })
        .on('error', function (err) {
          redirectHandler.destroy(err)
        })
        .on('end', function () {
          util.destroy(this)
        })
      opts.body = null
    }

    opts.maxRedirections = maxRedirections - 1

    agent.dispatch(opts, redirectHandler)
  }
}

function parseLocation (headers) {
  for (let i = 0; i < headers.length; i += 2) {
    if (headers[i].length === 8 && headers[i].toLowerCase() === 'location') {
      return headers[i + 1]
    }
  }
}

// https://tools.ietf.org/html/rfc7231#section-6.4.4
function shouldRemoveHeader (header, removeContent) {
  return (
    (header.length === 4 && header.toLowerCase() === 'host') ||
    (removeContent && header.toLowerCase().indexOf('content-') === 0)
  )
}

// https://tools.ietf.org/html/rfc7231#section-6.4
function cleanRequestHeaders (headers, removeContent) {
  const ret = []
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (!shouldRemoveHeader(headers[i], removeContent)) {
        ret.push(headers[i], headers[i + 1])
      }
    }
  } else if (headers && typeof headers === 'object') {
    for (const [key, val] of Object.entries(headers)) {
      if (!shouldRemoveHeader(key, removeContent)) {
        ret.push(key, val)
      }
    }
  } else if (headers != null) {
    throw new InvalidArgumentError('headers must be an object or an array')
  }
  return ret
}

module.exports.RedirectAgent = RedirectAgent
