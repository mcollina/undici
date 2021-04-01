/**
 * Minimal HTTP response parser using a wasm build of llhttp.
 * This is based on the work made by devsnek in https://github.com/devsnek/llhttp/tree/wasm
 *
 * The wasm build is currently imeplemented in a custom repo:
 * https://github.com/dnlup/llhttp/tree/undici_wasm
 */

'use strict'

/* global WebAssembly */

const { resolve } = require('path')
const { readFileSync } = require('fs')
const constants = require('./constants')
const { kMaxHeadersSize } = require('../core/symbols')
const WASM_BUILD = resolve(__dirname, './llhttp.wasm')
const bin = readFileSync(WASM_BUILD)
const mod = new WebAssembly.Module(bin)

const kOnMessageBegin = 0
const kOnHeaders = 1
const kOnHeadersComplete = 2
const kOnBody = 3
const kOnMessageComplete = 4
const kOnExecute = 5

const kPtr = Symbol('kPrt')
const kStatusMessage = Symbol('kStatusMessage')
const kHeadersFields = Symbol('kHeadersFields')
const kHeadersValues = Symbol('kHeadersValues')
const kHeaderSize = Symbol('kHeaderSize')
const kBufferSize = Symbol('kBufferSize')
const kBufferPtr = Symbol('kBufferPtr')
const kMallocBuffer = Symbol('kMallocBuffer')
const kCurrentBuffer = Symbol('kCurrentBuffer')
const kGetHeaders = Symbol('kGetHeaders')
const kTrackHeader = Symbol('kTrackHeader')
const kMakeError = Symbol('kMakeError')

/**
 * Current parser reference
 */
let currentParser = null

const cstr = (ptr, len) =>
  Buffer.from(inst.exports.memory.buffer, ptr, len).toString()

/* eslint-disable camelcase */
const wasm_on_message_begin = p => {
  currentParser[kStatusMessage] = null
  return currentParser[kOnMessageBegin]()
}

const wasm_on_url = (p, at, length) => {
  return 0
}

const wasm_on_status = (p, at, length) => {
  const ret = currentParser[kTrackHeader](length)
  if (ret !== 0) {
    return ret
  }
  currentParser[kStatusMessage] = cstr(at, length)
  return 0
}

const wasm_on_header_field = (p, at, length) => {
  // TODO: this could be optimized.
  // See https://github.com/nodejs/undici/pull/575#discussion_r589024917
  const ret = currentParser[kTrackHeader](length)
  if (ret !== 0) {
    return ret
  }
  currentParser[kHeadersFields].push(cstr(at, length))
  return 0
}

const wasm_on_header_value = (p, at, length) => {
  const ret = currentParser[kTrackHeader](length)
  if (ret !== 0) {
    return ret
  }
  currentParser[kHeadersValues].push(cstr(at, length))
  return 0
}

const wasm_on_headers_complete = p => {
  currentParser[kHeaderSize] = 0
  const versionMajor = inst.exports.llhttp_get_http_major(p)
  const versionMinor = inst.exports.llhttp_get_http_minor(p)
  const rawHeaders = currentParser[kGetHeaders]()
  const statusCode = inst.exports.llhttp_get_status_code(p)
  const statusMessage = currentParser[kStatusMessage]
  const upgrade = Boolean(inst.exports.llhttp_get_upgrade(p))
  const shouldKeepAlive = Boolean(inst.exports.llhttp_should_keep_alive(p))

  return currentParser[kOnHeadersComplete](versionMajor, versionMinor, rawHeaders, null,
    null, statusCode, statusMessage, upgrade, shouldKeepAlive)
}

const wasm_on_body = (p, at, length) => {
  // TODO: we could optimize this further by making this part responsibility fo the user.
  // Forcing them to consume the buffer synchronously or copy it otherwise.
  // See https://github.com/nodejs/undici/pull/575#discussion_r588885738
  const u8 = new Uint8Array(inst.exports.memory.buffer, at, length)
  const body = Buffer.from(u8) // llhttp re-uses buffer so we need to make a copy.
  currentParser[kOnBody](body, 0, body.length)
  return 0
}

const wasm_on_message_complete = (p) => {
  // Handle trailers
  if (currentParser[kHeadersFields].length) {
    currentParser[kOnHeaders](currentParser[kGetHeaders]())
  }
  const ret = currentParser[kOnMessageComplete]()
  return ret
}

/* eslint-enable camelcase */

const inst = new WebAssembly.Instance(mod, {
  env: {
    wasm_on_message_begin,
    wasm_on_url,
    wasm_on_status,
    wasm_on_header_field,
    wasm_on_header_value,
    wasm_on_headers_complete,
    wasm_on_body,
    wasm_on_message_complete
  }
})

inst.exports._initialize() // wasi reactor

