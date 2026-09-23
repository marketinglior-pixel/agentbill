import type { FastifyRequest } from 'fastify'

// The console's query string stays out of the request log (2026-09-23).
//
// A console URL carries what the reader typed into it: the dollars_per_unit
// the tasks view converts at, a task_ref or an agent label in a filter. The
// page says the rate is saved to no account and to no part of the API, and
// Fastify's default request serializer was writing every URL, query and all,
// to the log Fly keeps. So a console URL is logged as its path and a marker;
// every other route logs as it always has. server.ts runs the same function
// on its two error lines, because a 4xx on /app would otherwise print the
// query anyway.
const CONSOLE_PATH = /^\/app(?:[/?]|$)/

export function logUrl(url: string): string {
  const q = url.indexOf('?')
  return q !== -1 && CONSOLE_PATH.test(url) ? `${url.slice(0, q)}?[omitted]` : url
}

/** Fastify's own request serializer (lib/logger-pino.js), field for field,
 *  with the URL passed through logUrl. */
export function reqSerializer(request: FastifyRequest) {
  return {
    method: request.method,
    url: logUrl(request.url),
    version: request.headers?.['accept-version'] as string | undefined,
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }
}
