'use strict'

const { test } = require('tap')
const http = require('http')
const { Client, Pool, errors } = require('..')
const stream = require('stream')

test('dispatch invalid opts', (t) => {
  t.plan(8)

  const client = new Client('http://localhost:5000')

  try {
    client.dispatch({
      path: '/',
      method: 'GET',
      upgrade: 1
    }, null)
  } catch (err) {
    t.type(err, errors.InvalidArgumentError)
    t.equal(err.message, 'handler must be an object')
  }

  try {
    client.dispatch({
      path: '/',
      method: 'GET',
      upgrade: 1
    }, 'asd')
  } catch (err) {
    t.type(err, errors.InvalidArgumentError)
    t.equal(err.message, 'handler must be an object')
  }

  client.dispatch({
    path: '/',
    method: 'GET',
    upgrade: 1
  }, {
    onError (err) {
      t.type(err, errors.InvalidArgumentError)
    }
  })

  client.dispatch({
    path: '/',
    method: 'GET',
    headersTimeout: 'asd'
  }, {
    onError (err) {
      t.type(err, errors.InvalidArgumentError)
    }
  })

  client.dispatch({
    path: '/',
    method: 'GET',
    bodyTimeout: 'asd'
  }, {
    onError (err) {
      t.type(err, errors.InvalidArgumentError)
    }
  })

  client.dispatch({
    origin: 'another',
    path: '/',
    method: 'GET',
    bodyTimeout: 'asd'
  }, {
    onError (err) {
      t.type(err, errors.InvalidArgumentError)
    }
  })
})

test('basic dispatch get', (t) => {
  t.plan(11)

  const server = http.createServer((req, res) => {
    t.equal('/', req.url)
    t.equal('GET', req.method)
    t.equal(`localhost:${server.address().port}`, req.headers.host)
    t.equal(undefined, req.headers.foo)
    t.equal('bar', req.headers.bar)
    t.equal('null', req.headers.baz)
    t.equal(undefined, req.headers['content-length'])
    res.end('hello')
  })
  t.teardown(server.close.bind(server))

  const reqHeaders = {
    foo: undefined,
    bar: 'bar',
    baz: null
  }

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    const bufs = []
    client.dispatch({
      path: '/',
      method: 'GET',
      headers: reqHeaders
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.equal(statusCode, 200)
        t.equal(Array.isArray(headers), true)
      },
      onData (buf) {
        bufs.push(buf)
      },
      onComplete (trailers) {
        t.same(trailers, [])
        t.equal('hello', Buffer.concat(bufs).toString('utf8'))
      },
      onError () {
        t.fail()
      }
    })
  })
})

test('trailers dispatch get', (t) => {
  t.plan(12)

  const server = http.createServer((req, res) => {
    t.equal('/', req.url)
    t.equal('GET', req.method)
    t.equal(`localhost:${server.address().port}`, req.headers.host)
    t.equal(undefined, req.headers.foo)
    t.equal('bar', req.headers.bar)
    t.equal(undefined, req.headers['content-length'])
    res.addTrailers({ 'Content-MD5': 'test' })
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('Trailer', 'Content-MD5')
    res.end('hello')
  })
  t.teardown(server.close.bind(server))

  const reqHeaders = {
    foo: undefined,
    bar: 'bar'
  }

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    const bufs = []
    client.dispatch({
      path: '/',
      method: 'GET',
      headers: reqHeaders
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.equal(statusCode, 200)
        t.equal(Array.isArray(headers), true)
        {
          const contentTypeIdx = headers.findIndex(x => x.toString() === 'Content-Type')
          t.equal(headers[contentTypeIdx + 1].toString(), 'text/plain')
        }
      },
      onData (buf) {
        bufs.push(buf)
      },
      onComplete (trailers) {
        t.equal(Array.isArray(trailers), true)
        {
          const contentMD5Idx = trailers.findIndex(x => x.toString() === 'Content-MD5')
          t.equal(trailers[contentMD5Idx + 1].toString(), 'test')
        }
        t.equal('hello', Buffer.concat(bufs).toString('utf8'))
      },
      onError () {
        t.fail()
      }
    })
  })
})

