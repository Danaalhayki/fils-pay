import type { FastifyInstance } from "fastify";
import { requireMerchantAuth, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { runTransactionsReportPage, type TransactionReportFilter } from "../reporting/transactionsReportQuery.js";
import { resolveReportMerchantId } from "../reporting/scope.js";
import { createSavedFilter, listSavedFilters } from "../reporting/savedFilters.js";
import { BadRequestError } from "../lib/errors.js";
import { bahrainMidnightUtc, isValidDateString } from "../lib/dateParams.js";

interface ReportQuery {
  filter?: string;
}

/**
 * `from`/`to` take either YYYY-MM-DD (the Asia/Bahrain business day, per
 * ARCHITECTURE §3; `to` exclusive) or a full ISO timestamp with offset.
 */
function parseReportFilter(raw: unknown): Partial<TransactionReportFilter> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadRequestError("invalid_filter", "filter must be a JSON object");
  }
  const { merchantId, status, from, to } = raw as Record<string, unknown>;
  for (const [name, value] of Object.entries({ merchantId, status })) {
    if (value !== undefined && typeof value !== "string") {
      throw new BadRequestError("invalid_filter", `${name} must be a string`);
    }
  }
  return {
    merchantId: merchantId as string | undefined,
    status: status as string | undefined,
    from: parseReportBound(from, "from"),
    to: parseReportBound(to, "to"),
  };
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseReportBound(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (isValidDateString(value)) return bahrainMidnightUtc(value).toISOString();
  if (typeof value === "string" && ISO_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new BadRequestError("invalid_filter", `${name} must be YYYY-MM-DD or an ISO timestamp with offset`);
}

interface SaveFilterBody {
  name?: string;
  filter?: Record<string, unknown>;
}

/**
 * Registered with prefix '/v1/reporting'. `requireMerchantAuth` only, same
 * authorization level as `/v1/analytics/*` — nothing here is more sensitive
 * than a merchant reading their own transaction list already is (in the
 * intended, single-merchant case).
 */
export async function reportingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ReportQuery }>(
    "/transactions",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      let parsed: unknown = {};
      if (request.query.filter) {
        try {
          parsed = JSON.parse(request.query.filter);
        } catch {
          throw new BadRequestError("invalid_filter", "filter must be valid JSON");
        }
      }
      const filter = parseReportFilter(parsed);

      const merchantId = await resolveReportMerchantId(
        app.db,
        request.merchantAuth!.merchantId,
        filter.merchantId,
      );

      const report = await runTransactionsReportPage(app.db, { ...filter, merchantId });
      reply.header("x-report-truncated", String(report.truncated));
      return report.rows;
    },
  );

  app.post<{ Body: SaveFilterBody }>(
    "/saved-filters",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      requireMerchantWriterActor(request.merchantAuth!);
      const { name, filter } = request.body ?? {};
      if (!name || typeof name !== "string" || name.length > 100) {
        throw new BadRequestError("invalid_request", "name is required (at most 100 characters)");
      }
      if (!filter || typeof filter !== "object" || Array.isArray(filter) || JSON.stringify(filter).length > 8_192) {
        throw new BadRequestError("invalid_request", "filter is required and must be a JSON object under 8 KB");
      }

      const saved = await createSavedFilter(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        name,
        filter,
      });
      reply.code(201).send(saved);
    },
  );

  app.get(
    "/saved-filters",
    { preHandler: requireMerchantAuth },
    async (request) => listSavedFilters(app.db, { merchantId: request.merchantAuth!.merchantId }),
  );

  app.get("/export-summary", { preHandler: requireMerchantAuth }, async (request) => {
    const result = await app.db.query(
      `SELECT COUNT(*) AS total, SUM(captured_gross_fils) AS gross
         FROM merchant_daily_volume WHERE merchant_id = $1`,
      [request.merchantAuth!.merchantId],
    );
    return { totalDays: Number(result.rows[0]?.total ?? 0), grossFils: Number(result.rows[0]?.gross ?? 0) };
  });
}
