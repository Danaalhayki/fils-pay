import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { recordKycReviewInTx } from "../onboarding/review.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  adminEmail: string;
  notes?: string;
}

/**
 * @property approvedMerchantIds Only merchants that moved from under_review to approved.
 * Already-approved or rejected ids are skipped and not listed.
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

/**
 * Approves the given merchants that are under_review and audits it. Each
 * approval goes through recordKycReviewInTx (the one permitted writer of
 * kyc_passed), so every merchant gets its own merchant_kyc_reviews row.
 */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  return withTransaction(pool, async (client) => {
    const eligible = await client.query<{ id: string }>(
      `SELECT id FROM merchants
        WHERE id = ANY($1::uuid[]) AND onboarding_status = 'under_review'
        ORDER BY id
        FOR UPDATE`,
      [input.merchantIds],
    );
    const approvedMerchantIds = eligible.rows.map((row) => row.id);

    for (const merchantId of approvedMerchantIds) {
      await recordKycReviewInTx(client, {
        merchantId,
        outcome: "approved",
        reviewerIdentifier: input.adminEmail,
        reviewerAdminUserId: input.adminUserId,
        notes: input.notes,
      });
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds };
  });
}