test('dispatch onHeaders error', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    res.end()
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    const _err = new Error()
    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        throw _err
      },
      onData (buf) {
        t.fail()
      },
      onComplete (trailers) {
        t.fail()
      },
      onError (err) {
        t.equal(err, _err)
      }
    })
  })
})

test('dispatch onComplete error', (t) => {
  t.plan(2)

  const server = http.createServer((req, res) => {
    res.end()
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    const _err = new Error()
    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.pass()
      },
      onData (buf) {
        t.fail()
      },
      onComplete (trailers) {
        throw _err
      },
      onError (err) {
        t.equal(err, _err)
      }
    })
  })
})

test('dispatch onData error', (t) => {
  t.plan(2)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    const _err = new Error()
    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.pass()
      },
      onData (buf) {
        throw _err
      },
      onComplete (trailers) {
        t.fail()
      },
      onError (err) {
        t.equal(err, _err)
      }
    })
  })
})

test('dispatch onConnect error', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    const _err = new Error()
    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
        throw _err
      },
      onHeaders (statusCode, headers) {
        t.fail()
      },
      onData (buf) {
        t.fail()
      },
      onComplete (trailers) {
        t.fail()
      },
      onError (err) {
        t.equal(err, _err)
      }
    })
  })
})

test('connect call onUpgrade once', (t) => {
  t.plan(2)

  const server = http.createServer((c) => {
    t.fail()
  })
  server.on('connect', (req, socket, firstBodyChunk) => {
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n')

    let data = firstBodyChunk.toString()
    socket.on('data', (buf) => {
      data += buf.toString()
    })

    socket.on('end', () => {
      socket.end(data)
    })
  })
  t.teardown(server.close.bind(server))

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    let recvData = ''
    let count = 0
    client.dispatch({
      method: 'CONNECT',
      path: '/'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.pass('should not throw')
      },
      onUpgrade (statusCode, headers, socket) {
        t.equal(count++, 0)

        socket.on('data', (d) => {
          recvData += d
        })

        socket.on('end', () => {
          t.equal(recvData.toString(), 'Body')
        })

        socket.write('Body')
        socket.end()
      },
      onData (buf) {
        t.fail()
      },
      onComplete (trailers) {
        t.fail()
      },
      onError () {
        t.fail()
      }
    })
  })
})

test('dispatch onConnect missing', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onHeaders (statusCode, headers) {
        t.pass('should not throw')
      },
      onData (buf) {
        t.pass('should not throw')
      },
      onComplete (trailers) {
        t.pass('should not throw')
      },
      onError (err) {
        t.equal(err.code, 'UND_ERR_INVALID_ARG')
      }
    })
  })
})

test('dispatch onHeaders missing', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onData (buf) {
        t.fail('should not throw')
      },
      onComplete (trailers) {
        t.fail('should not throw')
      },
      onError (err) {
        t.equal(err.code, 'UND_ERR_INVALID_ARG')
      }
    })
  })
})

test('dispatch onData missing', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.fail('should not throw')
      },
      onComplete (trailers) {
        t.fail('should not throw')
      },
      onError (err) {
        t.equal(err.code, 'UND_ERR_INVALID_ARG')
      }
    })
  })
})

test('dispatch onComplete missing', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.fail()
      },
      onData (buf) {
        t.fail()
      },
      onError (err) {
        t.equal(err.code, 'UND_ERR_INVALID_ARG')
      }
    })
  })
})

test('dispatch onError missing', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    try {
      client.dispatch({
        path: '/',
        method: 'GET'
      }, {
        onConnect () {
        },
        onHeaders (statusCode, headers) {
          t.fail()
        },
        onData (buf) {
          t.fail()
        },
        onComplete (trailers) {
          t.fail()
        }
      })
    } catch (err) {
      t.equal(err.code, 'UND_ERR_INVALID_ARG')
    }
  })
})

