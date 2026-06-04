# Refactor `BunHttpEngine` to native `Bun.serve` route tree

## Context

`packages/platform-bun/adapters/bun-http-engine.ts` currently reimplements an
Express-style connect router: it pushes every route/middleware into a flat
`stack: Layer[]` and, on each request, hand-matches every layer in `execStack`
via `URLPattern.exec`. This duplicates routing logic Bun already provides
natively.

Goal: drop the hand-rolled matcher. Register routes into a **tree** keyed by
path → method → handler chain, and on `serve()` hand that tree to `Bun.serve`'s
`routes` option so Bun does the matching (params, precedence, decoding). General
(global) middleware maps to Bun's `/*` catch-all per
<https://bun.com/docs/runtime/http/routing#route-precedence>, and is also
composed into concrete routes so it still runs before their handlers.

### Constraints discovered (drive the design)

- **Bun `routes` is static at serve time.** Nest registers all routes during
  `init()` *before* `app.listen()` → before `engine.serve()`. So we build the
  routes object once, at `serve()`. (`server.reload()` exists but isn't needed.)
- **Per-method shape:** `routes: { "/p": { GET: fn, POST: fn } }`; a bare `fn`
  = all methods. Params `:id` → `req.params.id`. Wildcard `/*`. Precedence:
  exact > param > wildcard > `/*`.
- **Versioning needs multi-handler chains.** Nest registers several handlers on
  the same method+path and relies on `next()` fall-through (`applyVersionFilter`).
  Bun allows one handler per method+path, so each tree leaf holds a
  `Handler[]` run as a connect-style mini-chain inside one Bun handler.
- **Middleware semantics (user decision: compose into matching routes).** Nest
  mounts user middleware as routes via `createMiddlewareFactory → register`,
  often on prefix/wildcard paths. Bun only runs the single most-specific match,
  so prefix middleware won't auto-run before a more-specific controller. We
  therefore prepend, at build time, any registered middleware whose pattern
  covers a concrete route into that route's chain.
- **Tests (user decision: rewrite to real Bun.serve).** `bun test` runs on the
  real Bun runtime, so tests start an actual server on an ephemeral port and use
  `fetch()` instead of calling `engine.handle(Request)`. `handle()`/`execStack`
  hand-matching is removed.

## Changes

### 1. `adapters/bun-http-engine.ts` — rewrite the engine

Replace `stack`/`execStack`/`match`/`handle`/`addRoute(push)` with a route tree.

- **Distinguish two registration kinds:**
  - **Global middleware** — `use(handler)` (no path) and the body parser from
    `registerParserMiddleware`. Stored in `globalMiddleware: Handler[]`.
  - **Routes & path-scoped middleware** — `get/post/.../all/register` and
    `use(prefix, handler)`. Stored as `RouteEntry { method: string|null,
    bunPath: string, handler: Handler }` in registration order.

- **`addRoute(method, path, handler)`** — convert `path` via existing
  `toUrlPatternPath`-equivalent → Bun pattern (`:param` stays, `{*rest}`/`*rest`
  → `/*`; keep a `toBunPath(path)` helper, replacing `toUrlPatternPath`). Push a
  `RouteEntry`. No `URLPattern` construction.

- **`serve(options)`** — build the Bun `routes` object then call `Bun.serve`:
  1. Group `RouteEntry[]` by `bunPath`, then by method → `Handler[]` (preserves
     versioning order; HEAD reuses GET's chain).
  2. For each concrete path+method chain, **prepend covering middleware**: any
     path-scoped middleware entry whose pattern is a prefix/wildcard covering
     this path (reuse a small `covers(mwPath, routePath)` check — exact, or
     `mwPath` is `/x/*` and route under `/x`). Also prepend `globalMiddleware`.
  3. Emit `routes[bunPath] = fn | { GET: fn, POST: fn, ... }` where each `fn`
     is `makeBunHandler(chain)`.
  4. Add `routes['/*'] = makeBunHandler([...globalMiddleware], { notFound:true })`
     so unmatched requests still run global middleware then the not-found
     handler. (Keep `fetch` as a last-resort 500/error bridge too.)
  5. `Bun.serve({ port, hostname, tls, routes, error })`.

- **`makeBunHandler(chain, opts?)`** — returns `async (bunReq, server) =>
  Response`. It:
  - builds the plain `BunRequest` via `buildRequest`, but reads `req.params`
    **from Bun** (`bunReq.params`) instead of `URLPattern.exec`;
  - runs `onRequestHook` (port existing await-bridge logic);
  - runs the `chain` connect-style (`runChain(chain, req, res)` — the `next()`
    loop extracted from today's `execStack`, but over the per-route array, not
    the global stack); on chain exhaustion without a sent response, run
    `runNotFound`; errors → `handleError`;
  - `await res.toResponse()`, run `onResponseHook`, return the `Response`.

- **Keep unchanged:** `registerParserMiddleware` (still `use(...)` into
  `globalMiddleware`), `setNotFoundHandler`, `setErrorHandler`,
  `setOnRequestHook`, `setOnResponseHook`, `buildRequest` (drop the
  `URLPattern` params bit), `handleError`, `runNotFound`.

- **Remove:** `stack`, `Layer`/`MiddlewareLayer`/`RouteLayer` types,
  `execStack`, `match`, the public `handle()` (or keep a thin private
  `runChain`). `addRoute` no longer builds `URLPattern`.

### 2. `adapters/bun-adapter.ts` — minimal

No behavioral change needed: it already delegates `get/post/use/register/serve`
to the engine. Verify `listen()` still calls `engine.serve(...)` (it does).
Wildcard param-name mapping (`{*path}` → Bun `/*`, exposed as `req.params['*']`)
— if any code reads a named wildcard param, normalize in `makeBunHandler`
(map Bun's `*` group to the original param name). Flag during impl.

### 3. `test/bun-adapter.test.ts` — rewrite to real `Bun.serve`

Replace the `engineOf(adapter).handle(new Request(...))` pattern with a helper
that starts the adapter's server on port `0` (ephemeral) and `fetch`es it:

```ts
async function withServer(adapter: BunAdapter, fn) {
  const server = adapter.listen(0);           // Bun picks a free port
  try { return await fn(`http://localhost:${server.port}`); }
  finally { await adapter.close(); }
}
```

Port each existing case (GET match, params `/users/:id`, query + lowercased
headers, middleware order, not-found, error handler, body JSON/urlencoded +
rawBody, HEADER/MEDIA_TYPE versioning, reply/status/redirect) to issue a real
`fetch` and assert on the `Response`. Versioning unit tests that call
`applyVersionFilter` directly (no server) stay as-is.

## Critical files

- rewrite `packages/platform-bun/adapters/bun-http-engine.ts`
- (light) `packages/platform-bun/adapters/bun-adapter.ts` — wildcard param map only
- rewrite `packages/platform-bun/test/bun-adapter.test.ts`

## Reuse (don't reimplement)

- Path conversion shape from existing `toUrlPatternPath` → adapt to `toBunPath`.
- `next()` chain loop from current `execStack` → becomes `runChain`.
- `onRequestHook` await-bridge, `buildRequest`, `handleError`, `runNotFound`,
  `registerParserMiddleware` bodies — port nearly verbatim.
- Bun matching/params/decoding — delegate to `Bun.serve` `routes`.

## Verification

1. `cd packages/platform-bun && bun test test/bun-adapter.test.ts` — all ported
   cases pass against a live server.
2. `npm run build` from repo root — `tsc -b` compiles platform-bun (types still
   valid after removing `URLPattern` usage).
3. Manual smoke: minimal app
   `NestFactory.create<NestBunApplication>(AppModule, new BunAdapter())` +
   `app.listen(3000)`; `curl` a GET, a `:param` route, a POST JSON body
   (`@Body()`), a versioned route (HEADER), confirm 404 on unknown path and
   that a thrown `HttpException` is formatted; `app.close()` frees the port.
4. Confirm middleware mounted on `/cats` via `forRoutes` runs before the
   `/cats/:id` controller (composed-into-matching-routes behavior).
