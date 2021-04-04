'use strict'

const t = require('tap')
const { request } = require('..')
const RedirectHandler = require('../lib/handler/redirect')
const { InvalidArgumentError } = require('../lib/core/errors')
const { nop } = require('../lib/core/util')
const {
  startRedirectingServer,
  startRedirectingWithBodyServer,
  startRedirectingChainServers,
  startRedirectingWithoutLocationServer
} = require('./utils/redirecting-servers')
const { createReadable } = require('./utils/stream')

t.test('should not follow redirection by default if not using RedirectAgent', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}`)
  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 302)
  t.equal(headers.location, `http://${server}/302/1`)
  t.equal(body.length, 0)
})

t.test('should follow redirection after a HTTP 300', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/300?key=value`, {
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  /*
    TODO: Test for the redirect history once added to the callback data.

    [
      `http://${server}/300`,
      `http://${server}/300/1`,
      `http://${server}/300/2`,
      `http://${server}/300/3`,
      `http://${server}/300/4`
    ]
  */
  t.equal(body, `GET key=value :: connection@keep-alive host@${server}`)
})

t.test('should follow redirection after a HTTP 301', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/301`, {
    method: 'POST',
    body: 'REQUEST',
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  t.equal(body, `POST :: connection@keep-alive host@${server} content-length@7 :: REQUEST`)
})

t.test('should follow redirection after a HTTP 302', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/302`, {
    method: 'PUT',
    body: Buffer.from('REQUEST'),
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  t.equal(body, `PUT :: connection@keep-alive host@${server} content-length@7 :: REQUEST`)
})

t.test('should follow redirection after a HTTP 303 changing method to GET', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/303`, {
    method: 'PATCH',
    body: 'REQUEST',
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  t.equal(body, `GET :: connection@keep-alive host@${server}`)
})

t.test('should remove Host and request body related headers when following HTTP 303 (array)', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/303`, {
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
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  t.equal(body, `GET :: connection@keep-alive host@${server} x-foo1@1 x-foo2@2 x-foo3@3 x-bar@4`)
})

t.test('should remove Host and request body related headers when following HTTP 303 (object)', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/303`, {
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
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  t.equal(body, `GET :: connection@keep-alive host@${server} x-foo1@1 x-foo2@2 x-foo3@3 x-bar@4`)
})

t.test('should follow redirection after a HTTP 307', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/307`, {
    method: 'DELETE',
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  t.equal(body, `DELETE :: connection@keep-alive host@${server}`)
})

t.test('should follow redirection after a HTTP 308', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/308`, {
    method: 'OPTIONS',
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  t.equal(body, `OPTIONS :: connection@keep-alive host@${server}`)
})

t.test('should ignore HTTP 3xx response bodies', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingWithBodyServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/`, {
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  /*
    TODO: Test for the redirect history once added to the callback data.

    [`http://${server}/`]
  */
  t.equal(body, 'FINAL')
})

t.test('should follow a redirect chain up to the allowed number of times', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/300`, {
    maxRedirections: 2
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 300)
  t.equal(headers.location, `http://${server}/300/3`)
  /*
    TODO: Test for the redirect history once added to the callback data.

    [`http://${server}/300`, `http://${server}/300/1`]
  */
  t.equal(body.length, 0)
})

t.test('should follow redirections when going cross origin', async t => {
  t.plan(3)

  const [server1] = await startRedirectingChainServers(t)
  let body = ''

  const { statusCode, headers, body: bodyStream } = await request(`http://${server1}`, {
    method: 'POST',
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 200)
  t.notOk(headers.location)
  /*
    TODO: Test for the redirect history once added to the callback data.

    [
      `http://${server1}/`,
      `http://${server2}/`,
      `http://${server3}/`,
      `http://${server2}/end`,
      `http://${server3}/end`
    ]
  */
  t.equal(body, 'POST')
})

t.test('when a Location response header is NOT present', async t => {
  const redirectCodes = [300, 301, 302, 303, 307, 308]
  const server = await startRedirectingWithoutLocationServer(t)

  for (const code of redirectCodes) {
    t.test(`should return the original response after a HTTP ${code}`, async t => {
      t.plan(3)

      let body = ''

      const { statusCode, headers, body: bodyStream } = await request(`http://${server}/${code}`, {
        maxRedirections: 10
      })

      for await (const b of bodyStream) {
        body += b
      }

      t.equal(statusCode, code)
      t.notOk(headers.location)
      t.equal(body.length, 0)
    })
  }
})

t.test('should not allow invalid maxRedirections arguments', async t => {
  t.plan(1)

  try {
    await request('http://localhost:0', {
      method: 'GET',
      maxRedirections: 'INVALID'
    })

    throw new Error('Did not throw')
  } catch (error) {
    t.equal(error.message, 'maxRedirections must be a positive number')
  }
})

t.test('should not follow redirects when using Readable request bodies', async t => {
  t.plan(3)

  let body = ''
  const server = await startRedirectingServer(t)

  const { statusCode, headers, body: bodyStream } = await request(`http://${server}/301`, {
    method: 'POST',
    body: createReadable('REQUEST'),
    maxRedirections: 10
  })

  for await (const b of bodyStream) {
    body += b
  }

  t.equal(statusCode, 301)
  t.equal(headers.location, `http://${server}/301/1`)
  t.equal(body.length, 0)
})

t.test('should handle errors (callback)', t => {
  t.plan(1)

  request(
    'http://localhost:0',
    {
      maxRedirections: 10
    },
    error => {
      t.match(error.code, /EADDRNOTAVAIL|ECONNREFUSED/)
    }
  )
})

t.test('should handle errors (promise)', async t => {
  t.plan(1)

  try {
    await request('http://localhost:0', { maxRedirections: 10 })
    throw new Error('Did not throw')
  } catch (error) {
    t.match(error.code, /EADDRNOTAVAIL|ECONNREFUSED/)
  }
})

t.test('should complain for invalid headers', async t => {
  t.plan(1)

  const handler = new RedirectHandler('AGENT', { headers: 'ASD', origin: 'http://localhost' })

  t.throws(() => {
    handler.onHeaders(301, ['location', 'http://localhost'], nop)
  }, InvalidArgumentError, 'throws on invalid headers')
})
