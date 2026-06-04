## Description

`@nestjs/platform-bun` is an HTTP platform adapter for [Nest](https://github.com/nestjs/nest)
built on top of the native [`Bun.serve()`](https://bun.sh/docs/api/http) API and Web-standard
`Request`/`Response`/`URLPattern`. It implements the framework's `AbstractHttpAdapter` contract
so the core router, middleware, guards, interceptors, pipes, and exception handling work
unchanged on the Bun runtime.

```ts
import { NestFactory } from '@nestjs/core';
import { BunAdapter, NestBunApplication } from '@nestjs/platform-bun';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestBunApplication>(
    AppModule,
    new BunAdapter(),
  );
  await app.listen(3000);
}
bootstrap();
```

## Supported features (initial release)

- Routing, middleware, and path params (via `URLPattern`)
- JSON / urlencoded body parsing and `rawBody` capture
- API versioning (URI, HEADER, MEDIA_TYPE, CUSTOM, VERSION_NEUTRAL)
- `reply` / `status` / `redirect` / header operations, `StreamableFile`
- `listen` / `close` (graceful shutdown via `server.stop(true)`), SSL/TLS

## Not yet supported

The following throw a descriptive error and are planned follow-ups:
static asset serving, view engine (`render`), CORS, and multer-style file uploads.

## Install & build

```bash
bun install
bun run build   # emits dist/index.js + dist/index.d.ts via tsc
```

`@nestjs/common` and `@nestjs/core` are peer dependencies; they are also listed as
dev dependencies so builds and tests resolve them from `node_modules`.

## Running the unit tests

The tests run on the **Bun** runtime (`bun:test`) because they exercise real
`Bun.serve` / `URLPattern` behavior. With the peer packages installed, just run:

```bash
bun install
bun test
```

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
