'use strict'

const { readFileSync } = require('fs')
const { join } = require('path')
const https = require('https')
const crypto = require('crypto')
const { test } = require('tap')
const { Client, Pool } = require('..')
const { kSocket, kTLSOpts, kTLSSessionCache } = require('../lib/core/symbols')

const nodeMajor = Number(process.versions.node.split('.')[0])

const options = {
  key: readFileSync(join(__dirname, 'fixtures', 'key.pem'), 'utf8'),
  cert: readFileSync(join(__dirname, 'fixtures', 'cert.pem'), 'utf8')
}
const ca = readFileSync(join(__dirname, 'fixtures', 'ca.pem'), 'utf8')

test('A client should reuse its TLS session', { skip: nodeMajor < 11 }, t => {
  const clientSessions = {}
  let serverRequests = 0

  t.test('Prepare request', t => {
    t.plan(7)
    const server = https.createServer(options, (req, res) => {
      if (req.url === '/drop-key') {
        server.setTicketKeys(crypto.randomBytes(48))
      }
      serverRequests++
      res.end()
    })

    server.listen(0, function () {
      const client = new Client(`https://localhost:${server.address().port}`, {
        pipelining: 0,
        tls: {
          ca,
          rejectUnauthorized: false,
          maxCachedSessions: 1,
          servername: 'agent1'
        }
      })

      t.teardown(() => {
        client.close()
        server.close()
      })

      const queue = [{
        name: 'first',
        method: 'GET',
        path: '/'
      }, {
        name: 'first-reuse',
        method: 'GET',
        path: '/'
      }, {
        name: 'cipher-change',
        method: 'GET',
        path: '/',
        // Choose different cipher to use different cache entry
        ciphers: 'AES256-SHA'
      }, {
        // Change the ticket key to ensure session is updated in cache
        name: 'before-drop',
        method: 'GET',
        path: '/drop-key'
      }, {
        // Ticket will be updated starting from this
        name: 'after-drop',
        method: 'GET',
        path: '/'
      }, {
        name: 'after-drop-reuse',
        method: 'GET',
        path: '/'
      }]

      function request () {
        const options = queue.shift()
        if (options.ciphers) {
          // Choose different cipher to use different cache entry
          client[kTLSOpts].ciphers = options.ciphers
        } else {
          delete client[kTLSOpts].ciphers
        }
        client.request(options, (err, data) => {
          t.error(err)
          clientSessions[options.name] = client[kSocket].getSession()
          data.body.resume().on('end', () => {
            if (queue.length !== 0) {
              return request()
            }
            t.pass()
          })
        })
      }
      request()
    })
  })

  t.test('Verify cached sessions', t => {
    t.plan(7)
    t.strictEqual(serverRequests, 6)
    t.strictEqual(
      clientSessions.first.toString('hex'),
      clientSessions['first-reuse'].toString('hex')
    )
    t.notStrictEqual(
      clientSessions.first.toString('hex'),
      clientSessions['cipher-change'].toString('hex')
    )
    t.notStrictEqual(
      clientSessions.first.toString('hex'),
      clientSessions['before-drop'].toString('hex')
    )
    t.notStrictEqual(
      clientSessions['cipher-change'].toString('hex'),
      clientSessions['before-drop'].toString('hex')
    )
    t.notStrictEqual(
      clientSessions['before-drop'].toString('hex'),
      clientSessions['after-drop'].toString('hex')
    )
    t.strictEqual(
      clientSessions['after-drop'].toString('hex'),
      clientSessions['after-drop-reuse'].toString('hex')
    )
  })

  t.end()
})

test('A pool should be able to reuse TLS sessions between clients', { skip: nodeMajor < 11 }, t => {
  let serverRequests = 0

  const REQ_COUNT = 10
  t.test('Prepare request', t => {
    t.plan(4 + REQ_COUNT * 2)
    const server = https.createServer(options, (req, res) => {
      serverRequests++
      res.end()
    })
    server.on('error', err => console.error(err))

    server.listen(0, async () => {
      const poolWithSessionReuse = new Pool(`https://localhost:${server.address().port}`, {
        pipelining: 0,
        connections: 100,
        tls: {
          ca,
          rejectUnauthorized: false,
          maxCachedSessions: 1,
          servername: 'agent1',
          reuseSessions: true
        }
      })
      const poolWithoutSessionReuse = new Pool(`https://localhost:${server.address().port}`, {
        pipelining: 0,
        connections: 100,
        tls: {
          ca,
          rejectUnauthorized: false,
          maxCachedSessions: 1,
          servername: 'agent1',
          reuseSessions: false
        }
      })

      t.teardown(() => {
        poolWithSessionReuse.close()
        poolWithoutSessionReuse.close()
        server.close()
      })

      function request (pool, expectedSessionPoolMaxSize) {
        return new Promise((resolve, reject) => {
          const s = startDelay()
          pool.request({
            method: 'GET',
            path: '/'
          }, (err, data) => {
            const responseTime = endDelay(s)
            if (err) return reject(err)
            const numberOfCachedSessionsInPool = pool[kTLSSessionCache].size()
            t.ok(numberOfCachedSessionsInPool <= expectedSessionPoolMaxSize, `Expected the pool to cache no more then ${expectedSessionPoolMaxSize} sessions but got ${numberOfCachedSessionsInPool}`)
            data.body.resume().on('end', () => {
              resolve(responseTime)
            })
          })
        })
      }

      async function runRequests (pool, numIterations, expectedSessionPoolMaxSize) {
        const requests = []
        // For the session reuse, we first need one client to connect to receive a valid tls session to reuse
        const responseTime = await request(pool, expectedSessionPoolMaxSize)
        while (numIterations--) {
          requests.push(request(pool, expectedSessionPoolMaxSize))
        }
        return await Promise.all(requests).then(responseTimes => responseTimes.concat([responseTime]))
      }

      /* const responseTimesWithoutSessionReuse = */ await runRequests(poolWithoutSessionReuse, REQ_COUNT, REQ_COUNT)
      /* const responseTimesWithSessionReuse = */ await runRequests(poolWithSessionReuse, REQ_COUNT, 1)

      // const averageResponseTimeWithSessionReuse = responseTimesWithSessionReuse.reduce((sum, val) => sum + val, 0) / responseTimesWithSessionReuse.length
      // const averageResponseTimeWithoutSessionReuse = responseTimesWithoutSessionReuse.reduce((sum, val) => sum + val, 0) / responseTimesWithoutSessionReuse.length
      // t.ok(averageResponseTimeWithSessionReuse < averageResponseTimeWithoutSessionReuse, `Average request response time should be lower with session reuse enabled (${averageResponseTimeWithSessionReuse}ms) than without (${averageResponseTimeWithoutSessionReuse}ms)`)

      t.strictEqual(serverRequests, 2 + REQ_COUNT * 2)
      t.pass()
    })
  })

  t.end()
})

const startDelay = () => {
  return process.hrtime()
}

const endDelay = (hrtimeStart) => {
  const hrduration = process.hrtime(hrtimeStart)
  return hrduration[0] * 1e3 + hrduration[1] / 1e6
}
