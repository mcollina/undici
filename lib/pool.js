'use strict'

const Dispatcher = require('./dispatcher')
const Client = require('./client')
const {
  ClientClosedError,
  InvalidArgumentError,
  ClientDestroyedError
} = require('./core/errors')
const FixedQueue = require('./node/fixed-queue')
const util = require('./core/util')
const { kSize, kRunning, kUrl, kPending, kBusy } = require('./core/symbols')
const assert = require('assert')
const makeConnect = require('./core/connect')

const kClients = Symbol('clients')
const kNeedDrain = Symbol('needDrain')
const kQueue = Symbol('queue')
const kDestroyed = Symbol('destroyed')
const kClosedPromise = Symbol('closed promise')
const kClosedResolve = Symbol('closed resolve')
const kOptions = Symbol('options')
const kOnDrain = Symbol('onDrain')
const kOnConnect = Symbol('onConnect')
const kOnDisconnect = Symbol('onDisconnect')
const kOnConnectionError = Symbol('onConnectionError')
const kConnections = Symbol('connections')
const kFactory = Symbol('factory')
const kQueued = Symbol('queued')

function defaultFactory (origin, opts) {
  return new Client(origin, opts)
}

class Pool extends Dispatcher {
  constructor (origin, {
    connections,
    factory = defaultFactory,
    connect,
    connectTimeout,
    tls,
    maxCachedSessions,
    socketPath,
    ...options
  } = {}) {
    super()

    if (connections != null && (!Number.isFinite(connections) || connections < 0)) {
      throw new InvalidArgumentError('invalid connections')
    }

    if (typeof factory !== 'function') {
      throw new InvalidArgumentError('factory must be a function.')
    }

    if (connect != null && typeof connect !== 'function' && typeof connect !== 'object') {
      throw new InvalidArgumentError('connect must be a function or an object')
    }

    if (typeof connect !== 'function') {
      connect = makeConnect({
        ...tls,
        maxCachedSessions,
        socketPath,
        timeout: connectTimeout == null ? 10e3 : connectTimeout,
        ...connect
      })
    }

    this[kConnections] = connections || null
    this[kUrl] = util.parseOrigin(origin)
    this[kOptions] = { ...util.deepClone(options), connect }
    this[kQueue] = new FixedQueue()
    this[kClosedPromise] = null
    this[kClosedResolve] = null
    this[kDestroyed] = false
    this[kClients] = []
    this[kNeedDrain] = false
    this[kQueued] = 0
    this[kFactory] = factory

    const pool = this

    this[kOnDrain] = function onDrain (url, targets) {
      assert(pool[kUrl].origin === url.origin)

      const queue = pool[kQueue]

      let needDrain = false

      while (!needDrain) {
        const item = queue.shift()
        if (!item) {
          break
        }
        pool[kQueued]--
        needDrain = !this.dispatch(item.opts, item.handler)
      }

      this[kNeedDrain] = needDrain

      if (!this[kNeedDrain] && pool[kNeedDrain]) {
        pool[kNeedDrain] = false
        pool.emit('drain', origin, [pool, ...targets])
      }

      if (pool[kClosedResolve] && queue.isEmpty()) {
        Promise
          .all(pool[kClients].map(c => c.close()))
          .then(pool[kClosedResolve])
      }
    }

    this[kOnConnect] = (origin, targets) => {
      pool.emit('connect', origin, [pool, ...targets])
    }

    this[kOnDisconnect] = (origin, targets, err) => {
      pool.emit('disconnect', origin, [pool, ...targets], err)
    }

    this[kOnConnectionError] = (origin, targets, err) => {
      pool.emit('connectionError', origin, [pool, ...targets], err)
    }
  }

  get [kBusy] () {
    return this[kNeedDrain]
  }

  get [kPending] () {
    let ret = this[kQueued]
    for (const { [kPending]: pending } of this[kClients]) {
      ret += pending
    }
    return ret
  }

  get [kRunning] () {
    let ret = 0
    for (const { [kRunning]: running } of this[kClients]) {
      ret += running
    }
    return ret
  }

  get [kSize] () {
    let ret = this[kQueued]
    for (const { [kSize]: size } of this[kClients]) {
      ret += size
    }
    return ret
  }

  get destroyed () {
    return this[kDestroyed]
  }

  get closed () {
    return this[kClosedPromise] != null
  }

  dispatch (opts, handler) {
    if (!handler || typeof handler !== 'object') {
      throw new InvalidArgumentError('handler must be an object')
    }

    try {
      if (this[kDestroyed]) {
        throw new ClientDestroyedError()
      }

      if (this[kClosedPromise]) {
        throw new ClientClosedError()
      }

      let dispatcher = this[kClients].find(dispatcher => !dispatcher[kNeedDrain])

      if (!dispatcher) {
        if (!this[kConnections] || this[kClients].length < this[kConnections]) {
          dispatcher = this[kFactory](this[kUrl], this[kOptions])
            .on('drain', this[kOnDrain])
            .on('connect', this[kOnConnect])
            .on('disconnect', this[kOnDisconnect])
            .on('connectionError', this[kOnConnectionError])
          this[kClients].push(dispatcher)
        }
      }

      if (!dispatcher) {
        this[kNeedDrain] = true
        this[kQueue].push({ opts, handler })
        this[kQueued]++
      } else if (!dispatcher.dispatch(opts, handler)) {
        dispatcher[kNeedDrain] = true
        this[kNeedDrain] = this[kConnections] && this[kClients].length === this[kConnections]
      }
    } catch (err) {
      if (typeof handler.onError !== 'function') {
        throw new InvalidArgumentError('invalid onError method')
      }

      handler.onError(err)
    }

    return !this[kNeedDrain]
  }

  close (cb) {
    try {
      if (this[kDestroyed]) {
        throw new ClientDestroyedError()
      }

      if (!this[kClosedPromise]) {
        if (this[kQueue].isEmpty()) {
          this[kClosedPromise] = Promise.all(this[kClients].map(c => c.close()))
        } else {
          this[kClosedPromise] = new Promise((resolve) => {
            this[kClosedResolve] = resolve
          })
        }
        this[kClosedPromise] = this[kClosedPromise].then(() => {
          this[kDestroyed] = true
        })
      }

      if (cb) {
        this[kClosedPromise].then(() => cb(null, null))
      } else {
        return this[kClosedPromise]
      }
    } catch (err) {
      if (cb) {
        cb(err)
      } else {
        return Promise.reject(err)
      }
    }
  }

  destroy (err, cb) {
    this[kDestroyed] = true

    if (typeof err === 'function') {
      cb = err
      err = null
    }

    if (!err) {
      err = new ClientDestroyedError()
    }

    while (true) {
      const item = this[kQueue].shift()
      if (!item) {
        break
      }
      item.handler.onError(err)
    }

    const promise = Promise.all(this[kClients].map(c => c.destroy(err)))
    if (cb) {
      promise.then(() => cb(null, null))
    } else {
      return promise
    }
  }
}

module.exports = Pool