test('dispatch CONNECT onUpgrade missing', (t) => {
  t.plan(2)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.destroy.bind(client))

    client.dispatch({
      path: '/',
      method: 'GET',
      upgrade: 'Websocket'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
      },
      onError (err) {
        t.equal(err.code, 'UND_ERR_INVALID_ARG')
        t.equal(err.message, 'invalid onUpgrade method')
      }
    })
  })
})

test('dispatch upgrade onUpgrade missing', (t) => {
  t.plan(2)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    client.dispatch({
      path: '/',
      method: 'GET',
      upgrade: 'Websocket'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
      },
      onError (err) {
        t.equal(err.code, 'UND_ERR_INVALID_ARG')
        t.equal(err.message, 'invalid onUpgrade method')
      }
    })
  })
})

test('dispatch pool onError missing', (t) => {
  t.plan(2)

  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    try {
      client.dispatch({
        path: '/',
        method: 'GET',
        upgrade: 'Websocket'
      }, {
      })
    } catch (err) {
      t.equal(err.code, 'UND_ERR_INVALID_ARG')
      t.equal(err.message, 'invalid onError method')
    }
  })
})

test('dispatch onBodySent not a function', (t) => {
  t.plan(2)
  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))

    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onBodySent: '42',
      onConnect () {},
      onHeaders () {},
      onData () {},
      onError (err) {
        t.equal(err.code, 'UND_ERR_INVALID_ARG')
        t.equal(err.message, 'invalid onBodySent method')
      }
    })
  })
})

test('dispatch onBodySent buffer', (t) => {
  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))
    const body = 'hello 🚀'
    client.dispatch({
      path: '/',
      method: 'POST',
      body
    }, {
      onBodySent (chunk) {
        t.equal(chunk.toString(), body)
      },
      onError (err) {
        throw err
      },
      onConnect () {},
      onHeaders () {},
      onData () {},
      onComplete () {
        t.end()
      }
    })
  })
})

test('dispatch onBodySent stream', (t) => {
  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))
  const chunks = ['he', 'llo', 'world', '🚀']
  const toSendBytes = chunks.reduce((a, b) => a + Buffer.byteLength(b), 0)
  const body = stream.Readable.from(chunks)
  server.listen(0, () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))
    let sentBytes = 0
    let currentChunk = 0
    client.dispatch({
      path: '/',
      method: 'POST',
      body
    }, {
      onBodySent (chunk) {
        t.equal(chunks[currentChunk++], chunk)
        sentBytes += Buffer.byteLength(chunk)
      },
      onError (err) {
        throw err
      },
      onConnect () {},
      onHeaders () {},
      onData () {},
      onComplete () {
        t.equal(currentChunk, chunks.length)
        t.equal(sentBytes, toSendBytes)
        t.end()
      }
    })
  })
})

test('dispatch onBodySent async-iterable', (t) => {
  const server = http.createServer((req, res) => {
    res.end('ad')
  })
  t.teardown(server.close.bind(server))
  const chunks = ['he', 'llo', 'world', '🚀']
  const toSendBytes = chunks.reduce((a, b) => a + Buffer.byteLength(b), 0)
  server.listen(0, () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    t.teardown(client.close.bind(client))
    let sentBytes = 0
    let currentChunk = 0
    client.dispatch({
      path: '/',
      method: 'POST',
      body: chunks
    }, {
      onBodySent (chunk) {
        t.equal(chunks[currentChunk++], chunk)
        sentBytes += Buffer.byteLength(chunk)
      },
      onError (err) {
        throw err
      },
      onConnect () {},
      onHeaders () {},
      onData () {},
      onComplete () {
        t.equal(currentChunk, chunks.length)
        t.equal(sentBytes, toSendBytes)
        t.end()
      }
    })
  })
})
