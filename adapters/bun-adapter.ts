import {
  HttpStatus,
  Logger,
  RequestMethod,
  StreamableFile,
  VERSION_NEUTRAL,
  VersioningOptions,
  VersioningType,
} from '@nestjs/common';
import { VersionValue } from '@nestjs/common/interfaces';
import { NestApplicationOptions } from '@nestjs/common/interfaces/nest-application-options.interface';
import {
  isNil,
  isObject,
  isString,
  isUndefined,
} from '@nestjs/common/utils/shared.utils';
import { AbstractHttpAdapter } from '@nestjs/core/adapters/http-adapter';
import { LegacyRouteConverter } from '@nestjs/core/router/legacy-route-converter';
import { pathToRegexp } from 'path-to-regexp';
import { BunRequest } from '../interfaces/bun-request.interface';
import { BunHttpEngine } from './bun-http-engine';
import { BunResponse } from './bun-response';

type VersionedRoute = (
  req: BunRequest,
  res: BunResponse,
  next: () => void,
) => any;

const NOT_SUPPORTED = (feature: string) =>
  new Error(
    `Feature is not yet supported by @nestjs/platform-bun. feature=${feature}`,
  );

/**
 * HTTP adapter for the Bun runtime, built on top of native `Bun.serve()` and
 * Web-standard `Request`/`Response`/`URLPattern`.
 *
 * @publicApi
 */
export class BunAdapter extends AbstractHttpAdapter<
  // `Bun.serve` returns a `Server`; typed loosely to avoid a hard dependency
  // on the Bun type surface in consumers.
  any,
  BunRequest,
  BunResponse
