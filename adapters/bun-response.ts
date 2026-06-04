import { Readable } from 'stream';

/**
 * A mutable response shim consumed by the Nest request pipeline.
 *
 * Bun's `fetch` handler must *return* a Web `Response`, but Nest writes
 * responses imperatively over the lifetime of the pipeline. `BunResponse`
 * accumulates status/headers/body and exposes a promise (`toResponse`) that the
 * `fetch` handler awaits. The first terminal call (`send`/`json`/`end`/
 * `redirect`) resolves the promise into a Web `Response`.
 *
 * @publicApi
 */
export class BunResponse {
  public statusCode = 200;
  public headersSent = false;
  public readonly locals: Record<string, any> = {};

  private readonly responseHeaders = new Headers();
  private readonly deferred: Promise<Response>;
  private resolveResponse!: (response: Response) => void;
  private settled = false;

  constructor() {
    this.deferred = new Promise<Response>(resolve => {
      this.resolveResponse = resolve;
    });
  }

  /**
   * Resolves once the response has been finalized. Awaited by the adapter's
   * `Bun.serve` fetch handler.
   */
  public toResponse(): Promise<Response> {
    return this.deferred;
  }

  public status(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  public setHeader(name: string, value: string | string[] | number): this {
    if (Array.isArray(value)) {
      this.responseHeaders.delete(name);
      value.forEach(v => this.responseHeaders.append(name, String(v)));
    } else {
      this.responseHeaders.set(name, String(value));
    }
    return this;
  }

  // Express-style alias used by parts of the pipeline.
  public set(name: string, value: string | string[] | number): this {
    return this.setHeader(name, value);
  }

  public getHeader(name: string): string | null {
    return this.responseHeaders.get(name);
  }

  // Express-style alias.
  public get(name: string): string | null {
    return this.getHeader(name);
  }

  public appendHeader(name: string, value: string | string[]): this {
    const values = Array.isArray(value) ? value : [value];
    values.forEach(v => this.responseHeaders.append(name, v));
    return this;
  }

  public append(name: string, value: string | string[]): this {
    return this.appendHeader(name, value);
  }

  public json(body: any): this {
    if (!this.responseHeaders.has('Content-Type')) {
      this.responseHeaders.set(
        'Content-Type',
        'application/json; charset=utf-8',
      );
    }
    return this.finalize(JSON.stringify(body));
  }

  public send(body?: any): this {
    if (body === undefined || body === null) {
      return this.finalize(null);
    }
    if (typeof body === 'object' && !(body instanceof Readable)) {
      return this.json(body);
    }
    return this.finalize(body);
  }

  public end(message?: string): this {
    return this.finalize(message ?? null);
  }

  public redirect(statusCode: number, url: string): this {
    this.statusCode = statusCode;
    this.responseHeaders.set('Location', url);
    return this.finalize(null);
  }

  /**
   * Builds the Web `Response` and resolves the deferred promise. Idempotent —
   * subsequent calls are ignored to mirror Node's "headers already sent"
   * behavior without throwing.
   */
  private finalize(body: BodyInit | Readable | null): this {
    if (this.settled) {
      return this;
    }
    this.settled = true;
    this.headersSent = true;

    const responseBody =
      body instanceof Readable
        ? (Readable.toWeb(body) as unknown as ReadableStream)
        : body;

    this.resolveResponse(
      new Response(responseBody, {
        status: this.statusCode,
        headers: this.responseHeaders,
      }),
    );
    return this;
  }
}