class HTTPParserError extends Error {
  constructor (message, code) {
    super(message)
    Error.captureStackTrace(this, HTTPParserError)
    this.name = 'HTTPParserError'
    this.code = code ? `HPE_${code}` : undefined
  }
}

class HTTPParser {
  constructor (maxHeadersSize = 8 * 1024, lenient = false) {
    this[kPtr] = inst.exports.llhttp_alloc(constants.TYPE.RESPONSE)
    this[kBufferSize] = 0
    this[kBufferPtr] = null
    this[kCurrentBuffer] = null
    this[kStatusMessage] = null
    this[kHeadersFields] = []
    this[kHeadersValues] = []
    this[kMaxHeadersSize] = maxHeadersSize
    this[kHeaderSize] = 0

    if (lenient === true) {
      inst.exports.llhttp_set_lenient_headers(this[kPtr], 1)
    }
  }

  [kMallocBuffer] (size) {
    if (this[kBufferPtr]) {
      inst.exports.free(this[kBufferPtr])
    }
    this[kBufferSize] = size
    this[kBufferPtr] = inst.exports.malloc(size)
  }

  [kGetHeaders] () {
    const rawHeaders = []
    for (let c = 0; c < this[kHeadersFields].length; c++) {
      rawHeaders.push(this[kHeadersFields][c], this[kHeadersValues][c])
    }
    this[kHeadersFields] = []
    this[kHeadersValues] = []
    this[kHeaderSize] = 0
    return rawHeaders
  }

  [kTrackHeader] (length) {
    this[kHeaderSize] += length
    if (this[kHeaderSize] >= this[kMaxHeadersSize]) {
      inst.exports.llhttp_set_error_reason(this[kPtr], 'HPE_HEADER_OVERFLOW:Header overflow')
      return constants.ERROR.USER
    }
    return 0
  }

  [kOnMessageBegin] () {
    return 0
  }

  [kOnHeaders] (rawHeaders) {}

  [kOnHeadersComplete] (versionMajor, versionMinor, rawHeaders, method,
    url, statusCode, statusMessage, upgrade, shouldKeepAlive) {
    return 0
  }

  [kOnBody] (body) {
    return 0
  }

  [kOnMessageComplete] () {
    return 0
  }

  [kOnExecute] (ret) {}

  close () {
    inst.exports.llhttp_free(this[kPtr])
    this[kPtr] = null
    inst.exports.free(this[kBufferPtr])
    this[kBufferPtr] = null
    this[kCurrentBuffer] = Buffer.alloc(0)
  }

  execute (data) {
    currentParser = this
    this[kCurrentBuffer] = data
    // Be sure the parser buffer can contain `data`
    if (data.length > this[kBufferSize]) {
      this[kMallocBuffer](Math.ceil(data.length / 4096) * 4096)
    }
    // Instantiate a Unit8 Buffer view of the wasm memory that starts from the parser buffer pointer
    // and has the size of `data`
    const u8 = new Uint8Array(inst.exports.memory.buffer, this[kBufferPtr], data.length)
    // Fill the view with `data`
    u8.set(data)
    // Call `execute` on the wasm parser.
    // We pass the `llhttp_parser` pointer address, the pointer address of buffer view data,
    // and finally the length of bytes to parse.
    // The return value is an error code or `constants.ERROR.OK`.
    // See https://github.com/dnlup/llhttp/blob/undici_wasm/src/native/api.c#L106
    const err = inst.exports.llhttp_execute(this[kPtr], this[kBufferPtr], data.length)
    let ret = data.length
    if (err !== constants.ERROR.OK) {
      const errorPos = inst.exports.llhttp_get_error_pos(this[kPtr])
      ret = errorPos - this[kBufferPtr]
      if (err === constants.ERROR.PAUSED_UPGRADE) {
        inst.exports.llhttp_resume_after_upgrade(this[kPtr])
      } else {
        ret = this[kMakeError](err)
      }
    }
    this[kOnExecute](ret)
    currentParser = null
    return ret
  }

  getCurrentBuffer () {
    return this[kCurrentBuffer]
  }

  [kMakeError] (number) {
    const ptr = inst.exports.llhttp_get_error_reason(this[kPtr])
    const u8 = new Uint8Array(inst.exports.memory.buffer)
    const len = u8.indexOf(0, ptr) - ptr
    const message = cstr(ptr, len)
    const code = constants.ERROR[number]
    return new HTTPParserError(message, code)
  }
}

HTTPParser.kOnMessageBegin = kOnMessageBegin
HTTPParser.kOnHeaders = kOnHeaders
HTTPParser.kOnHeadersComplete = kOnHeadersComplete
HTTPParser.kOnBody = kOnBody
HTTPParser.kOnMessageComplete = kOnMessageComplete
HTTPParser.kOnExecute = kOnExecute

module.exports = HTTPParser
