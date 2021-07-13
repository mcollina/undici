'use strict'

const { test } = require('tap')
const http = require('http')
const { Agent, request, stream, pipeline, setGlobalDispatcher } = require('../')
const { PassThrough } = require('stream')
const { InvalidArgumentError } = require('../lib/core/errors')
const { errors } = require('../index')
const { kRunning } = require('../lib/core/symbols')

test('setGlobalDispatcher', t => {
  t.plan(2)

  t.test('fails if agent does not implement `get` method', t => {
    t.plan(1)
    t.throws(() => setGlobalDispatcher({ dispatch: 'not a function' }), InvalidArgumentError)
  })

  t.test('sets global agent', t => {
    t.plan(2)
    t.doesNotThrow(() => setGlobalDispatcher(new Agent()))
    t.doesNotThrow(() => setGlobalDispatcher({ dispatch: () => {} }))
  })

  t.teardown(() => {
    // reset globalAgent to a fresh Agent instance for later tests
    setGlobalDispatcher(new Agent())
  })
})

test('Agent', t => {
  t.plan(1)

  t.doesNotThrow(() => new Agent())
})

test('agent should call callback after closing internal pools', t => {
  t.plan(2)

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const dispatcher = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { dispatcher })
      .then(() => {
        t.pass('first request should resolve')
      })
      .catch(err => {
        t.fail(err)
      })

    dispatcher.once('connect', () => {
      dispatcher.close(() => {
        request(origin, { dispatcher })
          .then(() => {
            t.fail('second request should not resolve')
          })
          .catch(err => {
            t.type(err, errors.ClientClosedError)
          })
      })
    })
  })
})

test('agent close throws when callback is not a function', t => {
  t.plan(1)
  const dispatcher = new Agent()
  try {
    dispatcher.close({})
  } catch (err) {
    t.type(err, errors.InvalidArgumentError)
  }
})

test('agent should close internal pools', t => {
  t.plan(2)

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const dispatcher = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { dispatcher })
      .then(() => {
        t.pass('first request should resolve')
      })
      .catch(err => {
        t.fail(err)
      })

    dispatcher.once('connect', () => {
      dispatcher.close()
        .then(() => request(origin, { dispatcher }))
        .then(() => {
          t.fail('second request should not resolve')
        })
        .catch(err => {
          t.type(err, errors.ClientClosedError)
        })
    })
  })
})

test('agent should destroy internal pools and call callback', t => {
  t.plan(2)

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const dispatcher = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { dispatcher })
      .then(() => {
        t.fail()
      })
      .catch(err => {
        t.type(err, errors.ClientDestroyedError)
      })

    dispatcher.once('connect', () => {
      dispatcher.destroy(() => {
        request(origin, { dispatcher })
          .then(() => {
            t.fail()
          })
          .catch(err => {
            t.type(err, errors.ClientDestroyedError)
          })
      })
    })
  })
})

test('agent destroy throws when callback is not a function', t => {
  t.plan(1)
  const dispatcher = new Agent()
  try {
    dispatcher.destroy(new Error('mock error'), {})
  } catch (err) {
    t.type(err, errors.InvalidArgumentError)
  }
})

test('agent close/destroy callback with error', t => {
  t.plan(4)
  const dispatcher = new Agent()
  t.equal(dispatcher.closed, false)
  dispatcher.close()
  t.equal(dispatcher.closed, true)
  t.equal(dispatcher.destroyed, false)
  dispatcher.destroy(new Error('mock error'))
  t.equal(dispatcher.destroyed, true)
})

test('agent should destroy internal pools', t => {
  t.plan(2)

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const dispatcher = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { dispatcher })
      .then(() => {
        t.fail()
      })
      .catch(err => {
        t.type(err, errors.ClientDestroyedError)
      })

    dispatcher.once('connect', () => {
      dispatcher.destroy()
        .then(() => request(origin, { dispatcher }))
        .then(() => {
          t.fail()
        })
        .catch(err => {
          t.type(err, errors.ClientDestroyedError)
        })
    })
  })
})

test('multiple connections', t => {
  const connections = 3
  t.plan(6 * connections)

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=1s'
    })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, async () => {
    const origin = `http://localhost:${server.address().port}`
    const dispatcher = new Agent({ connections })

    t.teardown(dispatcher.close.bind(dispatcher))

    dispatcher.on('connect', (origin, [dispatcher]) => {
      t.ok(dispatcher)
    })
    dispatcher.on('disconnect', (origin, [dispatcher], error) => {
      t.ok(dispatcher)
      t.type(error, errors.InformationalError)
      t.equal(error.code, 'UND_ERR_INFO')
      t.equal(error.message, 'reset')
    })

    for (let i = 0; i < connections; i++) {
      await request(origin, { dispatcher })
        .then(() => {
          t.pass('should pass')
        })
        .catch(err => {
          t.fail(err)
        })
    }
  })
})

