import { RequestMethod, VersioningType } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'bun:test';
import { BunAdapter } from '../adapters/bun-adapter';
import { BunHttpEngine } from '../adapters/bun-http-engine';
import { BunResponse } from '../adapters/bun-response';

const engineOf = (adapter: BunAdapter): BunHttpEngine =>
  (adapter as any).getInstance();

/**
 * Starts the adapter on an ephemeral port, runs `fn` against the live base URL,
 * then closes the server. Routing now flows through `Bun.serve`'s native
 * `routes`, so tests exercise a real server rather than an offline matcher.
 */
let active: BunAdapter | undefined;
async function withServer<T>(
  adapter: BunAdapter,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  active = adapter;
  const server = adapter.listen(0);
  const base = `http://localhost:${server.port}`;
  return fn(base);
}

afterEach(async () => {
  if (active) {
    await active.close();
    active = undefined;
  }
});

describe('BunAdapter', () => {
  describe('lifecycle', () => {
    it('reports the "bun" platform type', () => {
      expect(new BunAdapter().getType()).toBe('bun');
    });

    it('exposes a BunHttpEngine as its instance', () => {
      expect(engineOf(new BunAdapter())).toBeInstanceOf(BunHttpEngine);
    });
  });

  describe('routing', () => {
    it('registers and matches a GET route', async () => {
      const adapter = new BunAdapter();
      adapter.get('/hello', (_req, res) => res.json({ ok: true }));

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/hello`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
      });
    });

    it('does not match a route with the wrong method', async () => {
      const adapter = new BunAdapter();
      adapter.post('/hello', (_req, res) => res.json({ ok: true }));
      adapter.setNotFoundHandler((_req: any, res: BunResponse) =>
        res.status(404).json({ error: 'not found' }),
      );

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/hello`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'not found' });
      });
    });

    it('extracts path parameters', async () => {
      const adapter = new BunAdapter();
      adapter.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/users/42`);
        expect(await response.json()).toEqual({ id: '42' });
      });
    });

    it('exposes query params and lowercased headers on req', async () => {
      const adapter = new BunAdapter();
      adapter.get('/echo', (req, res) =>
        res.json({ q: req.query.q, ua: req.headers['x-test'] }),
      );

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/echo?q=bun`, {
          headers: { 'X-Test': 'header-value' },
        });
        expect(await response.json()).toEqual({
          q: 'bun',
          ua: 'header-value',
        });
      });
    });
  });

  describe('middleware', () => {
    it('runs middleware in order before the route handler', async () => {
      const adapter = new BunAdapter();
      const order: string[] = [];
      const engine = engineOf(adapter);

      engine.use((_req, _res, next) => {
        order.push('mw1');
        next();
      });
      engine.use((_req, _res, next) => {
        order.push('mw2');
        next();
      });
      adapter.get('/x', (_req, res) => {
        order.push('handler');
        res.json({ order });
      });

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/x`);
        expect(await response.json()).toEqual({
          order: ['mw1', 'mw2', 'handler'],
        });
      });
    });

    it('runs path-scoped middleware before a more-specific route', async () => {
      const adapter = new BunAdapter();
      const order: string[] = [];
      const factory = adapter.createMiddlewareFactory(RequestMethod.ALL);
      factory('/cats/*', (_req: any, _res: any, next: any) => {
        order.push('mw');
        next();
      });
      adapter.get('/cats/:id', (_req, res) => {
        order.push('handler');
        res.json({ order });
      });

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/cats/7`);
        expect(await response.json()).toEqual({ order: ['mw', 'handler'] });
      });
    });

    it('falls through to the not-found handler when nothing matches', async () => {
      const adapter = new BunAdapter();
      adapter.setNotFoundHandler((_req: any, res: BunResponse) =>
        res.status(404).end('missing'),
      );

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/nope`);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('missing');
      });
    });

    it('routes thrown errors to the error handler', async () => {
      const adapter = new BunAdapter();
      adapter.get('/boom', () => {
        throw new Error('kaboom');
      });
      adapter.setErrorHandler((err: any, _req: any, res: BunResponse) =>
        res.status(500).json({ message: err.message }),
      );

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/boom`);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ message: 'kaboom' });
      });
    });
  });

  describe('body parsing', () => {
    it('parses JSON bodies and captures the raw body', async () => {
      const adapter = new BunAdapter();
      adapter.registerParserMiddleware(undefined, true);
      adapter.post('/json', (req, res) =>
        res.json({ body: req.body, raw: req.rawBody?.toString() }),
      );

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'nest' }),
        });
        expect(await response.json()).toEqual({
          body: { name: 'nest' },
          raw: '{"name":"nest"}',
        });
      });
    });

    it('parses urlencoded bodies', async () => {
      const adapter = new BunAdapter();
      adapter.registerParserMiddleware();
      adapter.post('/form', (req, res) => res.json(req.body));

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/form`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'a=1&b=2',
        });
        expect(await response.json()).toEqual({ a: '1', b: '2' });
      });
    });
  });

  describe('versioning', () => {
    it('HEADER strategy: calls handler on match, next on miss', () => {
      const adapter = new BunAdapter();
      let called = false;
      const handler = () => {
        called = true;
      };
      const filter = adapter.applyVersionFilter(handler, '2', {
        type: VersioningType.HEADER,
        header: 'X-Version',
      });

      called = false;
      let nexted = false;
      filter({ headers: { 'x-version': '2' } } as any, {} as any, () => {
        nexted = true;
      });
      expect(called).toBe(true);
      expect(nexted).toBe(false);

      called = false;
      nexted = false;
      filter({ headers: { 'x-version': '1' } } as any, {} as any, () => {
        nexted = true;
      });
      expect(called).toBe(false);
      expect(nexted).toBe(true);
    });

    it('MEDIA_TYPE strategy matches the Accept header version', () => {
      const adapter = new BunAdapter();
      let called = false;
      const filter = adapter.applyVersionFilter(
        () => {
          called = true;
        },
        '3',
        { type: VersioningType.MEDIA_TYPE, key: 'v=' },
      );

      filter(
        { headers: { accept: 'application/json;v=3' } } as any,
        {} as any,
        () => {},
      );
      expect(called).toBe(true);
    });

    it('selects the matching handler across chained version filters', async () => {
      const adapter = new BunAdapter();
      const v1 = adapter.applyVersionFilter(
        (_req: any, res: BunResponse) => res.json({ v: 1 }),
        '1',
        { type: VersioningType.HEADER, header: 'X-Version' },
      );
      const v2 = adapter.applyVersionFilter(
        (_req: any, res: BunResponse) => res.json({ v: 2 }),
        '2',
        { type: VersioningType.HEADER, header: 'X-Version' },
      );
      // Both handlers registered on the same method+path; `next()` falls through.
      adapter.get('/ver', v1 as any);
      adapter.get('/ver', v2 as any);

      await withServer(adapter, async base => {
        const r2 = await fetch(`${base}/ver`, {
          headers: { 'x-version': '2' },
        });
        expect(await r2.json()).toEqual({ v: 2 });

        const r1 = await fetch(`${base}/ver`, {
          headers: { 'x-version': '1' },
        });
        expect(await r1.json()).toEqual({ v: 1 });
      });
    });
  });

  describe('response writing', () => {
    it('reply() serializes objects to JSON with the given status', async () => {
      const adapter = new BunAdapter();
      const res = new BunResponse();
      adapter.reply(res, { a: 1 }, 201);

      const response = await res.toResponse();
      expect(response.status).toBe(201);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({ a: 1 });
    });

    it('reply() sends strings as-is', async () => {
      const adapter = new BunAdapter();
      const res = new BunResponse();
      adapter.reply(res, 'hello');

      expect(await (await res.toResponse()).text()).toBe('hello');
    });

    it('redirect() sets status and Location header', async () => {
      const adapter = new BunAdapter();
      const res = new BunResponse();
      adapter.redirect(res, 302, '/elsewhere');

      const response = await res.toResponse();
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/elsewhere');
    });

    it('isHeadersSent reflects whether the response was finalized', async () => {
      const adapter = new BunAdapter();
      const res = new BunResponse();
      expect(adapter.isHeadersSent(res)).toBe(false);
      adapter.reply(res, 'done');
      expect(adapter.isHeadersSent(res)).toBe(true);
    });
  });

  describe('createMiddlewareFactory', () => {
    it('registers routes for the given request method', async () => {
      const adapter = new BunAdapter();
      const factory = adapter.createMiddlewareFactory(RequestMethod.GET);
      factory('/mw', (_req: any, res: BunResponse) => res.json({ via: 'mw' }));

      await withServer(adapter, async base => {
        const response = await fetch(`${base}/mw`);
        expect(await response.json()).toEqual({ via: 'mw' });
      });
    });
  });

  describe('listen and close', () => {
    it('starts listening and responds to real HTTP requests, then closes successfully', async () => {
      const adapter = new BunAdapter();
      adapter.get('/ping', (_req, res) => res.send('pong'));

      const server = adapter.listen(0);
      const port = server.port;

      const response = await fetch(`http://localhost:${port}/ping`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('pong');

      await adapter.close();
    });
  });
});
