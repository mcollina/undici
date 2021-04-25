"use strict";
/* eslint-disable no-unused-vars, max-len, id-length */

const assert = require("assert");
const { kUrl, kSocket, kHTTP2Opts } = require("./core/symbols");

const FRAME_TYPES = [
	"DATA", // standard request / response payloads
	"HEADERS", // starts stream, carries request headers
	"PRIORITY", // advises the priority of a stream
	"RST_STREAM", // immediately terminates a stream
	"SETTINGS", // inform other end of endpoint config
	"PUSH_PROMISE", // pre-warns peer of wanted streams
	"PING",
	"GOAWAY", // graceful version of RST_STREAM
	"WINDOW_UPDATE", // defines flow-control
	"CONTINUATION" // continue a sequence of headers
];

function parseHttp2Settings(settings) {
	// under RFC7540 section 3.2.1, the settings must be a base64url encoded
	// SETTINGS frame. 16 bit identifiers, 32 bit values. */
	let parsed = "";
	for (let i = 0; i < Object.keys(settings).length; i += 2) {
		parsed += `${settings[i]}${settings[i + 1]}\r\n`;
	}

	// base64url polyfill, courtesy of @panva
	let encoded;
	if (Buffer.isEncoding("base64url")) {
		encoded = Buffer.from(parsed)
			.toString("base64url")
			.replace(/[=]+$/g, "");
	} else {
		encoded = Buffer.from(parsed)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/[=]+$/g, "");
	}
	return encoded;
}

function http2Connect(client) {
	assert(!client[kSocket]);
	const { protocol, port, hostname, pathname } = client[kUrl];
	if (protocol === "https:") {
		throw new Error("Invalid protocol - httpConnect upgrades http streams");
	}
	// TODO: allow ALT-SVC
	client.upgrade({
		path: pathname,
		protocol: "h2c",
		headers: {
			"HTTP2-Settings": parseHttp2Settings(client[kHTTP2Opts] || {})
		}
	})
		.then((res) => {
			// upgrade successful, validate response and use http2
		})
		.catch((err) => {
			// continue as normal
		});
}

function https2Connect(client) {
	const { protocol, port, hostname } = client[kUrl];
	if (protocol === "http:") {
		throw new Error("Invalid protocol - https2Connect upgrades https streams");
	}
	// TODO: tls negotiation comes FIRST
}

module.exports = http2Connect;
