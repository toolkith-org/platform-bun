# Implementation Plan — `@nestjs/platform-bun`

## Context

NestJS ships HTTP platform adapters that implement `AbstractHttpAdapter`
(`packages/core/adapters/http-adapter.ts`) so the framework's router, guards,
interceptors, pipes, and exception handling stay decoupled from the underlying
HTTP engine. Today only Express (`platform-express`) and Fastify
(`platform-fastify`) exist. This adds a third, `platform-bun`, targeting native
`Bun.serve()` with Web-standard `Request`/`Response`/`Headers`/`URLPattern`.

The core router is the consumer to satisfy. From `nest-application.ts` it calls
`this.routesResolver.resolve(this.httpAdapter, basePath)`, which ultimately:

- registers routes via `instance.get/post/...(path, handler)` and middleware via
  `instance.use(...)`, where every `handler`/middleware is an **Express-style
  `(req, res, next)` function** (`router-explorer.ts`, `router-method-factory.ts`);
- relies on `next()` chaining across multiple handlers registered on the same
  method+path — this is how API **versioning** filters skip to the next handler
  (`router-explorer.ts:applyVersionFilter` + adapter `applyVersionFilter`);
- reads request data through a fixed `req` surface (`route-params-factory.ts`):
  `req.body`, `req.rawBody`, `req.params`, `req.query`, `req.headers`
  (lowercased keys), `req.hosts`, `req.session`, `req.file`/`req.files`, `req.ip`;
- reads request metadata via adapter accessors `getRequestHostname`,
  `getRequestMethod`, `getRequestUrl`;
- writes responses via adapter methods `reply`, `status`, `end`, `redirect`,
  `render`, `setHeader`/`getHeader`/`appendHeader`, `isHeadersSent`
  (`router-response-controller.ts`).

**Central architectural problem.** Bun's `fetch(req)` handler must *return* a
`Response`, but NestJS writes responses imperatively to a mutable `res` over the
lifetime of the pipeline. Bridge with a `BunResponse` shim that accumulates
status/headers/body and exposes a promise the `fetch` handler awaits; on
terminal call (`send`/`json`/`end`/`redirect`) it resolves to a Web `Response`.
This mirrors how `platform-fastify` builds its own routing engine
(`find-my-way`) rather than reusing Express.

### Decisions (confirmed with user)
- **Test runner:** `bun test` (native Bun runtime). Diverges from the repo's
  mocha+chai and is not wired into the existing `npm test` CI — acceptable for
  this package since it needs real `Bun.serve`/`URLPattern`.
- **Scope:** Core MVP first. Defer static assets, view engine/`render`, and CORS
  (stub them to throw a clear "not yet supported" error). Ship routing,
  middleware, params, JSON/urlencoded body + `rawBody`, all versioning
  strategies, `reply`/`status`/`redirect`/headers, `listen`/`close`, SSL/TLS.
- **Bun types:** add `@types/bun` (`bun-types`) devDependency so `Bun.serve`,
  `URLPattern`, `Request`/`Response` typecheck under the repo `tsc -b` build.

---

## Build / monorepo integration

1. **`tsconfig.json`** (root) — add path aliases after the `platform-fastify`
   block (lines ~34-35):
   ```json
   "@nestjs/platform-bun": ["./packages/platform-bun"],
   "@nestjs/platform-bun/*": ["./packages/platform-bun/*"],
   ```
2. **`packages/tsconfig.json`** — add a project reference:
   `{ "path": "./platform-bun/tsconfig.build.json" }`. Required: the build is
   `tsc -b -v packages`, driven by these references.
3. Gulp tasks auto-discover packages via `getDirs('packages')`
   (`tools/gulp/config.ts`) — no gulp change needed.

## Package scaffold (`packages/platform-bun/`)

Mirror `platform-fastify` layout exactly.

- **`package.json`** — name `@nestjs/platform-bun`. **Omit the `version` field**
  (lerna-managed at root `11.1.24`, matching how `platform-fastify/package.json`
  omits it). `dependencies`: `tslib`, `path-to-regexp` (for path validation,
  same pin as siblings). `devDependencies`: `@types/bun`. `peerDependencies`:
  `@nestjs/common` and `@nestjs/core` `^11.0.0`. Copy `repository.directory`,
  `publishConfig`, `funding` from the fastify file.
