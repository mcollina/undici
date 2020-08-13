'use strict'

const {
  InvalidArgumentError
} = require('./errors')
const { AsyncResource } = require('async_hooks')

class UpgradeHandler extends AsyncResource {
  constructor (opts, callback) {
    if (!opts || typeof opts !== 'object') {
      throw new InvalidArgumentError('invalid opts')
    }

    super('UNDICI_UPGRADE')

    this.opaque = opts.opaque || null
    this.callback = callback
  }

  onUpgrade (statusCode, headers, socket) {
    const { callback, opaque } = this

    this.callback = null
    this.runInAsyncScope(callback, null, null, {
      headers,
      socket,
      opaque
    })
  }

  onError (err) {
    const { callback, opaque } = this

    this.callback = null
    callback(err, { opaque })
  }
}

function upgrade (client, opts, callback) {
  if (callback === undefined) {
    return new Promise((resolve, reject) => {
      upgrade(client, opts, (err, data) => {
        return err ? reject(err) : resolve(data)
      })
    })
  }

  if (typeof callback !== 'function') {
    throw new InvalidArgumentError('invalid callback')
  }

  try {
    if (!opts || typeof opts !== 'object') {
      throw new InvalidArgumentError('invalid opts')
    }

    const {
      path,
      method,
      headers,
      servername,
      signal,
      requestTimeout,
      protocol
    } = opts
    client.dispatch({
      path,
      method: method || 'GET',
      headers,
      servername,
      signal,
      requestTimeout,
      upgrade: protocol || 'Websocket'
    }, new UpgradeHandler(opts, callback))
  } catch (err) {
    process.nextTick(callback, err, null)
  }
}

module.exports = {
  upgrade,
  UpgradeHandler
}
