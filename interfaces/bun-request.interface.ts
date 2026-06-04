/**
 * Plain request object exposed to the Nest request pipeline. Its shape mirrors
 * the surface read by `RouteParamsFactory` (`req.body`, `req.params`,
 * `req.query`, `req.headers`, etc.) so guards, pipes, interceptors, and param
 * decorators work unchanged.
 *
 * @publicApi
 */
export interface BunRequest {
  /** HTTP method (uppercase, e.g. `GET`). */
  method: string;
  /** Path + query string (Express `originalUrl` equivalent). */
  originalUrl: string;
  /** Path + query string. */
  url: string;
  /** Pathname only, used for route matching. */
  path: string;
  /** Request hostname. */
  hostname: string;
  /** Lowercased header map. */
  headers: Record<string, string>;
  /** Parsed query parameters. */
  query: Record<string, string>;
  /** Path parameters extracted from the matched route. */
  params: Record<string, string>;
  /** Host parameters populated by the host filter. */
  hosts: Record<string, any>;
  /** Parsed request body (populated by the parser middleware). */
  body?: any;
  /** Raw request body buffer (populated when `rawBody` is enabled). */
  rawBody?: Buffer;
  /** Session object (when a session middleware is installed). */
  session?: any;
  /** Uploaded file(s) (when a file interceptor is installed). */
  file?: any;
  files?: any;
  /** Remote address. */
  ip?: string;
  /** Underlying Web `Request`. */
  raw: Request;
  [key: string]: any;
}
