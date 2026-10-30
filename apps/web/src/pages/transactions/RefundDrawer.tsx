import { useState } from "react";
import { ApiError, request } from "../../api/client.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per refund attempt, not per click: a double-submit or a retry
  // after a network error must replay the same refund rather than issue a
  // second one. A new key is minted only when the request body changes or
  // after a refund succeeds.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const merchantId = me?.merchant.id;
  const refundableFils = Math.max(0, txn.capturedFils - txn.refundedFils);
  const refundable = REFUNDABLE_STATUSES.has(txn.status) && refundableFils > 0;

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || submitting) return;
    if (!window.confirm("Refund this transaction? The money goes back to the cardholder and cannot be recalled.")) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const trimmed = amount.trim();
      // Left blank, amountFils is omitted entirely and the API refunds
      // everything still refundable.
      const body = trimmed === "" ? { transactionId: txn.id } : { transactionId: txn.id, amountFils: Number(trimmed) };

      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });

      setOpen(false);
      setAmount("");
      setIdempotencyKey(crypto.randomUUID());
      await onRefunded();
    } catch (err) {
      // A definitive rejection is stored against the key and would replay
      // forever; only an in-flight conflict or a 5xx/network error retries it.
      if (err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 409) {
        setIdempotencyKey(crypto.randomUUID());
      }
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in fils (blank refunds everything still refundable)
              <input
                type="number"
                min={1}
                step={1}
                max={refundableFils}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setIdempotencyKey(crypto.randomUUID());
                }}
              />
            </label>
            <p className="dash-muted">Still refundable: {bhd(refundableFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