test('with globalAgent', t => {
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.equal('/', req.url)
    t.equal('GET', req.method)
    t.equal(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    request(`http://localhost:${server.address().port}`)
      .then(({ statusCode, headers, body }) => {
        t.equal(statusCode, 200)
        t.equal(headers['content-type'], 'text/plain')
        const bufs = []
        body.on('data', (buf) => {
          bufs.push(buf)
        })
        body.on('end', () => {
          t.equal(wanted, Buffer.concat(bufs).toString('utf8'))
        })
      })
      .catch(err => {
        t.fail(err)
      })
  })
})

test('with local agent', t => {
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.equal('/', req.url)
    t.equal('GET', req.method)
    t.equal(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  const dispatcher = new Agent()

  server.listen(0, () => {
    request(`http://localhost:${server.address().port}`, { dispatcher })
      .then(({ statusCode, headers, body }) => {
        t.equal(statusCode, 200)
        t.equal(headers['content-type'], 'text/plain')
        const bufs = []
        body.on('data', (buf) => {
          bufs.push(buf)
        })
        body.on('end', () => {
          t.equal(wanted, Buffer.concat(bufs).toString('utf8'))
        })
      })
      .catch(err => {
        t.fail(err)
      })
  })
})

test('fails with invalid args', t => {
  t.throws(() => request(), InvalidArgumentError, 'throws on missing url argument')
  t.throws(() => request(''), InvalidArgumentError, 'throws on invalid url')
  t.throws(() => request({}), InvalidArgumentError, 'throws on missing url.origin argument')
  t.throws(() => request({ origin: '' }), InvalidArgumentError, 'throws on invalid url.origin argument')
  t.throws(() => request('https://example.com', { path: 0 }), InvalidArgumentError, 'throws on opts.path argument')
  t.throws(() => request('https://example.com', { agent: new Agent() }), InvalidArgumentError, 'throws on opts.path argument')
  t.throws(() => request('https://example.com', 'asd'), InvalidArgumentError, 'throws on non object opts argument')
  t.end()
})

test('with globalAgent', t => {
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.equal('/', req.url)
    t.equal('GET', req.method)
    t.equal(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    stream(
      `http://localhost:${server.address().port}`,
      {
        opaque: new PassThrough()
      },
      ({ statusCode, headers, opaque: pt }) => {
        t.equal(statusCode, 200)
        t.equal(headers['content-type'], 'text/plain')
        const bufs = []
        pt.on('data', (buf) => {
          bufs.push(buf)
        })
        pt.on('end', () => {
          t.equal(wanted, Buffer.concat(bufs).toString('utf8'))
        })
        pt.on('error', () => {
          t.fail()
        })
        return pt
      }
    )
  })
})

test('with a local agent', t => {
  t.plan(9)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.equal('/', req.url)
    t.equal('GET', req.method)
    t.equal(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  const dispatcher = new Agent()

  dispatcher.on('connect', (origin, [dispatcher]) => {
    t.ok(dispatcher)
    t.equal(dispatcher[kRunning], 0)
    process.nextTick(() => {
      t.equal(dispatcher[kRunning], 1)
    })
  })

  server.listen(0, () => {
    stream(
      `http://localhost:${server.address().port}`,
      {
        dispatcher,
        opaque: new PassThrough()
      },
      ({ statusCode, headers, opaque: pt }) => {
        t.equal(statusCode, 200)
        t.equal(headers['content-type'], 'text/plain')
        const bufs = []
        pt.on('data', (buf) => {
          bufs.push(buf)
        })
        pt.on('end', () => {
          t.equal(wanted, Buffer.concat(bufs).toString('utf8'))
        })
        pt.on('error', () => {
          t.fail()
        })
        return pt
      }
    )
  })
})

test('fails with invalid URL', t => {
  t.plan(4)
  t.throws(() => stream(), InvalidArgumentError, 'throws on missing url argument')
  t.throws(() => stream(''), InvalidArgumentError, 'throws on invalid url')
  t.throws(() => stream({}), InvalidArgumentError, 'throws on missing url.origin argument')
  t.throws(() => stream({ origin: '' }), InvalidArgumentError, 'throws on invalid url.origin argument')
})

test('with globalAgent', t => {
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.equal('/', req.url)
    t.equal('GET', req.method)
    t.equal(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const bufs = []

    pipeline(
      `http://localhost:${server.address().port}`,
      {},
      ({ statusCode, headers, body }) => {
        t.equal(statusCode, 200)
        t.equal(headers['content-type'], 'text/plain')
        return body
      }
    )
      .end()
      .on('data', buf => {
        bufs.push(buf)
      })
      .on('end', () => {
        t.equal(wanted, Buffer.concat(bufs).toString('utf8'))
      })
      .on('error', () => {
        t.fail()
      })
  })
})

