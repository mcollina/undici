'use strict'

const { createServer } = require('http')

function startServer (t, handler) {
  return new Promise(resolve => {
    const server = createServer(handler)

    server.listen(0, () => {
      resolve(`localhost:${server.address().port}`)
    })

    t.teardown(server.close.bind(server))
  })
}

async function startRedirectingServer (t) {
  const server = await startServer(t, (req, res) => {
    // Parse the path and normalize arguments
    let [code, redirections, query] = req.url
      .slice(1)
      .split(/[/?]/)

    if (req.url.indexOf('?') !== -1 && !query) {
      query = redirections
      redirections = 0
    }

    code = parseInt(code, 10)
    redirections = parseInt(redirections, 10)

    if (isNaN(code) || code < 0) {
      code = 302
    }

    if (isNaN(redirections) || redirections < 0) {
      redirections = 0
    }

    // On 303, the method must be GET or HEAD after the first redirect
    if (code === 303 && redirections > 0 && req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 400
      res.setHeader('Connection', 'close')
      res.end('Did not switch to GET')
      return
    }

    // End the chain at some point
    if (redirections === 5) {
      res.setHeader('Connection', 'close')
      res.write(
        `${req.method}${query ? ` ${query}` : ''} :: ${Object.entries(req.headers)
          .map(([k, v]) => `${k}@${v}`)
          .join(' ')}`
      )

      if (parseInt(req.headers['content-length']) > 0) {
        res.write(' :: ')
        req.pipe(res)
      } else {
        res.end('')
      }

      return
    }

    // Redirect by default
    res.statusCode = code
    res.setHeader('Connection', 'close')
    res.setHeader('Location', `http://${server}/${code}/${++redirections}${query ? `?${query}` : ''}`)
    res.end('')
  })

  return server
}

async function startRedirectingWithBodyServer (t) {
  const server = await startServer(t, (req, res) => {
    if (req.url === '/') {
      res.statusCode = 301
      res.setHeader('Connection', 'close')
      res.setHeader('Location', `http://${server}/end`)
      res.end('REDIRECT')
      return
    }

    res.setHeader('Connection', 'close')
    res.end('FINAL')
  })

  return server
}

function startRedirectingWithoutLocationServer (t) {
  return startServer(t, (req, res) => {
    // Parse the path and normalize arguments
    let [code] = req.url
      .slice(1)
      .split('/')
      .map(r => parseInt(r, 10))

    if (isNaN(code) || code < 0) {
      code = 302
    }

    res.statusCode = code
    res.setHeader('Connection', 'close')
    res.end('')
  })
}

async function startRedirectingChainServers (t) {
  const server1 = await startServer(t, (req, res) => {
    if (req.url === '/') {
      res.statusCode = 301
      res.setHeader('Connection', 'close')
      res.setHeader('Location', `http://${server2}/`)
      res.end('')
      return
    }

    res.setHeader('Connection', 'close')
    res.end(req.method)
  })

  const server2 = await startServer(t, (req, res) => {
    res.statusCode = 301
    res.setHeader('Connection', 'close')

    if (req.url === '/') {
      res.setHeader('Location', `http://${server3}/`)
    } else {
      res.setHeader('Location', `http://${server3}/end`)
    }

    res.end('')
  })

  const server3 = await startServer(t, (req, res) => {
    res.statusCode = 301
    res.setHeader('Connection', 'close')

    if (req.url === '/') {
      res.setHeader('Location', `http://${server2}/end`)
    } else {
      res.setHeader('Location', `http://${server1}/end`)
    }

    res.end('')
  })

  return [server1, server2, server3]
}

async function startRedirectingWithAuthorization (t, authorization) {
  const server1 = await startServer(t, (req, res) => {
    if (req.headers.authorization !== authorization) {
      res.statusCode = 403
      res.setHeader('Connection', 'close')
      res.end('')
      return
    }

    res.statusCode = 301
    res.setHeader('Connection', 'close')

    res.setHeader('Location', `http://${server2}`)
    res.end('')
  })

  const server2 = await startServer(t, (req, res) => {
    res.end(req.headers.authorization || '')
  })

  return [server1, server2]
}

module.exports = {
  startServer,
  startRedirectingServer,
  startRedirectingWithBodyServer,
  startRedirectingWithoutLocationServer,
  startRedirectingChainServers,
  startRedirectingWithAuthorization
}