> {
  private readonly logger = new Logger(BunAdapter.name);
  private httpsOptions?: NestApplicationOptions['httpsOptions'];

  constructor() {
    super(new BunHttpEngine());
  }

  private get engine(): BunHttpEngine {
    return this.getInstance<BunHttpEngine>();
  }

  public reply(response: BunResponse, body: any, statusCode?: number) {
    if (statusCode) {
      response.status(statusCode);
    }
    if (isNil(body)) {
      return response.send();
    }
    if (body instanceof StreamableFile) {
      this.applyStreamHeaders(response, body);
      const stream = body.getStream();
      stream.once('error', err => {
        body.errorHandler(err, response as any);
      });
      return response.send(stream);
    }
    const responseContentType = response.getHeader('Content-Type');
    if (
      typeof responseContentType === 'string' &&
      !responseContentType.startsWith('application/json') &&
      body?.statusCode >= HttpStatus.BAD_REQUEST
    ) {
      this.logger.warn(
        "Content-Type doesn't match Reply body, you might need a custom ExceptionFilter for non-JSON responses",
      );
      response.setHeader('Content-Type', 'application/json');
    }
    return isObject(body) ? response.json(body) : response.send(String(body));
  }

  public status(response: BunResponse, statusCode: number) {
    return response.status(statusCode);
  }

  public end(response: BunResponse, message?: string) {
    return response.end(message);
  }

  public render(response: BunResponse, view: string, options: any) {
    throw NOT_SUPPORTED('View rendering (render)');
  }

  public redirect(response: BunResponse, statusCode: number, url: string) {
    return response.redirect(statusCode, url);
  }

  public setErrorHandler(handler: Function, prefix?: string) {
    this.engine.setErrorHandler(handler as any);
  }

  public setNotFoundHandler(handler: Function, prefix?: string) {
    this.engine.setNotFoundHandler(handler as any);
  }

  public isHeadersSent(response: BunResponse): boolean {
    return response.headersSent;
  }

  public getHeader(response: BunResponse, name: string) {
    return response.getHeader(name);
  }

  public setHeader(response: BunResponse, name: string, value: string) {
    return response.setHeader(name, value);
  }

  public appendHeader(response: BunResponse, name: string, value: string) {
    return response.appendHeader(name, value);
  }

  public getRequestHostname(request: BunRequest): string {
    return request.hostname;
  }

  public getRequestMethod(request: BunRequest): string {
    return request.method;
  }

  public getRequestUrl(request: BunRequest): string {
    return request.originalUrl;
  }

  public normalizePath(path: string): string {
    try {
      const convertedPath = LegacyRouteConverter.tryConvert(path);
      // Call "pathToRegexp" to trigger a TypeError if the path is invalid.
      pathToRegexp(convertedPath);
      return convertedPath;
    } catch (e) {
      if (e instanceof TypeError) {
        LegacyRouteConverter.printError(path);
      }
      throw e;
    }
  }

  public createMiddlewareFactory(
    requestMethod: RequestMethod,
  ): (path: string, callback: Function) => any {
    return (path: string, callback: Function) => {
      const convertedPath = LegacyRouteConverter.tryConvert(path);
      return this.engine.register(
        requestMethod,
        convertedPath,
        callback as any,
      );
    };
  }

  public initHttpServer(options: NestApplicationOptions) {
    this.httpsOptions = options?.httpsOptions;
  }

  public registerParserMiddleware(prefix?: string, rawBody?: boolean) {
    this.engine.registerParserMiddleware(!!rawBody);
  }

  public listen(port: string | number, callback?: () => void): any;
  public listen(
    port: string | number,
    hostname: string,
    callback?: () => void,
  ): any;
  public listen(port: string | number, ...args: any[]): any {
    const callback =
      typeof args[args.length - 1] === 'function'
        ? (args[args.length - 1] as () => void)
        : undefined;
    const hostname = typeof args[0] === 'string' ? args[0] : undefined;

    this.httpServer = this.engine.serve({
      port: Number(port),
      hostname,
      tls: this.httpsOptions
        ? {
            key: this.httpsOptions.key,
            cert: this.httpsOptions.cert,
            ca: this.httpsOptions.ca,
            passphrase: this.httpsOptions.passphrase,
          }
        : undefined,
    });
    callback?.();
    return this.httpServer;
  }

  public async close() {
    if (!this.httpServer) {
      return undefined;
    }
    // `stop(true)` closes active connections for graceful shutdown.
    return this.httpServer.stop(true);
  }

  public useStaticAssets(...args: any[]) {
    throw NOT_SUPPORTED('Static assets (useStaticAssets)');
  }

  public setViewEngine(engine: string) {
    throw NOT_SUPPORTED('View engine (setViewEngine)');
  }

  public enableCors(options?: any, prefix?: string) {
    throw NOT_SUPPORTED('CORS (enableCors)');
  }

  public setOnRequestHook(
    onRequestHook: (
      req: BunRequest,
      res: BunResponse,
      done: () => void,
    ) => Promise<void> | void,
  ) {
    this.engine.setOnRequestHook(onRequestHook);
  }

  public setOnResponseHook(
    onResponseHook: (req: BunRequest, res: BunResponse) => Promise<void> | void,
  ) {
    this.engine.setOnResponseHook(onResponseHook);
  }

  public getType(): string {
    return 'bun';
  }

  public applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): VersionedRoute {
    const callNextHandler: VersionedRoute = (req, res, next) => {
      if (!next) {
        throw new Error('HTTP adapter does not support filtering on version');
      }
      return next();
    };

    if (
      version === VERSION_NEUTRAL ||
      // URL Versioning is done via the path, so the filter continues forward.
      versioningOptions.type === VersioningType.URI
    ) {
      const handlerForNoVersioning: VersionedRoute = (req, res, next) =>
        handler(req, res, next);

      return handlerForNoVersioning;
    }

    // Custom Extractor Versioning Handler
    if (versioningOptions.type === VersioningType.CUSTOM) {
      const handlerForCustomVersioning: VersionedRoute = (req, res, next) => {
        const extractedVersion = versioningOptions.extractor(req);

        if (Array.isArray(version)) {
          if (
            Array.isArray(extractedVersion) &&
            version.filter(v => extractedVersion.includes(v as string)).length
          ) {
            return handler(req, res, next);
          }

          if (
            isString(extractedVersion) &&
            version.includes(extractedVersion)
          ) {
            return handler(req, res, next);
          }
        } else if (isString(version)) {
          if (
            Array.isArray(extractedVersion) &&
            extractedVersion.includes(version)
          ) {
            return handler(req, res, next);
          }

          if (isString(extractedVersion) && version === extractedVersion) {
            return handler(req, res, next);
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForCustomVersioning;
    }

    // Media Type (Accept Header) Versioning Handler
    if (versioningOptions.type === VersioningType.MEDIA_TYPE) {
      const handlerForMediaTypeVersioning: VersionedRoute = (
        req,
        res,
        next,
      ) => {
        const MEDIA_TYPE_HEADER = 'Accept';
        const acceptHeaderValue: string | undefined =
          req.headers?.[MEDIA_TYPE_HEADER] ||
          req.headers?.[MEDIA_TYPE_HEADER.toLowerCase()];

        const acceptHeaderVersionParameter = acceptHeaderValue
          ? acceptHeaderValue.split(';')[1]
          : undefined;

        if (isUndefined(acceptHeaderVersionParameter)) {
          if (Array.isArray(version)) {
            if (version.includes(VERSION_NEUTRAL)) {
              return handler(req, res, next);
            }
          }
        } else {
          const headerVersion = acceptHeaderVersionParameter.split(
            versioningOptions.key,
          )[1];

          if (Array.isArray(version)) {
            if (version.includes(headerVersion)) {
              return handler(req, res, next);
            }
          } else if (isString(version)) {
            if (version === headerVersion) {
              return handler(req, res, next);
            }
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForMediaTypeVersioning;
    }

    // Header Versioning Handler
    if (versioningOptions.type === VersioningType.HEADER) {
      const handlerForHeaderVersioning: VersionedRoute = (req, res, next) => {
        const customHeaderVersionParameter: string | undefined =
          req.headers?.[versioningOptions.header] ||
          req.headers?.[versioningOptions.header.toLowerCase()];

        if (isUndefined(customHeaderVersionParameter)) {
          if (Array.isArray(version)) {
            if (version.includes(VERSION_NEUTRAL)) {
              return handler(req, res, next);
            }
          }
        } else {
          if (Array.isArray(version)) {
            if (version.includes(customHeaderVersionParameter)) {
              return handler(req, res, next);
            }
          } else if (isString(version)) {
            if (version === customHeaderVersionParameter) {
              return handler(req, res, next);
            }
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForHeaderVersioning;
    }

    throw new Error('Unsupported versioning options');
  }

  private setHeaderIfNotExists(
    response: BunResponse,
    name: string,
    value?: string | string[] | number,
  ) {
    if (value !== undefined && response.getHeader(name) == null) {
      const headerValue = Array.isArray(value) ? value.join(',') : value;
      response.setHeader(name, headerValue);
    }
  }

  private applyStreamHeaders(
    response: BunResponse,
    streamable: StreamableFile,
  ) {
    const headers = streamable.getHeaders();

    this.setHeaderIfNotExists(response, 'Content-Type', headers.type);
    this.setHeaderIfNotExists(
      response,
      'Content-Disposition',
      headers.disposition,
    );
    this.setHeaderIfNotExists(response, 'Content-Length', headers.length);
  }
}
