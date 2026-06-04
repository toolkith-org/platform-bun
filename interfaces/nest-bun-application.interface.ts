import { INestApplication } from '@nestjs/common';

/**
 * Interface describing methods on `NestBunApplication`, the application object
 * returned by `NestFactory.create<NestBunApplication>(AppModule, new BunAdapter())`.
 *
 * Currently identical to `INestApplication`; Bun-specific methods (static
 * assets, view engine) will be added here as those features land.
 *
 * @publicApi
 */
export type NestBunApplication = INestApplication;
