import { RequestMethod } from '@nestjs/common';
import { BunRequest } from '../interfaces/bun-request.interface';
import { BunResponse } from './bun-response';

type Handler = (
  req: BunRequest,
  res: BunResponse,
  next: (err?: any) => void,
) => any;

type ErrorHandler = (
  err: any,
  req: BunRequest,
  res: BunResponse,
  next: (err?: any) => void,
) => any;

/** A single route/middleware registration, kept in declaration order. */
interface RouteEntry {
  /** Lowercased method name, or `null` for "all methods". */
  method: string | null;
  /** Bun route pattern (`/users/:id`, `/cats/*`). */
  bunPath: string;
  handler: Handler;
}

interface ServeOptions {
  port: number;
  hostname?: string;
  tls?: any;
}

/** A handler that resolves to a Web `Response` — what `Bun.serve` routes call. */
type BunRouteHandler = (bunReq: any, server?: any) => Promise<Response>;

const METHOD_NAME: Record<number, string | null> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.ALL]: null,
  [RequestMethod.OPTIONS]: 'options',
  [RequestMethod.HEAD]: 'head',
  [RequestMethod.SEARCH]: 'search',
  [RequestMethod.PROPFIND]: 'propfind',
  [RequestMethod.PROPPATCH]: 'proppatch',
  [RequestMethod.MKCOL]: 'mkcol',
  [RequestMethod.COPY]: 'copy',
  [RequestMethod.MOVE]: 'move',
  [RequestMethod.LOCK]: 'lock',
  [RequestMethod.UNLOCK]: 'unlock',
};

/**
 * Converts an Express / path-to-regexp@8 style path into a `Bun.serve` route
 * pattern. Named params (`:id`) pass through unchanged; wildcards
 * (`{*rest}`, `*rest`, trailing `/*`) collapse to Bun's `/*` catch-all.
 *
 * Two passes, both normalizing Express-style wildcards into Bun's anonymous `/*` segment.
 *
 * ```js
 * .replace(/\{\*\w+\}/g, '*')
 * ```
 * - `\{` `\}` — literal braces (escaped; `{` is a regex quantifier otherwise).
 * - `\*` — literal asterisk.
 * - `\w+` — one+ word chars `[A-Za-z0-9_]`, the param name.
 * - `g` — all occurrences.
 *
 * Matches brace-wrapped named wildcard `{*rest}` → `*`. So `/files/{*path}` → `/files/*`.
 *
 * ```js
 * .replace(/(^|\/)\*\w+/g, '$1*')
 * ```
 * - `(^|\/)` — capture group 1: either start-of-string `^` or a literal slash `/`.
 *      Anchors the wildcard to a segment boundary so a literal `*` mid-token isn't clobbered.
 * - `\*\w+` — `*` followed by name, the bare named wildcard `*rest`.
 * - `$1*` — keep the boundary (`$1` = the `^` match = empty, or the `/`), drop name, leave `*`.
 *
 * Matches unbraced named wildcard `*rest` at a segment start → `*`.
 * So `/files/*path` → `/files/*`, and leading `*all` → `*`.
 *
 * **Why both:** path-to-regexp@8 / Express 5 syntax allows two named-wildcard
 * spellings (`{*name}` and `*name`);
 * Bun's router only knows anonymous `*`.
 * First pass strips the braced form, second strips the bare form.
 * Order matters — the brace pass runs first so `{*x}` becomes `*x`... wait,,
 * no: brace pass yields `*` directly,
 * not `*x`, so the second pass only handles spellings that never had braces.
 * Both feed Bun a clean `/*` segment.
 *
 * Note name is discarded — consistent with the documented MVP limitation that
 * Bun doesn't surface the wildcard rest in `req.params`.
 */
export function toBunPath(path: string): string {
  let result = path
    // `{*rest}` / `*rest` named wildcards → anonymous `*` segment.
    .replace(/\{\*\w+\}/g, '*')
    .replace(/(^|\/)\*\w+/g, '$1*');
  // Collapse a bare `*` into a `/*` catch-all segment.
  if (result === '*') {
    result = '/*';
  }
  // Ensure a leading slash.
  if (!result.startsWith('/')) {
    result = `/${result}`;
  }
  return result;
}

