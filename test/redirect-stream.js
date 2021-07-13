'use strict'

const t = require('tap')
const { stream } = require('..')
const {
  startRedirectingServer,
  startRedirectingWithBodyServer,
  startRedirectingChainServers,
  startRedirectingWithoutLocationServer,
  startRedirectingWithAuthorization
} = require('./utils/redirecting-servers')
const { createReadable, createWritable } = require('./utils/stream')

t.test('should not follow redirection by default if not using RedirectAgent', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(`http://${server}`, { opaque: body }, ({ statusCode, headers, opaque }) => {
    t.equal(statusCode, 302)
    t.equal(headers.location, `http://${server}/302/1`)

    return createWritable(opaque)
  })

  t.equal(body.length, 0)
})

t.test('should follow redirection after a HTTP 300', async t => {
  t.plan(4)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}/300?key=value`,
    { opaque: body, maxRedirections: 10 },
    ({ statusCode, headers, opaque, context: { history } }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)
      t.same(history.map(x => x.toString()), [
        `http://${server}/300?key=value`,
        `http://${server}/300/1?key=value`,
        `http://${server}/300/2?key=value`,
        `http://${server}/300/3?key=value`,
        `http://${server}/300/4?key=value`
      ])

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), `GET key=value :: connection@keep-alive host@${server}`)
})

t.test('should follow redirection after a HTTP 301', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}/301`,
    { method: 'POST', body: 'REQUEST', opaque: body, maxRedirections: 10 },
    ({ statusCode, headers, opaque }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), `POST :: connection@keep-alive host@${server} content-length@7 :: REQUEST`)
})

t.test('should follow redirection after a HTTP 302', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}/302`,
    { method: 'PUT', body: Buffer.from('REQUEST'), opaque: body, maxRedirections: 10 },
    ({ statusCode, headers, opaque }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), `PUT :: connection@keep-alive host@${server} content-length@7 :: REQUEST`)
})

t.test('should follow redirection after a HTTP 303 changing method to GET', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(`http://${server}/303`, { opaque: body, maxRedirections: 10 }, ({ statusCode, headers, opaque }) => {
    t.equal(statusCode, 200)
    t.notOk(headers.location)

    return createWritable(opaque)
  })

  t.equal(body.join(''), `GET :: connection@keep-alive host@${server}`)
})

t.test('should remove Host and request body related headers when following HTTP 303 (array)', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}/303`,
    {
      method: 'PATCH',
      headers: [
        'Content-Encoding',
        'gzip',
        'X-Foo1',
        '1',
        'X-Foo2',
        '2',
        'Content-Type',
        'application/json',
        'X-Foo3',
        '3',
        'Host',
        'localhost',
        'X-Bar',
        '4'
      ],
      opaque: body,
      maxRedirections: 10
    },
    ({ statusCode, headers, opaque }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), `GET :: connection@keep-alive host@${server} x-foo1@1 x-foo2@2 x-foo3@3 x-bar@4`)
})

t.test('should remove Host and request body related headers when following HTTP 303 (object)', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}/303`,
    {
      method: 'PATCH',
      headers: {
        'Content-Encoding': 'gzip',
        'X-Foo1': '1',
        'X-Foo2': '2',
        'Content-Type': 'application/json',
        'X-Foo3': '3',
        Host: 'localhost',
        'X-Bar': '4'
      },
      opaque: body,
      maxRedirections: 10
    },
    ({ statusCode, headers, opaque }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), `GET :: connection@keep-alive host@${server} x-foo1@1 x-foo2@2 x-foo3@3 x-bar@4`)
})

t.test('should follow redirection after a HTTP 307', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}/307`,
    { method: 'DELETE', opaque: body, maxRedirections: 10 },
    ({ statusCode, headers, opaque }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), `DELETE :: connection@keep-alive host@${server}`)
})

t.test('should follow redirection after a HTTP 308', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}/308`,
    { method: 'OPTIONS', opaque: body, maxRedirections: 10 },
    ({ statusCode, headers, opaque }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), `OPTIONS :: connection@keep-alive host@${server}`)
})

