import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { bareHostname, isPrivateAddress, publicOnlyLookup } from "./egressGuard.js";

/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body.
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** Only an excerpt of the receiver's reply is ever stored or shown. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface FetchTransportOptions {
  /** Permit loopback/private targets (local receivers in dev and tests). Never in production. */
  allowPrivateNetwork?: boolean;
}

/**
 * Real transport used by index.ts's production wiring. Redirects are not
 * followed (a 3xx is just the receiver's answer), and outside of
 * `allowPrivateNetwork` the socket may only connect to a public address.
 */
export function createFetchTransport(options: FetchTransportOptions = {}): WebhookTransport {
  const allowPrivateNetwork = options.allowPrivateNetwork ?? process.env.NODE_ENV !== "production";

  return (req: WebhookTransportRequest): Promise<WebhookTransportResponse> =>
    new Promise((resolve) => {
      const fail = (message: string) => resolve({ statusCode: null, body: "", errorMessage: message });

      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return fail("invalid webhook url");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return fail("unsupported webhook url scheme");
      }
      if (!allowPrivateNetwork && isPrivateAddress(bareHostname(url))) {
        return fail("webhook target is a non-public address");
      }

      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(
        url,
        {
          method: "POST",
          headers: { ...req.headers, "Content-Length": String(Buffer.byteLength(req.body)) },
          ...(allowPrivateNetwork ? {} : { lookup: publicOnlyLookup }),
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            if (size >= MAX_RESPONSE_BYTES) return;
            chunks.push(chunk);
            size += chunk.length;
          });
          response.on("end", () => {
            clearTimeout(timer);
            resolve({
              statusCode: response.statusCode ?? null,
              body: Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString("utf8"),
            });
          });
          response.on("error", (err) => {
            clearTimeout(timer);
            fail(err.message);
          });
        },
      );
      const timer = setTimeout(() => request.destroy(new Error("webhook request timed out")), req.timeoutMs);
      request.on("error", (err) => {
        clearTimeout(timer);
        fail(err.message);
      });
      request.end(req.body);
    });
}