/**
 * A routing engine backing {@link BunAdapter}. Route/middleware registrations
 * are collected into a declaration-ordered list (the object the Nest core
 * router calls `get`/`post`/`use` against) and, on {@link serve}, compiled into
 * a native `Bun.serve` `routes` tree so Bun performs path matching, param
 * extraction, and precedence resolution.
 *
 * @publicApi
 */
export class BunHttpEngine {
  /** Routes + path-scoped middleware, in declaration order. */
  private readonly routes: RouteEntry[] = [];
  /** Global middleware (parser, path-less `use`) run before every route. */
  private readonly globalMiddleware: Handler[] = [];

  private notFoundHandler?: Handler;
  private errorHandler?: ErrorHandler;
  private parserRegistered = false;
  private onRequestHook?: (
    req: BunRequest,
    res: BunResponse,
    done: () => void,
  ) => Promise<void> | void;
  private onResponseHook?: (
    req: BunRequest,
    res: BunResponse,
  ) => Promise<void> | void;

  public use(pathOrHandler: string | Handler, handler?: Handler): void {
    if (typeof pathOrHandler === 'function') {
      this.globalMiddleware.push(pathOrHandler);
    } else if (handler) {
      // A path-scoped `use` mounts middleware on a wildcard subtree.
      this.addRoute(null, `${pathOrHandler}/*`, handler);
    }
  }

  public get(path: string, handler: Handler) {
    this.addRoute('get', path, handler);
  }
  public post(path: string, handler: Handler) {
    this.addRoute('post', path, handler);
  }
  public put(path: string, handler: Handler) {
    this.addRoute('put', path, handler);
  }
  public delete(path: string, handler: Handler) {
    this.addRoute('delete', path, handler);
  }
  public patch(path: string, handler: Handler) {
    this.addRoute('patch', path, handler);
  }
  public options(path: string, handler: Handler) {
    this.addRoute('options', path, handler);
  }
  public head(path: string, handler: Handler) {
    this.addRoute('head', path, handler);
  }
  public all(path: string, handler: Handler) {
    this.addRoute(null, path, handler);
  }
  public search(path: string, handler: Handler) {
    this.addRoute('search', path, handler);
  }
  public propfind(path: string, handler: Handler) {
    this.addRoute('propfind', path, handler);
  }
  public proppatch(path: string, handler: Handler) {
    this.addRoute('proppatch', path, handler);
  }
  public mkcol(path: string, handler: Handler) {
    this.addRoute('mkcol', path, handler);
  }
  public copy(path: string, handler: Handler) {
    this.addRoute('copy', path, handler);
  }
  public move(path: string, handler: Handler) {
    this.addRoute('move', path, handler);
  }
  public lock(path: string, handler: Handler) {
    this.addRoute('lock', path, handler);
  }
  public unlock(path: string, handler: Handler) {
    this.addRoute('unlock', path, handler);
  }

  /** Used by the adapter's `createMiddlewareFactory`. */
  public register(
    requestMethod: RequestMethod,
    path: string,
    handler: Handler,
  ) {
    this.addRoute(METHOD_NAME[requestMethod] ?? null, path, handler);
  }

  public setNotFoundHandler(handler: Handler) {
    this.notFoundHandler = handler;
  }

  public setErrorHandler(handler: ErrorHandler) {
    this.errorHandler = handler;
  }

  public setOnRequestHook(
    hook: (
      req: BunRequest,
      res: BunResponse,
      done: () => void,
    ) => Promise<void> | void,
  ) {
    this.onRequestHook = hook;
  }

  public setOnResponseHook(
    hook: (req: BunRequest, res: BunResponse) => Promise<void> | void,
  ) {
    this.onResponseHook = hook;
  }

