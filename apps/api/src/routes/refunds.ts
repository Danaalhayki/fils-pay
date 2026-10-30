import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

interface MerchantIdParams {
  merchantId: string;
}

const MAX_REASON_LENGTH = 500;

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

function parseRefundBody(body: RefundBody | undefined): {
  transactionId: string;
  amountFils?: ReturnType<typeof toFils>;
  reason?: string;
} {
  const { transactionId, amountFils, reason } = body ?? {};
  if (typeof transactionId !== "string" || transactionId.length === 0) {
    throw new BadRequestError("transaction_id_required", "transactionId is required");
  }
  if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0)) {
    throw new BadRequestError("invalid_amount", "amountFils must be a positive integer number of fils");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH)) {
    throw new BadRequestError("invalid_reason", `reason must be a string of at most ${MAX_REASON_LENGTH} characters`);
  }
  return {
    transactionId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils),
    reason: reason === undefined || reason.trim() === "" ? undefined : reason.trim(),
  };
}

async function handleRefund(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: RefundBody }>,
  reply: FastifyReply,
  merchantId: string,
): Promise<void> {
  const idempotencyKey = getIdempotencyKey(request);
  const body = parseRefundBody(request.body);
  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    merchantId,
    transactionId: body.transactionId,
    amountFils: body.amountFils,
    reason: body.reason,
    idempotencyKey,
    actor: requireMerchantWriterActor(request.merchantAuth!),
  });
  reply.code(result.statusCode).send(result.body);
}

/** `POST /v1/refunds` — the partner API shape: merchant from the credential. */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      await handleRefund(app, request, reply, request.merchantAuth!.merchantId);
    },
  );
}

/** `POST /v1/merchants/:merchantId/refunds` — the dashboard shape. */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      await handleRefund(app, request, reply, request.params.merchantId);
    },
  );
}
