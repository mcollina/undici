'use strict'

const { test } = require('tap')
const http = require('http')
const { Agent, request, stream, pipeline, setGlobalAgent } = require('../')
const { PassThrough } = require('stream')
const { InvalidArgumentError } = require('../lib/core/errors')
const { Client, Pool, errors } = require('../index')
const { promisify } = require('util')

test('setGlobalAgent', t => {
  t.plan(2)

  t.test('fails if agent does not implement `get` method', t => {
    t.plan(1)
    t.throw(() => setGlobalAgent({ get: 'not a function' }), InvalidArgumentError)
  })

  t.test('sets global agent', t => {
    t.plan(2)
    t.notThrow(() => setGlobalAgent(new Agent()))
    t.notThrow(() => setGlobalAgent({ get: () => {} }))
  })

  t.tearDown(() => {
    // reset globalAgent to a fresh Agent instance for later tests
    setGlobalAgent(new Agent())
  })
})

test('Agent', t => {
  t.plan(4)

  t.notThrow(() => new Agent())
  t.notThrow(() => new Agent({ connections: 5 }))
  t.throw(() => new Agent().get(), InvalidArgumentError)
  t.throw(() => new Agent().get(''), InvalidArgumentError)
})

test('agent should close internal pools', t => {
  t.plan(2)

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const agent = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { agent })
      .then(() => {
        t.pass('first request should resolve')
      })
      .catch(err => {
        t.fail(err)
      })

    const pool = agent.get(origin)
    pool.once('connect', () => {
      agent.close().then(() => {
        request(origin, { agent })
          .then(() => {
            t.fail('second request should not resolve')
          })
          .catch(err => {
            t.error(err instanceof errors.ClientClosedError)
          })
      })
    })
  })
})

test('agent should destroy internal pools', t => {
  t.plan(2)

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const agent = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { agent })
      .then(() => {
        t.fail()
      })
      .catch(err => {
        t.ok(err instanceof errors.ClientDestroyedError)
      })

    const pool = agent.get(origin)
    pool.once('connect', () => {
      agent.destroy().then(() => {
        request(origin, { agent })
          .then(() => {
            t.fail()
          })
          .catch(err => {
            t.ok(err instanceof errors.ClientDestroyedError)
          })
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
  t.tearDown(server.close.bind(server))

  server.listen(0, async () => {
    const origin = `http://localhost:${server.address().port}`
    const agent = new Agent({ connections })

    t.tearDown(agent.close.bind(agent))

    agent.on('connect', (client) => {
      t.ok(client)
    })
    agent.on('disconnect', (client, error) => {
      t.ok(client)
      t.true(error instanceof errors.InformationalError)
      t.strictEqual(error.code, 'UND_ERR_INFO')
      t.strictEqual(error.message, 'reset')
    })

    for (let i = 0; i < connections; i++) {
      await request(origin, { agent })
        .then(() => {
          t.pass('should pass')
        })
        .catch(err => {
          t.fail(err)
        })
    }
  })
})

test('remove disconnect listeners when destroyed', t => {
  t.plan(3)

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=1s'
    })
    res.end('ok')
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, async () => {
    const origin = `http://localhost:${server.address().port}`
    const agent = new Agent()

    t.tearDown(agent.close.bind(agent))

    const pool = agent.get(origin)
    t.true(pool.listeners('disconnect').length === 1)

    agent.on('disconnect', () => {
      t.true(pool.listeners('disconnect').length === 0)
    })

    await request(origin, { agent })
      .then(() => {
        t.pass('should pass')
      })
      .catch(err => {
        t.fail(err)
      })
  })
})

test('check if pool', async t => {
  t.plan(1)

  const server = http.createServer()
  t.tearDown(server.close.bind(server))
  await promisify(server.listen.bind(server))(0)

  const origin = `http://localhost:${server.address().port}`
  const agent = new Agent()

  t.tearDown(agent.close.bind(agent))

  const pool = agent.get(origin)
  t.true(pool instanceof Pool)
})

test('check if client', async t => {
  t.plan(1)

  const server = http.createServer()
  t.tearDown(server.close.bind(server))
  await promisify(server.listen.bind(server))(0)

  const origin = `http://localhost:${server.address().port}`
  const agent = new Agent({ connections: 1 })

  t.tearDown(agent.close.bind(agent))

  const pool = agent.get(origin)
  t.true(pool instanceof Client)
})