  public registerParserMiddleware(rawBody: boolean) {
    if (this.parserRegistered) {
      return;
    }
    this.parserRegistered = true;

    this.use(async (req, _res, next) => {
      try {
        const method = req.method.toUpperCase();
        if (method === 'GET' || method === 'HEAD') {
          return next();
        }
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          // Reading the body stream directly locks it.
          // Any downstream route handler or library (e.g. file uploaders or GraphQL handlers)
          // that attempts to read the stream again would crash with a
          // `TypeError: Body stream already read.`
          //
          // • Improvement: We changed it to `req.raw.clone().text()`.
          // This keeps the original request body stream unread and accessible.
          const text = await req.raw.clone().text();
          if (rawBody) {
            req.rawBody = Buffer.from(text);
          }
          req.body = text ? JSON.parse(text) : {};
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          const text = await req.raw.clone().text();
          if (rawBody) {
            req.rawBody = Buffer.from(text);
          }
          req.body = Object.fromEntries(new URLSearchParams(text));
        }
        next();
      } catch (err) {
        next(err);
      }
    });
  }

  public serve(options: ServeOptions) {
    return Bun.serve({
      port: options.port,
      hostname: options.hostname,
      tls: options.tls,
      routes: this.buildRoutes(),
      // Last-resort fallback for requests Bun's routes do not match (should be
      // covered by the `/*` catch-all, but keeps a defined response shape).
      fetch: () => new Response('Not Found', { status: 404 }),
      error: () => new Response('Internal Server Error', { status: 500 }),
    });
  }

  /**
   * Compiles the declaration-ordered registrations into a `Bun.serve` `routes`
   * object: `{ "/path": fn | { GET: fn, POST: fn, ... } }`. Each leaf chain
   * runs its registered handlers connect-style (for versioning fall-through),
   * preceded by any covering middleware and the global middleware.
   */
  public buildRoutes(): Record<
    string,
    BunRouteHandler | Record<string, BunRouteHandler>
  > {
    // Group concrete routes by path, then by method → ordered handler chain.
    const byPath = new Map<string, Map<string | null, Handler[]>>();
    for (const entry of this.routes) {
      let methods = byPath.get(entry.bunPath);
      if (!methods) {
        methods = new Map();
        byPath.set(entry.bunPath, methods);
      }
      const chain = methods.get(entry.method) ?? [];
      chain.push(entry.handler);
      methods.set(entry.method, chain);
    }

    const result: Record<
      string,
      BunRouteHandler | Record<string, BunRouteHandler>
    > = {};

    for (const [bunPath, methods] of byPath) {
      // Middleware mounted on a covering path runs before this route's handlers.
      const covering = this.coveringMiddleware(bunPath);

      const buildChain = (handlers: Handler[]): Handler[] => [
        ...this.globalMiddleware,
        ...covering,
        ...handlers,
      ];

      const allChain = methods.get(null);
      if (allChain) {
        // `all` registrations apply to every method — a bare function value.
        result[bunPath] = this.makeBunHandler(buildChain(allChain));
        continue;
      }

      const methodMap: Record<string, BunRouteHandler> = {};
      for (const [method, handlers] of methods) {
        if (method === null) {
          continue;
        }
        methodMap[method.toUpperCase()] = this.makeBunHandler(
          buildChain(handlers),
        );
        // HEAD reuses GET's chain unless explicitly registered.
        if (method === 'get' && !methodMap.HEAD) {
          methodMap.HEAD = this.makeBunHandler(buildChain(handlers));
        }
      }
      result[bunPath] = methodMap;
    }

    // Global catch-all: run global middleware then the not-found handler.
    if (!result['/*']) {
      result['/*'] = this.makeBunHandler([...this.globalMiddleware]);
    }

    return result;
  }

  private addRoute(method: string | null, path: string, handler: Handler) {
    this.routes.push({ method, bunPath: toBunPath(path), handler });
  }

  /**
   * Path-scoped middleware (registered via `use(prefix, ...)`, ending in `/*`)
   * whose subtree covers `bunPath`, in declaration order.
   */
  private coveringMiddleware(bunPath: string): Handler[] {
    const covering: Handler[] = [];
    for (const entry of this.routes) {
      if (entry.method !== null || !entry.bunPath.endsWith('/*')) {
        continue;
      }
      if (entry.bunPath === bunPath) {
        continue;
      }
      const prefix = entry.bunPath.slice(0, -2); // strip "/*"
      if (
        prefix === '' ||
        bunPath === prefix ||
        bunPath.startsWith(`${prefix}/`)
      ) {
        covering.push(entry.handler);
      }
    }
    return covering;
  }

  /**
   * Wraps a connect-style handler chain into a `Bun.serve` route handler that
   * builds the plain request, runs the request hook, executes the chain, and
   * resolves a Web `Response`.
   */
  private makeBunHandler(chain: Handler[]): BunRouteHandler {
    return async (bunReq: any, server?: any): Promise<Response> => {
      const req = this.buildRequest(bunReq, server);
      const res = new BunResponse();

      if (this.onRequestHook) {
        await new Promise<void>(resolve => {
          const ret = this.onRequestHook!(req, res, resolve);
          if (ret && typeof ret.then === 'function') {
            void ret.then(() => resolve());
          }
        });
      }

      // When the chain exhausts without producing a response, fall back to the
      // not-found handler — this covers both the `/*` catch-all and a concrete
      // route whose handlers all fell through (e.g. every versioning filter
      // missed). The response is awaited via `res.toResponse()`.
      void this.runChain(chain, req, res).then(() => {
        if (!res.headersSent) {
          this.runNotFound(req, res);
        }
      });

      const response = await res.toResponse();

      if (this.onResponseHook) {
        await this.onResponseHook(req, res);
      }
      return response;
    };
  }

  /**
   * Runs an ordered handler chain connect-style. Resolves when the chain is
   * fully unwound (a handler settled the response and stopped calling `next`,
   * the chain exhausted, or an error was handled).
   */
  private runChain(
    chain: Handler[],
    req: BunRequest,
    res: BunResponse,
  ): Promise<void> {
    return new Promise<void>(resolve => {
      let idx = 0;
      const next = (err?: any) => {
        if (err) {
          void Promise.resolve(
            this.handleError(err, req, res, () => {}),
          ).finally(() => resolve());
          return;
        }
        if (idx >= chain.length) {
          resolve();
          return;
        }
        const handler = chain[idx++];
        let result: any;
        try {
          result = handler(req, res, next);
        } catch (e) {
          next(e);
          return;
        }
        if (result && typeof result.then === 'function') {
          result.then(undefined, (e: any) => next(e));
        }
      };
      next();
    });
  }

  private handleError(
    err: any,
    req: BunRequest,
    res: BunResponse,
    next: (err?: any) => void,
  ) {
    if (this.errorHandler) {
      return this.errorHandler(err, req, res, next);
    }
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  }

  private runNotFound(req: BunRequest, res: BunResponse) {
    if (this.notFoundHandler) {
      this.notFoundHandler(req, res, () => {});
    } else if (!res.headersSent) {
      res.status(404).end();
    }
  }

  private buildRequest(bunReq: any, server?: any): BunRequest {
    const url = new URL(bunReq.url);
    const headers: Record<string, string> = {};
    bunReq.headers.forEach((value: string, key: string) => {
      headers[key] = value;
    });
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // Bun populates `params` (named segments + `*` wildcard) on the request.
    const params: Record<string, string> = { ...(bunReq.params ?? {}) };

    let ip: string | undefined;
    try {
      ip = server?.requestIP?.(bunReq)?.address;
    } catch {
      ip = undefined;
    }

    return {
      method: bunReq.method,
      originalUrl: url.pathname + url.search,
      url: url.pathname + url.search,
      path: url.pathname,
      hostname: url.hostname,
      headers,
      query,
      params,
      hosts: {},
      raw: bunReq as Request,
      ip,
    };
  }
}
