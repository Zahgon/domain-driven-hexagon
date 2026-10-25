import { IncomingMessage, ServerResponse } from 'http';
import * as bodyParser from 'body-parser';
import * as qs from 'qs';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyReply, FastifyRequest } from 'fastify';
import { graphqlHttpHandler, healthCheckHandler } from './graphql/graphql-http';

/**
 * The service was first written against the Express platform, and its HTTP
 * contract (body parsing, query parsing, route matching, error bodies) is the
 * one Express produced. These hooks keep that contract on Fastify.
 */

type RawRequest = IncomingMessage & {
  body?: unknown;
  routeMiss?: boolean;
  requestUrl?: string;
};

const GRAPHQL_PATH = '/graphql';
const HEALTH_PATH = '/.well-known/apollo/server-health';
const ALL_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];

interface RouteRule {
  methods: string[] | null;
  pattern: RegExp;
  target: (match: RegExpExecArray, search: string) => string | null;
}

const ROUTES: RouteRule[] = [
  {
    methods: null,
    pattern: /^\/\.well-known\/apollo\/server-health\/?(?=\/|$)/i,
    target: (_m, search) => HEALTH_PATH + search,
  },
  {
    methods: null,
    pattern: /^\/graphql\/?(?=\/|$)/i,
    target: (_m, search) => GRAPHQL_PATH + search,
  },
  {
    methods: ['GET', 'HEAD', 'POST'],
    pattern: /^\/v1\/users\/?$/i,
    target: (_m, search) => '/v1/users' + search,
  },
  {
    methods: ['DELETE'],
    pattern: /^\/v1\/users\/(?:([^/]+?))\/?$/i,
    target: (m, search) => {
      try {
        return '/v1/users/' + encodeURIComponent(decodeURIComponent(m[1])) + search;
      } catch {
        return null;
      }
    },
  },
];

const PASSTHROUGH = /^\/docs(?:-json|-yaml)?(?:\/|$)/;

/**
 * Express answers a path it cannot percent-decode with a 400 from its
 * middleware layer; Fastify would reject it before any hook runs, so such
 * requests are routed here and answered by the onRequest hook.
 */
const UNDECODABLE_PATH = '/.undecodable-path';

function splitUrl(url: string): [string, string] {
  const q = url.indexOf('?');
  return q < 0 ? [url, ''] : [url.slice(0, q), url.slice(q)];
}

/** Maps a request onto the route Express would have chosen for it. */
function rewriteUrl(req: RawRequest): string {
  const url = req.url ?? '/';
  req.requestUrl = url;
  const [path, search] = splitUrl(url);
  try {
    decodeURIComponent(path);
  } catch {
    return UNDECODABLE_PATH;
  }
  for (const rule of ROUTES) {
    if (rule.methods && !rule.methods.includes(req.method ?? '')) continue;
    const m = rule.pattern.exec(path);
    if (!m) continue;
    const target = rule.target(m, search);
    if (target !== null) return target;
  }
  if (!PASSTHROUGH.test(path)) req.routeMiss = true;
  return url;
}

export function createHttpAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    rewriteUrl: (req) => rewriteUrl(req as RawRequest),
    querystringParser: (str) => qs.parse(str, { allowPrototypes: true }),
  });
}

const parsedBodies = new WeakMap<IncomingMessage, unknown>();

const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

function runParser(
  parser: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown> {
  return new Promise((resolve) => parser(req, res, (err) => resolve(err)));
}

/** The error body Nest renders for an error raised before a route handler. */
function errorBody(err: any): { status: number; body: Record<string, unknown> } {
  if (err instanceof SyntaxError || err instanceof URIError) {
    return {
      status: 400,
      body: { statusCode: 400, message: err.message, error: 'Bad Request' },
    };
  }
  if (err?.statusCode && err?.message) {
    return {
      status: err.statusCode,
      body: { statusCode: err.statusCode, message: err.message },
    };
  }
  return {
    status: 500,
    body: { statusCode: 500, message: 'Internal server error' },
  };
}

function failedParam(path: string): URIError | null {
  const param = path.slice(1);
  try {
    decodeURIComponent(param);
    return null;
  } catch {
    return new URIError("Failed to decode param '" + param + "'");
  }
}

export function applyHttpCompatibility(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();

  instance.removeAllContentTypeParsers();
  instance.addContentTypeParser('*', (request, _payload, done) =>
    done(null, parsedBodies.get(request.raw)),
  );

  instance.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.raw as RawRequest;
    for (const parser of [jsonParser, urlencodedParser]) {
      const err = await runParser(parser, raw, reply.raw);
      if (err) {
        const { status, body } = errorBody(err);
        return reply.code(status).send(body);
      }
    }
    // Other onRequest hooks (middie) reassign raw.body, so keep our own copy.
    parsedBodies.set(raw, raw.body);
    const originalUrl = raw.requestUrl ?? raw.url ?? '/';
    const decodeError = failedParam(splitUrl(originalUrl)[0]);
    if (decodeError) {
      const { status, body } = errorBody(decodeError);
      return reply.code(status).send(body);
    }
    if (raw.routeMiss && !request.is404) {
      return reply.code(404).send({
        statusCode: 404,
        message: `Cannot ${request.method} ${originalUrl}`,
        error: 'Not Found',
      });
    }
  });

  instance.addHook('preValidation', async (request: FastifyRequest) => {
    request.body = parsedBodies.get(request.raw);
    (request.raw as RawRequest).body = request.body;
  });

  // Express adds the charset to every string body it sends.
  instance.addHook('onSend', async (_request, reply, payload) => {
    const type = reply.getHeader('content-type');
    if (
      typeof type === 'string' &&
      !/;\s*charset=/i.test(type) &&
      /^(text\/|application\/javascript)/.test(type)
    ) {
      reply.header('content-type', type + '; charset=utf-8');
    }
    return payload;
  });

  instance.route({
    method: ALL_METHODS,
    url: UNDECODABLE_PATH,
    exposeHeadRoute: false,
    handler: async () => {
      throw new URIError('undecodable path');
    },
  });

  instance.route({
    method: ALL_METHODS,
    url: GRAPHQL_PATH,
    exposeHeadRoute: false,
    handler: graphqlHttpHandler,
  });
  instance.route({
    method: ALL_METHODS,
    url: HEALTH_PATH,
    exposeHeadRoute: false,
    handler: healthCheckHandler,
  });
}