test('with globalAgent', t => {
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    t.strictEqual(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    request(`http://localhost:${server.address().port}`)
      .then(({ statusCode, headers, body }) => {
        t.strictEqual(statusCode, 200)
        t.strictEqual(headers['content-type'], 'text/plain')
        const bufs = []
        body.on('data', (buf) => {
          bufs.push(buf)
        })
        body.on('end', () => {
          t.strictEqual(wanted, Buffer.concat(bufs).toString('utf8'))
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
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    t.strictEqual(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.tearDown(server.close.bind(server))

  const agent = new Agent()

  server.listen(0, () => {
    request(`http://localhost:${server.address().port}`, { agent })
      .then(({ statusCode, headers, body }) => {
        t.strictEqual(statusCode, 200)
        t.strictEqual(headers['content-type'], 'text/plain')
        const bufs = []
        body.on('data', (buf) => {
          bufs.push(buf)
        })
        body.on('end', () => {
          t.strictEqual(wanted, Buffer.concat(bufs).toString('utf8'))
        })
      })
      .catch(err => {
        t.fail(err)
      })
  })
})

test('fails with invalid URL', t => {
  t.plan(4)
  t.throw(() => request(), InvalidArgumentError, 'throws on missing url argument')
  t.throw(() => request(''), TypeError, 'throws on invalid url')
  t.throw(() => request({}), InvalidArgumentError, 'throws on missing url.origin argument')
  t.throw(() => request({ origin: '' }), InvalidArgumentError, 'throws on invalid url.origin argument')
})

test('fails with unsupported opts.path', t => {
  t.plan(3)
  t.throw(() => request('https://example.com', { path: 'asd' }), InvalidArgumentError, 'throws on opts.path argument')
  t.throw(() => request('https://example.com', { path: '' }), InvalidArgumentError, 'throws on opts.path argument')
  t.throw(() => request('https://example.com', { path: 0 }), InvalidArgumentError, 'throws on opts.path argument')
})

test('with globalAgent', t => {
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    t.strictEqual(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    stream(
      `http://localhost:${server.address().port}`,
      {
        opaque: new PassThrough()
      },
      ({ statusCode, headers, opaque: pt }) => {
        t.strictEqual(statusCode, 200)
        t.strictEqual(headers['content-type'], 'text/plain')
        const bufs = []
        pt.on('data', (buf) => {
          bufs.push(buf)
        })
        pt.on('end', () => {
          t.strictEqual(wanted, Buffer.concat(bufs).toString('utf8'))
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
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    t.strictEqual(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.tearDown(server.close.bind(server))

  const agent = new Agent()

  server.listen(0, () => {
    stream(
      `http://localhost:${server.address().port}`,
      {
        agent,
        opaque: new PassThrough()
      },
      ({ statusCode, headers, opaque: pt }) => {
        t.strictEqual(statusCode, 200)
        t.strictEqual(headers['content-type'], 'text/plain')
        const bufs = []
        pt.on('data', (buf) => {
          bufs.push(buf)
        })
        pt.on('end', () => {
          t.strictEqual(wanted, Buffer.concat(bufs).toString('utf8'))
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
  t.throw(() => stream(), InvalidArgumentError, 'throws on missing url argument')
  t.throw(() => stream(''), TypeError, 'throws on invalid url')
  t.throw(() => stream({}), InvalidArgumentError, 'throws on missing url.origin argument')
  t.throw(() => stream({ origin: '' }), InvalidArgumentError, 'throws on invalid url.origin argument')
})

test('with globalAgent', t => {
  t.plan(6)
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    t.strictEqual(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const bufs = []

    pipeline(
      `http://localhost:${server.address().port}`,
      {},
      ({ statusCode, headers, body }) => {
        t.strictEqual(statusCode, 200)
        t.strictEqual(headers['content-type'], 'text/plain')
        return body
      }
    )
      .end()
      .on('data', buf => {
        bufs.push(buf)
      })
      .on('end', () => {
        t.strictEqual(wanted, Buffer.concat(bufs).toString('utf8'))
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
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    t.strictEqual(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.tearDown(server.close.bind(server))

  const agent = new Agent()

  server.listen(0, () => {
    const bufs = []

    pipeline(
      `http://localhost:${server.address().port}`,
      { agent },
      ({ statusCode, headers, body }) => {
        t.strictEqual(statusCode, 200)
        t.strictEqual(headers['content-type'], 'text/plain')
        return body
      }
    )
      .end()
      .on('data', buf => {
        bufs.push(buf)
      })
      .on('end', () => {
        t.strictEqual(wanted, Buffer.concat(bufs).toString('utf8'))
      })
      .on('error', () => {
        t.fail()
      })
  })
})

test('fails with invalid URL', t => {
  t.plan(4)
  t.throw(() => pipeline(), InvalidArgumentError, 'throws on missing url argument')
  t.throw(() => pipeline(''), TypeError, 'throws on invalid url')
  t.throw(() => pipeline({}), InvalidArgumentError, 'throws on missing url.origin argument')
  t.throw(() => pipeline({ origin: '' }), InvalidArgumentError, 'throws on invalid url.origin argument')
})

test('constructor validations', t => {
  t.plan(4)
  t.throw(() => new Agent({ factory: 'ASD' }), InvalidArgumentError, 'throws on invalid opts argument')
  t.throw(() => new Agent({ maxRedirections: 'ASD' }), InvalidArgumentError, 'throws on invalid opts argument')
  t.throw(() => new Agent({ maxRedirections: -1 }), InvalidArgumentError, 'throws on invalid opts argument')
  t.throw(() => new Agent({ maxRedirections: null }), InvalidArgumentError, 'throws on invalid opts argument')
})

test('dispatch validations', t => {
  const agent = new Agent()

  t.plan(1)
  t.throw(() => agent.dispatch('ASD'), InvalidArgumentError, 'throws on invalid opts argument')
})
