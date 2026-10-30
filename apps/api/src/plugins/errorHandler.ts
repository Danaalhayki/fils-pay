import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { formatIsoDate } from "../lib/dateFormat.js";

/**
 * Uniform error -> HTTP response mapping. Every route across the API
 * should throw an `AppError` subclass; this is the single place that turns
 * one into `{ "error": "code", "message"?: "string" }`.
 */
/** invalid_text_representation, numeric_value_out_of_range, invalid_datetime_format, datetime_field_overflow. */
const PG_INVALID_INPUT_CODES = new Set(["22P02", "22003", "22007", "22008"]);

const PG_POOL_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }

  const fastifyErr = err as FastifyError;

  // YA: 400 not 422 for schema validation errors — API.md section 2. correct
  if (fastifyErr.validation) {
    reply.code(400).send({ error: "validation_error", message: fastifyErr.message });
    return;
  }

  if (fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr.code === "FST_FILES_LIMIT") {
    reply.code(413).send({ error: "file_too_large", message: fastifyErr.message });
    return;
  }

  // Framework-raised client errors (malformed JSON, unsupported media type,
  // body too large, ...) carry their own 4xx status.
  const status = fastifyErr.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    reply.code(status).send({ error: "bad_request", message: fastifyErr.message });
    return;
  }

  // Postgres rejected a client-supplied value while casting a parameter
  // (a non-UUID path id, an impossible date, an out-of-range number).
  if (PG_INVALID_INPUT_CODES.has(fastifyErr.code)) {
    request.log.warn({ err }, "invalid input rejected by postgres");
    reply.code(400).send({ error: "invalid_input" });
    return;
  }

  // pg-pool gave up waiting for a free connection: the database is saturated,
  // not broken, and nothing was written, so the client may retry.
  if (err.message === PG_POOL_TIMEOUT_MESSAGE) {
    request.log.warn("database pool exhausted");
    reply.code(503).header("Retry-After", "1").send({ error: "overloaded", reason: "db_pool_timeout" });
    return;
  }

  request.log.error({ err, occurredOn: formatIsoDate(new Date()) }, "unhandled error");
  reply.code(500).send({ error: "internal_error" });
}