- **`tsconfig.json`** and **`tsconfig.build.json`** — copy from
  `platform-fastify`, changing only the `directory`/paths; add `"bun"` (or the
  `bun-types` typeRoots) to `compilerOptions.types`/`lib` so Bun globals resolve.
  Keep the `references` to `../common` and `../core` build tsconfigs.
- **`index.ts`** — `export * from './adapters'; export * from './interfaces';`

## Adapter source (`packages/platform-bun/adapters/`)

### `bun-response.ts` — `BunResponse`
Mutable response shim consumed by the core pipeline.
- State: `statusCode` (default 200), a `Headers` instance, `body`, `headersSent`,
  `locals`.
- A `deferred` promise + `resolve` captured at construction; `toResponse()`
  (or `.responsePromise`) is what the `fetch` handler awaits.
- Methods the adapter delegates to: `status(code)`, `send(body)`, `json(obj)`
  (sets `Content-Type: application/json`), `end(msg?)`, `redirect(code, url)`,
  header ops (`set`/`get`/`append`/`getHeader`/`setHeader`). Terminal methods set
  `headersSent = true`, build a Web `Response(body, { status, headers })`, and
  call `resolve`. Guard against double-resolve.
- `StreamableFile` support in `reply` (see below): pass the readable stream as
  the `Response` body.

