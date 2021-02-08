# undici

![Node CI](https://github.com/mcollina/undici/workflows/Node%20CI/badge.svg)  [![js-standard-style](https://img.shields.io/badge/code%20style-standard-brightgreen.svg?style=flat)](http://standardjs.com/) [![npm version](https://badge.fury.io/js/undici.svg)](https://badge.fury.io/js/undici) [![codecov](https://codecov.io/gh/nodejs/undici/branch/master/graph/badge.svg)](https://codecov.io/gh/nodejs/undici)

A HTTP/1.1 client, written from scratch for Node.js.

> Undici means eleven in Italian. 1.1 -> 11 -> Eleven -> Undici.
It is also a Stranger Things reference.

<!--
Picture of Eleven
-->

## Install

```
npm i undici
```

## Benchmarks

Machine: AMD EPYC 7502P<br/>

Node 15
```
http - keepalive x 12,028 ops/sec ±2.60% (265 runs sampled)
undici - pipeline x 31,321 ops/sec ±0.77% (276 runs sampled)
undici - request x 36,612 ops/sec ±0.71% (277 runs sampled)
undici - stream x 41,291 ops/sec ±0.90% (268 runs sampled)
undici - dispatch x 47,319 ops/sec ±1.17% (263 runs sampled)
```

The benchmark is a simple `hello world` [example](benchmarks/index.js) using a
single unix socket with pipelining.

## Quick Start

```js
import { request } from 'undici'

const {
  statusCode,
  headers,
  trailers,
  body
} = await request('http://localhost:3000/foo')

console.log('response received', statusCode)
console.log('headers', headers)

for await (const data of body) {
  console.log('data', data)
}

console.log('trailers', trailers)
```

## API

<a name='client'></a>
### `new undici.Client(url, opts)`

A basic HTTP/1.1 client, mapped on top of a single TCP/TLS connection. Pipelining is disabled
by default.

`url` can be a string or a [`URL`](https://nodejs.org/api/url.html#url_class_url) object.
It should only include the protocol, hostname, and port.

Options:

- `socketPath: String|Null`, an IPC endpoint, either Unix domain socket or Windows named pipe.
  Default: `null`.

- `keepAliveTimeout: Number`, the timeout after which a socket without active requests
  will time out. Monitors time between activity on a connected socket.
  This value may be overridden by *keep-alive* hints from the server.
  Default: `4e3` milliseconds (4s).

- `keepAliveMaxTimeout: Number`, the maximum allowed `keepAliveTimeout` when overridden by
  *keep-alive* hints from the server.
  Default: `600e3` milliseconds (10min).

- `keepAliveTimeoutThreshold: Number`, a number subtracted from server *keep-alive* hints
  when overriding `keepAliveTimeout` to account for timing inaccuracies caused by e.g.
  transport latency.
  Default: `1e3` milliseconds (1s).

- `headersTimeout: Number`, the timeout after which a request will time out, in
  milliseconds. Monitors time between receiving complete headers.
  Use `0` to disable it entirely. Default: `30e3` milliseconds (30s).

- `bodyTimeout: Number`, the timeout after which a request will time out, in
  milliseconds. Monitors time between receiving body data.
  Use `0` to disable it entirely. Default: `30e3` milliseconds (30s).

- `pipelining: Number`, the amount of concurrent requests to be sent over the
  single TCP/TLS connection according to [RFC7230](https://tools.ietf.org/html/rfc7230#section-6.3.2).
  Carefully consider your workload and environment before enabling concurrent requests
  as pipelining may reduce performance if used incorrectly. Pipelining is sensitive 
  to network stack settings as well as head of line blocking caused by e.g. long running requests.
  Set to `0` to disable keep-alive connections.
  Default: `1`.

- `tls: Object|Null`, an options object which in the case of `https` will be passed to
  [`tls.connect`](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback).
  Default: `null`.

- `maxHeaderSize: Number`, the maximum length of request headers in bytes.
  Default: `16384` (16KiB).

<a name='request'></a>
#### `client.request(opts[, callback(err, data)]): Promise|Void`

Performs a HTTP request.

Options:

* `path: String`
* `method: String`
* `opaque: Any`
* `body: String|Buffer|Uint8Array|stream.Readable|Null`
  Default: `null`.
* `headers: Object|Array|Null`, an object with header-value pairs or an array with header-value pairs bi-indexed (`['header1', 'value1', 'header2', 'value2']`).
  Default: `null`.
* `signal: AbortSignal|EventEmitter|Null`
  Default: `null`.
* `idempotent: Boolean`, whether the requests can be safely retried or not.
  If `false` the request won't be sent until all preceding
  requests in the pipeline has completed.
  Default: `true` if `method` is `HEAD` or `GET`.
* `polling: Boolean`, whether the requests is long polling and not expected
  to finish in a timely fashion.
  Default: `true` if `accept` header is `text/event-stream`.

Headers are represented by an object like this:

```js
{
  'content-length': '123',
  'content-type': 'text/plain',
  connection: 'keep-alive',
  host: 'mysite.com',
  accept: '*/*'
}
```

Or an array like this:

```js
[
  'content-length', '123',
  'content-type', 'text/plain',
  'connection', 'keep-alive',
  'host', 'mysite.com',
  'accept', '*/*'
]
```

Keys are lowercased. Values are not modified.
If you don't specify a `host` header, it will be derived from the `url` of the client instance.

The `data` parameter in `callback` is defined as follow:

* `statusCode: Number`
* `opaque: Any`
* `headers: Object`, an object where all keys have been lowercased.
* `trailers: Object`, an object where all keys have been lowercased. This object start out
  as empty and will be mutated to contain trailers after `body` has emitted `'end'`.
* `body: stream.Readable` response payload. A user **must**
  either fully consume or destroy the body unless there is an error, or no further requests
  will be processed.

Returns a promise if no callback is provided.

Example:

```js
const { Client } = require('undici')
const client = new Client(`http://localhost:3000`)

client.request({
  path: '/',
  method: 'GET'
}, function (err, data) {
  if (err) {
    // handle this in some way!
    return
  }

  const {
    statusCode,
    headers,
    trailers,
    body
  } = data

  console.log('response received', statusCode)
  console.log('headers', headers)

  body.setEncoding('utf8')
  body.on('data', console.log)
  body.on('end', () => {
    console.log('trailers', trailers)
  })

  client.close()
})
```

Non-idempotent requests will not be pipelined in order
to avoid indirect failures.

Idempotent requests will be automatically retried if
they fail due to indirect failure from the request
at the head of the pipeline. This does not apply to
idempotent requests with a stream request body.

##### Aborting a request

A request can be aborted using either an `AbortController` or an `EventEmitter`.
To use `AbortController` in Node.js versions earlier than 15, you will need to
install a shim - `npm i abort-controller`.

```js
const { Client } = require('undici')

const client = new Client('http://localhost:3000')
const abortController = new AbortController()

client.request({
  path: '/',
  method: 'GET',
  signal: abortController.signal
}, function (err, data) {
  console.log(err) // RequestAbortedError
  client.close()
})

abortController.abort()
```

Alternatively, any `EventEmitter` that emits an `'abort'` event may be used as an abort controller:

```js
const EventEmitter = require('events')
const { Client } = require('undici')

const client = new Client('http://localhost:3000')
const ee = new EventEmitter()

client.request({
  path: '/',
  method: 'GET',
  signal: ee
}, function (err, data) {
  console.log(err) // RequestAbortedError
  client.close()
})

ee.emit('abort')
```

Destroying the request or response body will have the same effect.

<a name='stream'></a>
#### `client.stream(opts, factory(data)[, callback(err)]): Promise|Void`

A faster version of [`request`][request].

Unlike [`request`][request] this method expects `factory`
to return a [`Writable`](https://nodejs.org/api/stream.html#stream_class_stream_writable) which the response will be
written to. This improves performance by avoiding
creating an intermediate [`Readable`](https://nodejs.org/api/stream.html#stream_readable_streams) when the user
expects to directly pipe the response body to a
[`Writable`](https://nodejs.org/api/stream.html#stream_class_stream_writable).

Options:

* ... same as [`client.request(opts[, callback])`][request].

The `data` parameter in `factory` is defined as follow:

* `statusCode: Number`
* `headers: Object`, an object where all keys have been lowercased.
* `opaque: Any`

The `data` parameter in `callback` is defined as follow:

* `opaque: Any`
* `trailers: Object`, an object where all keys have been lowercased.

Returns a promise if no callback is provided.

```js
const { Client } = require('undici')
const client = new Client(`http://localhost:3000`)
const fs = require('fs')

client.stream({
  path: '/',
  method: 'GET',
  opaque: filename
}, ({ statusCode, headers, opaque: filename }) => {
  console.log('response received', statusCode)
  console.log('headers', headers)
  return fs.createWriteStream(filename)
}, (err) => {
  if (err) {
    console.error('failure', err)
  } else {
    console.log('success')
  }
})
```

`opaque` makes it possible to avoid creating a closure
for the `factory` method:

```js
function (req, res) {
   return client.stream({ ...opts, opaque: res }, proxy)
}
```

Instead of:

```js
function (req, res) {
   return client.stream(opts, (data) => {
     // Creates closure to capture `res`.
     proxy({ ...data, opaque: res })
   }
}
```

<a name='pipeline'></a>
#### `client.pipeline(opts, handler(data)): Duplex`

For easy use with [`stream.pipeline`](https://nodejs.org/api/stream.html#stream_stream_pipeline_source_transforms_destination_callback).

Options:

* ... same as [`client.request(opts, callback)`][request].
* `objectMode: Boolean`, `true` if the `handler` will return an object stream.
  Default: `false`

The `data` parameter in `handler` is defined as follow:

* `statusCode: Number`
* `headers: Object`, an object where all keys have been lowercased.
* `opaque: Any`
* `body: stream.Readable` response payload. A user **must**
  either fully consume or destroy the body unless there is an error, or no further requests
  will be processed.

`handler` should return a [`Readable`](https://nodejs.org/api/stream.html#stream_class_stream_readable) from which the result will be
read. Usually it should just return the `body` argument unless
some kind of transformation needs to be performed based on e.g.
`headers` or `statusCode`.

The `handler` should validate the response and save any
required state. If there is an error it should be thrown.

Returns a `Duplex` which writes to the request and reads from
the response.

```js
const { Client } = require('undici')
const client = new Client(`http://localhost:3000`)
const fs = require('fs')
const stream = require('stream')

stream.pipeline(
  fs.createReadStream('source.raw'),
  client.pipeline({
    path: '/',
    method: 'PUT',
  }, ({ statusCode, headers, body }) => {
    if (statusCode !== 201) {
      throw new Error('invalid response')
    }

    if (isZipped(headers)) {
      return pipeline(body, unzip(), () => {})
    }

    return body
  }),
  fs.createWriteStream('response.raw'),
  (err) => {
    if (err) {
      console.error('failed')
    } else {
      console.log('succeeded')
    }
  }
)
```

<a name='upgrade'></a>
#### `client.upgrade(opts[, callback(err, data)]): Promise|Void`

Upgrade to a different protocol.

Options:

* `path: String`
* `opaque: Any`
* `method: String`
  Default: `GET`
* `headers: Object|Null`, an object with header-value pairs.
  Default: `null`
* `signal: AbortSignal|EventEmitter|Null`.
  Default: `null`
* `protocol: String`, a string of comma separated protocols, in descending preference order.
  Default: `Websocket`.

The `data` parameter in `callback` is defined as follow:

* `headers: Object`, an object where all keys have been lowercased.
* `socket: Duplex`
* `opaque`

Returns a promise if no callback is provided.

<a name='connect'></a>
#### `client.connect(opts[, callback(err, data)]): Promise|Void`

Starts two-way communications with the requested resource.

Options:

* `path: String`
* `opaque: Any`
* `headers: Object|Null`, an object with header-value pairs.
  Default: `null`
* `signal: AbortSignal|EventEmitter|Null`.
  Default: `null`

The `data` parameter in `callback` is defined as follow:

* `statusCode: Number`
* `headers: Object`, an object where all keys have been lowercased.
* `socket: Duplex`
* `opaque: Any`

Returns a promise if no callback is provided.

<a name='dispatch'></a>
#### `client.dispatch(opts, handler): Void`

This is the low level API which all the preceding APIs are implemented on top of.

This API is expected to evolve through semver-major versions and is less stable
than the preceding higher level APIs. It is primarily intended for library developers
who implement higher level APIs on top of this.

Options:

* `path: String`
* `method: String`
* `body: String|Buffer|Uint8Array|stream.Readable|Null`
  Default: `null`.
* `headers: Object|Null`, an object with header-value pairs.
  Default: `null`.
* `idempotent: Boolean`, whether the requests can be safely retried or not.
  If `false` the request won't be sent until all preceding
  requests in the pipeline has completed.
  Default: `true` if `method` is `HEAD` or `GET`.

The `handler` parameter is defined as follow:

* `onConnect(abort)`, invoked before request is dispatched on socket.
  May be invoked multiple times when a request is retried when the request at the head of the pipeline fails.
  * `abort(): Void`, abort request.
* `onUpgrade(statusCode, headers, socket): Void`, invoked when request is upgraded  either due to a `Upgrade` header or `CONNECT` method.
  * `statusCode: Number`
  * `headers: Array|Null`
  * `socket: Duplex`
* `onHeaders(statusCode, headers, resume): Boolean`, invoked when statusCode and headers have been received.
  May be invoked multiple times due to 1xx informational headers.
  * `statusCode: Number`
  * `headers: Array|Null`, an array of key-value pairs. Keys are not automatically lowercased.
  * `resume(): Void`, resume `onData` after returning `false`.
* `onData(chunk): Boolean`, invoked when response payload data is received.
  * `chunk: Buffer`
* `onComplete(trailers): Void`, invoked when response payload and trailers have been received and the request has completed.
  * `trailers: Array|Null`
* `onError(err): Void`, invoked when an error has occurred.
  * `err: Error`

The caller is responsible for handling the `body` argument, in terms of `'error'` events and `destroy()`:ing up until
the `onConnect` handler has been invoked.

<a name='close'></a>
#### `client.close([callback]): Promise|Void`

Closes the client and gracefully waits for enqueued requests to
complete before invoking the callback.

Returns a promise if no callback is provided.

<a name='destroy'></a>
#### `client.destroy([err][, callback]): Promise|Void`

Destroy the client abruptly with the given `err`. All the pending and running
requests will be asynchronously aborted and error. Waits until socket is closed
before invoking the callback. Since this operation is asynchronously dispatched
there might still be some progress on dispatched requests.

Returns a promise if no callback is provided.

#### `client.url: URL`

Returns url passed to `undici.Pool(url, opts)`.

#### `client.pipelining: Number`

Property to get and set the pipelining factor.

#### `client.pending: Number`

Number of queued requests.

#### `client.running: Number`

Number of inflight requests.

#### `client.size: Number`

Number of pending and running requests.

#### `client.connected: Boolean`

True if the client has an active connection. The client will lazily
create a connection when it receives a request and will destroy it
if there is no activity for the duration of the `timeout` value.

#### `client.busy: Boolean`

True if pipeline is saturated or blocked. Indicates whether dispatching
further requests is meaningful.

#### `client.closed: Boolean`

True after `client.close()` has been called.

#### `client.destroyed: Boolean`

True after `client.destroyed()` has been called or `client.close()` has been
called and the client shutdown has completed.

#### Events

* `'drain'`, emitted when pipeline is no longer fully
  saturated.

* `'connect'`, emitted when a socket has been created and
  connected. The client will connect once `client.size > 0`.

* `'disconnect'`, emitted when socket has disconnected. The
  first argument of the event is the error which caused the
  socket to disconnect. The client will reconnect if or once
  `client.size > 0`.

<a name='pool'></a>
### `new undici.Pool(url, opts)`

A pool of [`Client`][] connected to the same upstream target.

Options:

* ... same as [`Client`][].
* `connections`, the number of clients to create.
  Default `10`.

`Pool` does not guarantee that requests are dispatched in
order of invocation.

#### `pool.url: URL`

Returns url passed to `undici.Pool(url, opts)`.

#### `pool.connected: Integer`

Number of active connections in pool.

#### `pool.pending: Number`

Number of queued requests.

#### `pool.busy: Boolean`

True if pool is saturated or blocked. Indicates whether dispatching
further requests is meaningful.

#### `pool.closed: Boolean`

True after `pool.close()` has been called.

#### `pool.destroyed: Boolean`

True after `pool.destroyed()` has been called or `pool.close()` has been
called and the client shutdown has completed.

#### `pool.request(opts[, callback]): Promise|Void`

Calls [`client.request(opts, callback)`][request] on one of the clients.

#### `pool.stream(opts, factory[, callback]): Promise|Void`

Calls [`client.stream(opts, factory, callback)`][stream] on one of the clients.

#### `pool.pipeline(opts, handler): Duplex`

Calls [`client.pipeline(opts, handler)`][pipeline] on one of the clients.

#### `pool.upgrade(opts[, callback]): Promise|Void`

Calls [`client.upgrade(opts, callback)`][upgrade] on one of the clients.

#### `pool.connect(opts[, callback]): Promise|Void`

Calls [`client.connect(opts, callback)`][connect] on one of the clients.

#### `pool.dispatch(opts, handler): Void`

Calls [`client.dispatch(opts, handler)`][dispatch] on one of the clients.

#### `pool.close([callback]): Promise|Void`

Calls [`client.close(callback)`](#close) on all the clients.

#### `pool.destroy([err][, callback]): Promise|Void`

Calls [`client.destroy(err, callback)`](#destroy) on all the clients.

#### Events

* `'drain'`, emitted when pool is no longer fully
  saturated.

* `'connect'`, emitted when a client has connected, the `Client`
    instance is passed as argument.

* `'disconnect'`, emitted when a client has disconnected. The first argument is the
   `Client` instance, the second is the the error that caused the disconnection.

<a name='agent'></a>
### `new undici.Agent(opts)`

* opts `undici.Pool.options` - options passed through to Pool constructor

Returns: `Agent`

Returns a new Agent instance for use with pool based requests or the following top-level methods `request`, `pipeline`, and `stream`.

#### `agent.get(origin): Pool`

* origin `string` - A pool origin to be retrieved from the Agent.

This method retrieves Pool instances from the Agent. If the pool does not exist it is automatically added. You do not need to manually close these pools as they are automatically removed using a WeakCache based on WeakRef and FinalizationRegistry.

The following methods `request`, `pipeline`, and `stream` utilize this feature.

#### `agent.close(): Promise`

Returns a `Promise.all` operation closing all of the pool instances in the Agent instance. This calls `pool.close` under the hood.

#### `agent.destroy(): Promise`

Returns a `Promise.all` operation destroying all of the pool instances in the Agent instance. This calls `pool.destroy` under the hood.

### `undici.setGlobalAgent(agent)`

* agent `Agent` 

Sets the global agent used by `request`, `pipeline`, and `stream` methods.

The default global agent creates `undici.Pool`s with no max number of
connections.

The agent must only **implement** the `Agent` API; not necessary extend from it.

### `undici.request(url[, opts]): Promise`

* url `string | URL | object`
* opts `{ agent: Agent } & client.request.opts`

`url` may contain path. `opts` may not contain path. `opts.method` is `GET` by default.

Calls `pool.request(opts)` on the pool returned from either the globalAgent (see [setGlobalAgent](#undicisetglobalagentagent)) or the agent passed to the `opts` argument.

Returns a promise with the result of the `request` method.

### `undici.stream(url, opts, factory): Promise`

* url `string | URL | object`
* opts `{ agent: Agent } & client.stream.opts`
* factory `client.stream.factory`

`url` may contain path. `opts` may not contain path.

See [client.stream](#clientstreamopts-factorydata-callbackerr-promisevoid) for details on the `opts` and `factory` arguments.

Calls `pool.stream(opts, factory)` on the pool returned from either the globalAgent (see [setGlobalAgent](#undicisetglobalagentagent)) or the agent passed to the `opts` argument.

Result is returned in the factory function. See [client.stream](#clientstreamopts-factorydata-callbackerr-promisevoid) for more details.

### `undici.pipeline(url, opts, handler): Duplex`

* url `string | URL | object`
* opts `{ agent: Agent } & client.pipeline.opts`
* handler `client.pipeline.handler`

`url` may contain path. `opts` may not contain path.

See [client.pipeline](#clientpipelineopts-handlerdata-duplex) for details on the `opts` and `handler` arguments.

Calls `pool.pipeline(opts, factory)` on the pool returned from either the globalAgent (see [setGlobalAgent](#undicisetglobalagentagent)) or the agent passed to the `opts` argument.

See [client.pipeline](#clientpipelineopts-handlerdata-duplex) for more details.

### `client.upgrade(opts[, callback(err, data)]): Promise|Void`

* url `string | URL | object`
* opts `{ agent: Agent } & client.upgrade.opts`

`url` may contain path. `opts` may not contain path.

### `client.connect(opts[, callback(err, data)]): Promise|Void`

* url `string | URL | object`
* opts `{ agent: Agent } & client.connect.opts`

`url` may contain path. `opts` may not contain path.

<a name='errors'></a>
### `undici.errors`

Undici exposes a variety of error objects that you can use to enhance your error handling.
You can find all the error objects inside the `errors` key.

```js
const { errors } = require('undici')
```

| Error                        | Error Codes                       | Description                                    |
| -----------------------------|-----------------------------------|------------------------------------------------|
| `InvalidArgumentError`       |  `UND_ERR_INVALID_ARG`            | passed an invalid argument.                    |
| `InvalidReturnValueError`    |  `UND_ERR_INVALID_RETURN_VALUE`   | returned an invalid value.                     |
| `RequestAbortedError`        |  `UND_ERR_ABORTED`                | the request has been aborted by the user       |
| `ClientDestroyedError`       |  `UND_ERR_DESTROYED`              | trying to use a destroyed client.              |
| `ClientClosedError`          |  `UND_ERR_CLOSED`                 | trying to use a closed client.                 |
| `SocketError`                |  `UND_ERR_SOCKET`                 | there is an error with the socket.             |
| `NotSupportedError`          |  `UND_ERR_NOT_SUPPORTED`          | encountered unsupported functionality.         |
| `ContentLengthMismatchError` |  `UND_ERR_CONTENT_LENGTH_MISMATCH`| body does not match content-length header      |
| `InformationalError`         |  `UND_ERR_INFO`                   | expected error with reason                     |
| `TrailerMismatchError`       |  `UND_ERR_TRAILER_MISMATCH`       | trailers did not match specification           |

## Specification Compliance

This section documents parts of the HTTP/1.1 specification which Undici does
not support or does not fully implement.

#### Expect

Undici does not support the `Expect` request header field. The request
body is  always immediately sent and the `100 Continue` response will be
ignored.

Refs: https://tools.ietf.org/html/rfc7231#section-5.1.1

### Pipelining

Uncidi will only use pipelining if configured with a `pipelining` factor
greater than `1`.

Undici always assumes that connections are persistent and will immediately
pipeline requests, without checking whether the connection is persistent.
Hence, automatic fallback to HTTP/1.0 or HTTP/1.1 without pipelining is
not supported.

Undici will immediately pipeline when retrying requests afters a failed
connection. However, Undici will not retry the first remaining requests in
the prior pipeline and instead error the corresponding callback/promise/stream.

Refs: https://tools.ietf.org/html/rfc2616#section-8.1.2.2<br/>
Refs: https://tools.ietf.org/html/rfc7230#section-6.3.2

## Collaborators

* [__Robert Nagy__](https://github.com/ronag), <https://www.npmjs.com/~ronag>

## License

MIT

[`Client`]: #client
[request]: #request
[stream]: #stream
[pipeline]: #pipeline
[upgrade]: #upgrade
[connect]: #connect
[dispatch]: #dispatch
