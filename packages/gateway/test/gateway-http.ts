import { request as httpRequest, type ClientRequest, type Server } from "node:http";
import { duplexPair, type Duplex, type Readable } from "node:stream";

/**
 * The gateway's HTTP seam, in this process.
 *
 * A gateway answers one public contract per route: a request target, a method, headers and a body in; a status, headers
 * and a body out. That contract is the server's own request parsing and routing, not the socket underneath it, so this
 * hands the server the connection a socket would have produced — server.emit("connection", host) — and speaks HTTP
 * over the pair directly. No port is bound, nothing on the machine can reach the fixture, and no other test's
 * listener can collide with it, while the assertions still read exactly what a network caller reads.
 */

/** One request a caller makes of a gateway. */
export type GatewayRequest = {
  readonly method: "GET" | "POST";
  /** The request target as the gateway reads it: path and query, as a socket would carry them. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The body the caller sends before the request ends. Omitted, the request ends with no body. */
  readonly body?: Uint8Array | string;
};

/** One answer the gateway gave: what a caller of the public route sees. */
export type GatewayResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Buffer };

/** A request in flight, for a caller that has to act while the gateway is still reading its body. */
export type GatewayExchange = {
  /** The answer, or a rejection when the connection ended before one arrived. */
  readonly response: Promise<GatewayResponse>;
  /** Send more of the body without ending the request. */
  write(bytes: Uint8Array): void;
  /** End the request body and wait for the answer. */
  end(): void;
  /** End the connection mid-body: what a caller that goes away does. */
  destroy(): void;
};

/** An answer handed back before its body is read, for a caller that streams it at its own pace. */
export type GatewayStream = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Readable };

/** A request whose body may still be arriving: a stream is forwarded as it is produced, never collected here. */
export type GatewayStreamRequest = Omit<GatewayRequest, "body"> & { readonly body?: Uint8Array | string | AsyncIterable<Uint8Array> };

export type GatewayHttp = {
  call(request: GatewayRequest): Promise<GatewayResponse>;
  start(request: GatewayRequest): GatewayExchange;
  /**
   * One request whose answer is returned while the gateway is still writing it. A caller that reads the body slowly
   * holds the gateway's own writes back, which is what a relay streaming a file to a browser does; a caller that
   * destroys it ends the host request. `call` collects the body instead and is the right choice for a small answer.
   */
  stream(request: GatewayStreamRequest): Promise<GatewayStream>;
  /** Drop every connection still open, so a fixture leaves nothing behind. */
  close(): void;
};

const flatten = (headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value ?? ""]));

/** Write a body that is still being produced into the connection, then end it: an upload as it arrives. */
async function writeBody(body: AsyncIterable<Uint8Array>, outgoing: ClientRequest): Promise<void> {
  try {
    for await (const chunk of body) outgoing.write(chunk);
  } finally {
    outgoing.end();
  }
}

export function gatewayHttp(server: Server): GatewayHttp {
  const sockets = new Set<Duplex>();
  const start = (request: GatewayRequest): GatewayExchange => {
    const [client, host] = duplexPair();
    sockets.add(client);
    sockets.add(host);
    const release = () => { sockets.delete(client); sockets.delete(host); };
    client.once("close", release);
    host.once("close", release);
    // The server is handed the connection it would have accepted: its own parsing, routing, status and headers run
    // unmodified, and only the transport below them is this process's memory.
    server.emit("connection", host);
    // The client speaks HTTP over the pair the server was handed. A supplied `createConnection` is what the connection
    // is opened from, so the name below is never resolved and never leaves this process: it is only the Host header.
    // (`agent: false` is the one setting that looks the name up instead, so it is deliberately not used here.)
    const outgoing = httpRequest({ host: "gateway.invalid", port: 80, method: request.method, path: request.path, headers: { ...request.headers }, createConnection: () => client });
    const response = new Promise<GatewayResponse>((resolve, reject) => {
      outgoing.on("response", (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => resolve({ status: answer.statusCode ?? 0, headers: flatten(answer.headers), body: Buffer.concat(chunks) }));
        answer.on("error", reject);
      });
      outgoing.on("error", reject);
    });
    // A caller that ends the connection mid-body has no answer to await; that rejection is the caller's own, reported
    // to whoever awaits it rather than as an unhandled one.
    void response.catch(() => undefined);
    return {
      response,
      write: (bytes) => { outgoing.write(bytes); },
      end: () => { outgoing.end(); },
      destroy: () => { outgoing.destroy(); client.destroy(); host.destroy(); },
    };
  };
  return {
    call: async (request) => {
      const exchange = start(request);
      if (request.body !== undefined) exchange.write(typeof request.body === "string" ? Buffer.from(request.body) : request.body);
      exchange.end();
      return await exchange.response;
    },
    start,
    // The same connection as `start`, resolved at the answer's head instead of at its end: the body below is the
    // server's own response stream, so nothing here reads a byte of it. The client is built exactly as `start` builds
    // it, supplied `createConnection` and no agent: an agent would look the name up instead of using this pair.
    stream: async (request) => {
      const [client, host] = duplexPair();
      sockets.add(client);
      sockets.add(host);
      const release = () => { sockets.delete(client); sockets.delete(host); };
      client.once("close", release);
      host.once("close", release);
      server.emit("connection", host);
      const outgoing = httpRequest({ host: "gateway.invalid", port: 80, method: request.method, path: request.path, headers: { ...request.headers }, createConnection: () => client });
      const body = request.body;
      if (body === undefined) outgoing.end();
      else if (typeof body === "string" || body instanceof Uint8Array) { outgoing.write(typeof body === "string" ? Buffer.from(body) : body); outgoing.end(); }
      else void writeBody(body, outgoing);
      return await new Promise<GatewayStream>((resolve, reject) => {
        outgoing.on("response", (answer) => {
          // A caller that walks away destroys the body it was reading, and that is the connection going away: the pair
          // ends with it, so the gateway's own response closes and its request is over rather than running on unwritten.
          answer.once("close", () => { client.destroy(); host.destroy(); });
          resolve({ status: answer.statusCode ?? 0, headers: flatten(answer.headers), body: answer });
        });
        outgoing.on("error", reject);
      });
    },
    close: () => { for (const socket of sockets) socket.destroy(); sockets.clear(); },
  };
}