t.test('should ignore HTTP 3xx response bodies', async t => {
  t.plan(4)

  const body = []
  const server = await startRedirectingWithBodyServer(t)

  await stream(
    `http://${server}/`,
    { opaque: body, maxRedirections: 10 },
    ({ statusCode, headers, opaque, context: { history } }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)
      t.same(history.map(x => x.toString()), [`http://${server}/`])

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), 'FINAL')
})

t.test('should follow a redirect chain up to the allowed number of times', async t => {
  t.plan(4)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}/300`,
    { opaque: body, maxRedirections: 2 },
    ({ statusCode, headers, opaque, context: { history } }) => {
      t.equal(statusCode, 300)
      t.equal(headers.location, `http://${server}/300/3`)
      t.same(history.map(x => x.toString()), [`http://${server}/300`, `http://${server}/300/1`])

      return createWritable(opaque)
    }
  )

  t.equal(body.length, 0)
})

t.test('should follow redirections when going cross origin', async t => {
  t.plan(4)

  const [server1, server2, server3] = await startRedirectingChainServers(t)
  const body = []

  await stream(
    `http://${server1}`,
    { method: 'POST', opaque: body, maxRedirections: 10 },
    ({ statusCode, headers, opaque, context: { history } }) => {
      t.equal(statusCode, 200)
      t.notOk(headers.location)
      t.same(history.map(x => x.toString()), [
        `http://${server1}/`,
        `http://${server2}/`,
        `http://${server3}/`,
        `http://${server2}/end`,
        `http://${server3}/end`
      ])

      return createWritable(opaque)
    }
  )

  t.equal(body.join(''), 'POST')
})

t.test('when a Location response header is NOT present', async t => {
  const redirectCodes = [300, 301, 302, 303, 307, 308]
  const server = await startRedirectingWithoutLocationServer(t)

  for (const code of redirectCodes) {
    t.test(`should return the original response after a HTTP ${code}`, async t => {
      t.plan(3)

      const body = []

      await stream(
        `http://${server}/${code}`,
        { opaque: body, maxRedirections: 10 },
        ({ statusCode, headers, opaque }) => {
          t.equal(statusCode, code)
          t.notOk(headers.location)

          return createWritable(opaque)
        }
      )

      t.equal(body.length, 0)
    })
  }
})

t.test('should not follow redirects when using Readable request bodies', async t => {
  t.plan(3)

  const body = []
  const server = await startRedirectingServer(t)

  await stream(
    `http://${server}`,
    {
      method: 'POST',
      body: createReadable('REQUEST'),
      opaque: body,
      maxRedirections: 10
    },
    ({ statusCode, headers, opaque }) => {
      t.equal(statusCode, 302)
      t.equal(headers.location, `http://${server}/302/1`)

      return createWritable(opaque)
    }
  )

  t.equal(body.length, 0)
})

t.test('should handle errors', async t => {
  t.plan(2)

  const body = []

  try {
    await stream('http://localhost:0', { opaque: body, maxRedirections: 10 }, ({ statusCode, headers, opaque }) => {
      return createWritable(opaque)
    })

    throw new Error('Did not throw')
  } catch (error) {
    t.match(error.code, /EADDRNOTAVAIL|ECONNREFUSED/)
    t.equal(body.length, 0)
  }
})

t.test('removes authorization header on third party origin', async t => {
  t.plan(1)

  const body = []

  const [server1] = await startRedirectingWithAuthorization(t, 'secret')
  await stream(`http://${server1}`, {
    maxRedirections: 10,
    opaque: body,
    headers: {
      authorization: 'secret'
    }
  }, ({ statusCode, headers, opaque }) => createWritable(opaque))

  t.equal(body.length, 0)
})