test('with a local agent', t => {
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.equal('/', req.url)
    t.equal('GET', req.method)
    t.equal(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.teardown(server.close.bind(server))

  const dispatcher = new Agent()

  server.listen(0, () => {
    const bufs = []

    pipeline(
      `http://localhost:${server.address().port}`,
      { dispatcher },
      ({ statusCode, headers, body }) => {
        t.equal(statusCode, 200)
        t.equal(headers['content-type'], 'text/plain')
        return body
      }
    )
      .end()
      .on('data', buf => {
        bufs.push(buf)
      })
      .on('end', () => {
        t.equal(wanted, Buffer.concat(bufs).toString('utf8'))
      })
      .on('error', () => {
        t.fail()
      })
  })
})

test('fails with invalid URL', t => {
  t.plan(4)
  t.throws(() => pipeline(), InvalidArgumentError, 'throws on missing url argument')
  t.throws(() => pipeline(''), InvalidArgumentError, 'throws on invalid url')
  t.throws(() => pipeline({}), InvalidArgumentError, 'throws on missing url.origin argument')
  t.throws(() => pipeline({ origin: '' }), InvalidArgumentError, 'throws on invalid url.origin argument')
})

test('constructor validations', t => {
  t.plan(4)
  t.throws(() => new Agent({ factory: 'ASD' }), InvalidArgumentError, 'throws on invalid opts argument')
  t.throws(() => new Agent({ maxRedirections: 'ASD' }), InvalidArgumentError, 'throws on invalid opts argument')
  t.throws(() => new Agent({ maxRedirections: -1 }), InvalidArgumentError, 'throws on invalid opts argument')
  t.throws(() => new Agent({ maxRedirections: null }), InvalidArgumentError, 'throws on invalid opts argument')
})

test('dispatch validations', t => {
  const dispatcher = new Agent()

  const noopHandler = {
    onError (err) {
      throw err
    }
  }

  t.plan(5)
  t.throws(() => dispatcher.dispatch('ASD'), InvalidArgumentError, 'throws on missing handler')
  t.throws(() => dispatcher.dispatch('ASD', noopHandler), InvalidArgumentError, 'throws on invalid opts argument type')
  t.throws(() => dispatcher.dispatch({}, noopHandler), InvalidArgumentError, 'throws on invalid opts.origin argument')
  t.throws(() => dispatcher.dispatch({ origin: '' }, noopHandler), InvalidArgumentError, 'throws on invalid opts.origin argument')
  t.throws(() => dispatcher.dispatch({}, {}), InvalidArgumentError, 'throws on invalid handler.onError')
})

test('drain', t => {
  t.plan(2)

  const dispatcher = new Agent({
    connections: 1,
    pipelining: 1
  })

  dispatcher.on('drain', () => {
    t.pass()
  })

  class Handler {
    onConnect () {}
    onHeaders () {}
    onData () {}
    onComplete () {}
    onError () {
      t.fail()
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end('asd')
  })

  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    t.equal(dispatcher.dispatch({
      origin: `http://localhost:${server.address().port}`,
      method: 'GET',
      path: '/'
    }, new Handler()), false)
  })
})

// Port 80 is no accessible on CI.
// test('agent works with port 80', t => {
//   t.plan(1)

//   const server = http.createServer((req, res) => {
//     res.setHeader('Content-Type', 'text/plain')
//     res.end()
//   })

//   t.teardown(server.close.bind(server))

//   server.listen(80, async () => {
//     const dispatcher = new Agent()

//     const origin = `http://localhost:${server.address().port}`

//     try {
//       const { body } = await dispatcher.request({ origin, method: 'GET', path: '/' })

//       body.on('end', () => {
//         t.pass()
//       }).resume()
//     } catch (err) {
//       t.error(err)
//     }
//   })
// })

test('global api', t => {
  t.plan(6 * 2)

  const server = http.createServer((req, res) => {
    if (req.url === '/bar') {
      t.equal(req.method, 'PUT')
      t.equal(req.url, '/bar')
    } else {
      t.equal(req.method, 'GET')
      t.equal(req.url, '/foo')
    }
    req.pipe(res)
  })

  t.teardown(server.close.bind(server))

  server.listen(0, async () => {
    const origin = `http://localhost:${server.address().port}`
    await request(origin, { path: '/foo' })
    await request(`${origin}/foo`)
    await request({ origin, path: '/foo' })
    await stream({ origin, path: '/foo' }, () => new PassThrough())
    await request({ protocol: 'http:', hostname: 'localhost', port: server.address().port, path: '/foo' })
    await request(`${origin}/bar`, { body: 'asd' })
  })
})

test('global api throws', t => {
  const origin = 'http://asd'
  t.throws(() => request(`${origin}/foo`, { path: '/foo' }), InvalidArgumentError)
  t.throws(() => request({ origin, path: 0 }, { path: '/foo' }), InvalidArgumentError)
  t.throws(() => request({ origin, pathname: 0 }, { path: '/foo' }), InvalidArgumentError)
  t.throws(() => request({ origin: 0 }, { path: '/foo' }), InvalidArgumentError)
  t.throws(() => request(0), InvalidArgumentError)
  t.throws(() => request(1), InvalidArgumentError)
  t.end()
})

test('unreachable request rejects and can be caught', t => {
  t.plan(1)

  request('https://thisis.not/avalid/url').catch(() => {
    t.pass()
  })
})
