---
name: loadtest
description: Run the checkout load test against a FilsPay deployment and turn the output into the capacity table in ops/CAPACITY.md.
disable-model-invocation: true
---

1. Needs `BASE_URL`, `MERCHANT_ID`, `EMAIL`, `PASSWORD` in the environment
   and `OTP_DEV_EXPOSE=true` on the target (demo only).
2. Run `npx tsx scripts/loadtest/checkout.ts --stages 5,10,20,50 --duration 30`
   (on Windows PowerShell use `npx.cmd`). For overload behaviour add a run
   with `--stages 100,150`.
3. While it runs, ask the operator for `docker stats` on the server to see
   which container saturates.
4. Read the output: `402` and `502` on pay are the simulator's
   `ACQUIRER_FAILURE_RATE`, `409` is the refused second pay of a double-pay
   probe, `503` is load shedding. Real faults are `5xx` (other than 502),
   `net` errors, any probe with two `200`s, or a paid link not `paid`.
5. Add a dated table to `ops/CAPACITY.md` and adjust the estimate.