### `bun-adapter.ts` — `BunAdapter extends AbstractHttpAdapter`
Constructor: build an internal **engine** as `this.instance` (the object the core
router registers against) — it is NOT `express()`. The engine provides
`use(...)`, and `get/post/put/delete/patch/options/head/all/...` (every verb in
`router-method-factory.ts`'s `REQUEST_METHOD_MAP`) that push
`{ method, pattern: new URLPattern(...), handlers: [] }` route entries (multiple
handlers per method+path to support `next()` chaining / versioning).

Engine dispatch (the `Bun.serve` `fetch`): for an incoming Web `Request`,
1. build the plain `req` object satisfying `route-params-factory.ts`:
   `method`, `originalUrl`/`url`, `hostname`, `headers` (lowercased map from
   `Headers`), `query` (from `URL.searchParams`), `params` (from matched
   `URLPattern` groups), `ip` (from `server.requestIP`), placeholders for
   `body`/`rawBody`/`hosts`/`session`/`files`;
2. construct a `BunResponse`;
3. run the middleware stack (`use`) then the matched route's handler array as a
   connect-style chain — each `next()` advances to the next handler; this is what
   lets `applyVersionFilter` fall through to the next version's handler;
4. if nothing matched, invoke the registered **not-found** handler
   (`setNotFoundHandler`); errors propagate to the **error** handler
   (`setErrorHandler`);
5. `await bunResponse.toResponse()` and return it to Bun.

Method implementations:
- `getType()` → `'bun'`.
- `getRequestMethod/Url/Hostname` → read from the plain `req`.
- `status`, `reply`, `end`, `redirect`, `getHeader`/`setHeader`/`appendHeader`,
  `isHeadersSent` → delegate to `BunResponse`. `reply` reproduces
  `ExpressAdapter.reply` logic: nil → `send()`; `StreamableFile` → stream body +
  `applyStreamHeaders`; object → `json`; else `send(String(body))`; including the
  non-JSON-content-type warning branch.
- `normalizePath(path)` → route through `LegacyRouteConverter.tryConvert`
  (`@nestjs/core/router/legacy-route-converter`) then validate with `pathToRegexp`
  like `ExpressAdapter.normalizePath`, **and** convert the Express-style
  `:param`/`*wild` path into a `URLPattern` pathname the engine stores.
- `createMiddlewareFactory(method)` → returns `(path, callback) => engine.<verb>(path, callback)`.
- `registerParserMiddleware(prefix?, rawBody?)` → register a `use` middleware that,
  for JSON/urlencoded `Content-Type`, reads the request body once
  (`await request.text()`), sets `req.rawBody` (Buffer) when `rawBody` is on, and
  parses into `req.body` (JSON.parse / `URLSearchParams`). Idempotent guard like
  `isMiddlewareApplied`.
- `applyVersionFilter(handler, version, versioningOptions)` → **port
  `ExpressAdapter.applyVersionFilter` verbatim** (URI/HEADER/MEDIA_TYPE/CUSTOM/
  VERSION_NEUTRAL). It only reads `req.headers`/calls `next()`, so it is
  engine-agnostic and works unchanged.
- `initHttpServer(options)` → store `options` (incl. `httpsOptions`); do NOT start
  the server yet (Bun.serve starts listening immediately, unlike `http.createServer`).
- `listen(port, hostname?, cb?)` → call `Bun.serve({ port, hostname, fetch,
  tls: <from httpsOptions>, ... })`, assign result to `this.httpServer`, invoke
  callback. Support the overloads in the abstract signature.
- `close()` → `this.httpServer?.stop(true)` (true = close active connections),
  satisfying graceful shutdown without manual socket tracking.
- `setErrorHandler`/`setNotFoundHandler` → store handlers used by the engine.
- `setOnRequestHook`/`setOnResponseHook` → store; invoke pre-dispatch and after
  the response promise resolves (mirrors `ExpressAdapter`).
- **Deferred / stubbed**: `useStaticAssets`, `setViewEngine`, `render`,
  `enableCors` → throw `Error('<feature> is not yet supported by
  @nestjs/platform-bun')` so callers fail loudly rather than silently.

### `adapters/index.ts` — `export * from './bun-adapter'; export * from './bun-response';`

## Interfaces (`packages/platform-bun/interfaces/`)
- **`nest-bun-application.interface.ts`** — `NestBunApplication extends
  INestApplication` (from `@nestjs/common`), the typed app for
  `NestFactory.create<NestBunApplication>(AppModule, new BunAdapter())`. Start
  minimal (no extra methods); extend later when static/views land.
- **`index.ts`** — re-export.

---

## Critical files to create/modify
- modify `tsconfig.json` (root), `packages/tsconfig.json`
- create `packages/platform-bun/{package.json,tsconfig.json,tsconfig.build.json,index.ts}`
- create `packages/platform-bun/adapters/{bun-adapter.ts,bun-response.ts,index.ts}`
- create `packages/platform-bun/interfaces/{nest-bun-application.interface.ts,index.ts}`
- create `packages/platform-bun/test/bun-adapter.spec.ts`

## Reuse (do not reimplement)
- `LegacyRouteConverter` — `@nestjs/core/router/legacy-route-converter`
- `pathToRegexp` — `path-to-regexp` (path validation, as in ExpressAdapter)
- `applyVersionFilter` body — port from `platform-express/adapters/express-adapter.ts`
- `reply`/`applyStreamHeaders` logic — port from ExpressAdapter
- shared utils `isNil/isObject/isString/isUndefined/isFunction` —
  `@nestjs/common/utils/shared.utils`

---

## Verification

### Unit tests — `bun test packages/platform-bun/test/bun-adapter.spec.ts`
1. adapter construction + `getType() === 'bun'`, lifecycle (`init`/`close`).
2. route registration per verb and `URLPattern` matching.
3. path param extraction (`/users/:id` → `req.params.id`).
4. query + lowercased headers exposure on `req`.
5. middleware chain `next()` ordering; not-found fallthrough.
6. body parsing (JSON + urlencoded) and `rawBody` capture.
7. versioning: HEADER + MEDIA_TYPE filters select/skip handlers via `next()`.
8. `reply`/`status`/`redirect` produce correct Web `Response` (status, headers, body).

### Manual / end-to-end
1. `npm run build` — confirm `tsc -b` compiles the new package (references wired).
2. Minimal app:
   ```ts
   const app = await NestFactory.create<NestBunApplication>(AppModule, new BunAdapter());
   await app.listen(3000);
   ```
   `curl` a GET route, a POST with JSON body (verify `@Body()`), a `:param`
   route, and a versioned route; confirm 404 for unknown path and that a thrown
   `HttpException` is formatted by the exception layer.
3. Confirm `app.close()` stops `Bun.serve` and frees the port.

## Out of scope (follow-ups)
Static asset serving (`Bun.file`), view engine + `render`, CORS, multer-style
file uploads, and wiring `bun test` into CI.
