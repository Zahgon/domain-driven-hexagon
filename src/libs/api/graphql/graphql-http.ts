import { createHash } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ASTVisitor,
  DocumentNode,
  ExecutionResult,
  getOperationAST,
  GraphQLError,
  GraphQLSchema,
  Kind,
  OperationDefinitionNode,
  parse,
  specifiedRules,
  validate,
  ValidationContext,
} from 'graphql';

/**
 * HTTP transport for the GraphQL endpoint. Operations execute on Mercurius;
 * the request and response contract (status codes, error extensions,
 * persisted queries, batching, CORS) is the one clients of this service
 * already rely on.
 */

type Extensions = Record<string, unknown>;

interface FormattedError {
  message: string;
  locations?: unknown;
  path?: unknown;
  extensions: Extensions;
}

interface GraphQLResponse {
  data?: unknown;
  errors?: FormattedError[];
  extensions?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

interface RequestParams {
  query?: unknown;
  operationName?: unknown;
  variables?: unknown;
  extensions?: any;
}

class HttpQueryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

const PERSISTED_QUERIES = new Map<string, string>();

const INTROSPECTION_MESSAGE =
  'GraphQL introspection is not allowed by Apollo Server, but the query contained __schema or __type. To enable introspection, pass introspection: true to ApolloServer in production';

function NoIntrospection(context: ValidationContext): ASTVisitor {
  return {
    Field(node) {
      if (node.name.value === '__schema' || node.name.value === '__type') {
        context.reportError(new GraphQLError(INTROSPECTION_MESSAGE, { nodes: [node] }));
      }
    },
  };
}

function validationRules() {
  return process.env.NODE_ENV === 'production'
    ? [...specifiedRules, NoIntrospection]
    : specifiedRules;
}

function printable(
  message: string,
  extensions: Extensions,
  locations?: unknown,
  path?: unknown,
): FormattedError {
  return {
    message,
    ...(locations ? { locations } : {}),
    ...(path ? { path } : {}),
    extensions,
  };
}

/** An error reported with a fixed code and no exception details. */
function coded(error: { message: string; locations?: unknown; path?: unknown }, code: string): FormattedError {
  return printable(error.message, { code }, error.locations, error.path);
}

const PREDEFINED_CODES: Record<number, string> = {
  400: 'BAD_USER_INPUT',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
};

/** An error raised while executing an operation, carrying its cause. */
function fromExecution(error: GraphQLError): FormattedError {
  const extensions: Extensions = { ...(error.extensions as Extensions) };
  const exception: Record<string, any> = {
    ...((error.extensions as any)?.exception ?? {}),
    ...(error.originalError ?? {}),
  };
  delete exception.extensions;
  extensions.code = extensions.code || 'INTERNAL_SERVER_ERROR';
  if (Object.keys(exception).length > 0) extensions.exception = exception;
  if (exception.response?.statusCode && exception.status) {
    const status = exception.status;
    return printable(exception.message, {
      code: PREDEFINED_CODES[status] ?? String(status),
      response: exception.response,
    });
  }
  return printable(error.message, extensions, error.locations, error.path);
}

function isBadUserInput(error: GraphQLError): boolean {
  const node = error.nodes?.length === 1 ? error.nodes[0] : undefined;
  if (!node || node.kind !== Kind.VARIABLE_DEFINITION) return false;
  const prefix = `Variable "$${node.variable.name.value}" `;
  return ['got invalid value ', 'of required type ', 'of non-null type '].some((tail) =>
    error.message.startsWith(prefix + tail),
  );
}

function formatResultErrors(errors: readonly GraphQLError[]): FormattedError[] {
  return errors.map((error) =>
    isBadUserInput(error) ? coded(error, 'BAD_USER_INPUT') : fromExecution(error),
  );
}

function internal(message: string): GraphQLResponse {
  return { errors: [coded({ message }, 'INTERNAL_SERVER_ERROR')] };
}

function parseRequest(params: RequestParams): RequestParams {
  let extensions = params.extensions;
  if (typeof extensions === 'string' && extensions !== '') {
    try {
      extensions = JSON.parse(extensions);
    } catch {
      throw new HttpQueryError(400, 'Extensions are invalid JSON.');
    }
  }
  const query = params.query;
  if (query && typeof query !== 'string') {
    if ((query as any).kind === 'Document') {
      throw new HttpQueryError(
        400,
        "GraphQL queries must be strings. It looks like you're sending the " +
          'internal graphql-js representation of a parsed query in your ' +
          'request instead of a request in the GraphQL query language. You ' +
          'can convert an AST to a string using the `print` function from ' +
          '`graphql`, or use a client like `apollo-client` which converts ' +
          'the internal representation to a string for you.',
      );
    }
    throw new HttpQueryError(400, 'GraphQL queries must be strings.');
  }
  let variables = params.variables;
  if (typeof variables === 'string' && variables !== '') {
    try {
      variables = JSON.parse(variables);
    } catch {
      throw new HttpQueryError(400, 'Variables are invalid JSON.');
    }
  }
  return { query, operationName: params.operationName, variables, extensions };
}

async function execute(
  app: FastifyInstance,
  query: string,
  variables: unknown,
  operationName: unknown,
): Promise<ExecutionResult> {
  try {
    return await app.graphql(query, {}, variables as any, operationName as any);
  } catch (err: any) {
    if (err?.code === 'MER_ERR_GQL_VALIDATION' && Array.isArray(err.errors)) {
      return { errors: err.errors };
    }
    return { errors: [err] };
  }
}

async function processRequest(
  app: FastifyInstance,
  method: string,
  request: RequestParams,
): Promise<GraphQLResponse> {
  let query = request.query as string | undefined;
  const extensions = request.extensions;
  let queryHash: string | undefined;
  let register = false;

  if (extensions?.persistedQuery) {
    if (extensions.persistedQuery.version !== 1) {
      return internal('Unsupported persisted query version');
    }
    queryHash = extensions.persistedQuery.sha256Hash;
    if (query === undefined) {
      query = PERSISTED_QUERIES.get(queryHash as string);
      if (!query) {
        return {
          errors: [coded({ message: 'PersistedQueryNotFound' }, 'PERSISTED_QUERY_NOT_FOUND')],
          status: 200,
          headers: { 'Cache-Control': 'private, no-cache, must-revalidate' },
        };
      }
    } else {
      if (createHash('sha256').update(query).digest('hex') !== queryHash) {
        return internal('provided sha does not match query');
      }
      register = true;
    }
  } else if (!query) {
    return internal(
      'GraphQL operations must contain a non-empty `query` or a `persistedQuery` extension.',
    );
  }

  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (syntaxError) {
    return { errors: [coded(syntaxError as GraphQLError, 'GRAPHQL_PARSE_FAILED')] };
  }
  const schema = (app.graphql as unknown as { schema: GraphQLSchema }).schema;
  const validationErrors = validate(schema, document, validationRules());
  if (validationErrors.length > 0) {
    return { errors: validationErrors.map((e) => coded(e, 'GRAPHQL_VALIDATION_FAILED')) };
  }

  const operation =
    getOperationAST(document, request.operationName as string | undefined) || undefined;
  if (method === 'GET') {
    try {
      if ((operation as OperationDefinitionNode).operation !== 'query') {
        return {
          ...internal('GET supports only query operation'),
          status: 405,
          headers: { Allow: 'POST' },
        };
      }
    } catch (err) {
      return internal((err as Error).message);
    }
  }
  if (register && queryHash !== undefined) {
    PERSISTED_QUERIES.set(queryHash, query);
  }

  const result = await execute(app, query, request.variables, request.operationName);
  return {
    data: result.data,
    errors: result.errors ? formatResultErrors(result.errors) : undefined,
    extensions: result.extensions,
  };
}

function serialize(response: GraphQLResponse) {
  return { errors: response.errors, data: response.data, extensions: response.extensions };
}

function sendJson(reply: FastifyReply, status: number, headers: Record<string, string>, body: unknown) {
  reply.code(status);
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  reply.header('Content-Type', 'application/json; charset=utf-8');
  return reply.send(JSON.stringify(body) + '\n');
}

async function processHttpRequest(request: FastifyRequest, reply: FastifyReply) {
  const app = request.server;
  const method = request.method;
  let payload: any;
  if (method === 'POST') {
    payload = request.body;
    if (
      !payload ||
      typeof payload === 'string' ||
      Buffer.isBuffer(payload) ||
      Object.keys(payload).length === 0
    ) {
      throw new HttpQueryError(
        400,
        'POST body missing, invalid Content-Type, or JSON object has no keys.',
      );
    }
  } else if (method === 'GET') {
    payload = request.query;
    if (!payload || Object.keys(payload).length === 0) {
      throw new HttpQueryError(400, 'GET query missing.');
    }
  } else {
    throw new HttpQueryError(405, 'Apollo Server supports only GET/POST requests.', {
      Allow: 'GET, POST',
    });
  }

  if (Array.isArray(payload)) {
    const requests = payload.map((params) => parseRequest(params ?? {}));
    const headers: Record<string, string> = {};
    let status = 200;
    const responses = await Promise.all(
      requests.map(async (params) => {
        try {
          const response = await processRequest(app, method, params);
          Object.assign(headers, response.headers);
          if (response.status) status = response.status;
          return response;
        } catch (err) {
          return { errors: [fromExecution(err as GraphQLError)] };
        }
      }),
    );
    return sendJson(reply, status, headers, responses.map(serialize));
  }

  const response = await processRequest(app, method, parseRequest(payload));
  if (response.errors && response.data === undefined) {
    const body: Record<string, unknown> = { errors: response.errors };
    if (response.extensions) body.extensions = response.extensions;
    return sendJson(reply, response.status || 400, response.headers ?? {}, body);
  }
  return sendJson(reply, response.status || 200, response.headers ?? {}, serialize(response));
}

export async function graphqlHttpHandler(request: FastifyRequest, reply: FastifyReply) {
  reply.header('Access-Control-Allow-Origin', '*');
  if (request.method === 'OPTIONS') {
    reply.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
    reply.header('Vary', 'Access-Control-Request-Headers');
    const requested = request.headers['access-control-request-headers'];
    if (requested) reply.header('Access-Control-Allow-Headers', requested);
    reply.header('Content-Length', '0');
    return reply.code(204).send();
  }
  try {
    return await processHttpRequest(request, reply);
  } catch (err) {
    if (!(err instanceof HttpQueryError)) {
      return sendJson(reply, 500, {}, { errors: [fromExecution(err as GraphQLError)] });
    }
    reply.code(err.statusCode);
    for (const [name, value] of Object.entries(err.headers ?? {})) reply.header(name, value);
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(err.message);
  }
}

export async function healthCheckHandler(_request: FastifyRequest, reply: FastifyReply) {
  reply.header('Content-Type', 'application/health+json; charset=utf-8');
  return reply.send(JSON.stringify({ status: 'pass' }));
}
