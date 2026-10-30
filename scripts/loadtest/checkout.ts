/**
 * Checkout load test: closed-loop virtual users, each repeating
 *   merchant creates a payment link -> buyer opens /pay/:token
 *   -> GET /v1/payment-links/:token -> POST /v1/payment-links/:token/pay
 * at increasing concurrency, then checks the money side stayed correct.
 *
 *   BASE_URL=https://157-245-99-130.sslip.io \
 *   MERCHANT_ID=... EMAIL=owner@alpharetail.example PASSWORD=... \
 *   npx tsx scripts/loadtest/checkout.ts --stages 5,10,20,40 --duration 30
 *
 * Needs OTP_DEV_EXPOSE=true on the target (demo only) to log in unattended.
 * A 503 from the api is load shedding: the virtual user waits Retry-After and
 * retries the same step with the same Idempotency-Key, as a real client would.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

interface Args {
  baseUrl: string;
  merchantId: string;
  email: string;
  password: string;
  stages: number[];
  durationSec: number;
  doublePayEvery: number;
  maxRetries: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`loadtest: ${name} is required`);
    return v;
  };
  return {
    baseUrl: need("BASE_URL").replace(/\/$/, ""),
    merchantId: need("MERCHANT_ID"),
    email: need("EMAIL"),
    password: need("PASSWORD"),
    stages: (flag("stages") ?? "5,10,20,40").split(",").map((s) => Number.parseInt(s, 10)),
    durationSec: Number.parseInt(flag("duration") ?? "30", 10),
    doublePayEvery: Number.parseInt(flag("double-pay-every") ?? "20", 10),
    maxRetries: Number.parseInt(flag("max-retries") ?? "5", 10),
  };
}

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

interface StageStats {
  vus: number;
  checkouts: number;
  declined: number;
  latencies: number[];
  status: Map<string, number>;
  shed: number;
  serverErrors: number;
  networkErrors: number;
  doublePayProbes: number;
  doublePayViolations: number;
  paidTokens: string[];
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(args: Args): Promise<string> {
  const res = await fetch(`${args.baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchantId: args.merchantId, email: args.email, password: args.password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { devOtpCode?: string };
  if (!body.devOtpCode) throw new Error("login: no devOtpCode in response (set OTP_DEV_EXPOSE=true on the target)");
  const pending = cookieFrom(res);

  const verify = await fetch(`${args.baseUrl}/v1/auth/otp/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: pending },
    body: JSON.stringify({ code: body.devOtpCode }),
  });
  if (!verify.ok) throw new Error(`otp verify failed: ${verify.status} ${await verify.text()}`);
  return cookieFrom(verify);
}

function cookieFrom(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("fp_sid="));
  if (!set) throw new Error("no fp_sid cookie in response");
  return set.split(";", 1)[0]!;
}

/** One HTTP step with load-shedding retries. Returns the final response. */
async function step(
  stats: StageStats,
  args: Args,
  label: string,
  doFetch: () => Promise<Response>,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= args.maxRetries; attempt += 1) {
    let res: Response;
    try {
      res = await doFetch();
    } catch {
      stats.networkErrors += 1;
      bump(stats.status, `${label}:network`);
      return null;
    }
    bump(stats.status, `${label}:${res.status}`);
    if (res.status === 503) {
      stats.shed += 1;
      await res.arrayBuffer();
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "1", 10);
      await sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
      continue;
    }
    if (res.status >= 500 && res.status !== 502) stats.serverErrors += 1;
    return res;
  }
  return null;
}

async function createLink(stats: StageStats, args: Args, cookie: string): Promise<string | null> {
  const res = await step(stats, args, "create", () =>
    fetch(`${args.baseUrl}/v1/merchants/${args.merchantId}/payment-links`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        amountFils: 1000 + Math.floor(Math.random() * 49_000),
        reference: `load-${randomUUID().slice(0, 8)}`,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    }),
  );
  if (!res || res.status !== 201) {
    await res?.arrayBuffer();
    return null;
  }
  return ((await res.json()) as { token: string }).token;
}

async function pay(stats: StageStats, args: Args, token: string): Promise<Response | null> {
  const idempotencyKey = randomUUID();
  return step(stats, args, "pay", () =>
    fetch(`${args.baseUrl}/v1/payment-links/${token}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ card: CARD }),
    }),
  );
}

async function checkoutOnce(stats: StageStats, args: Args, cookie: string, iteration: number): Promise<void> {
  const token = await createLink(stats, args, cookie);
  if (!token) return;

  const started = performance.now();
  const page = await step(stats, args, "page", () => fetch(`${args.baseUrl}/pay/${token}`));
  await page?.arrayBuffer();
  const read = await step(stats, args, "read", () => fetch(`${args.baseUrl}/v1/payment-links/${token}`));
  await read?.arrayBuffer();

  if (args.doublePayEvery > 0 && iteration % args.doublePayEvery === 0) {
    stats.doublePayProbes += 1;
    const results = await Promise.all([pay(stats, args, token), pay(stats, args, token)]);
    const paid = results.filter((r) => r?.status === 200).length;
    for (const r of results) await r?.arrayBuffer();
    if (paid > 1) stats.doublePayViolations += 1;
    if (paid >= 1) stats.paidTokens.push(token);
    stats.latencies.push(performance.now() - started);
    if (paid >= 1) stats.checkouts += 1;
    return;
  }

  const res = await pay(stats, args, token);
  const elapsed = performance.now() - started;
  if (!res) return;
  const body = (await res.json().catch(() => ({}))) as { status?: string };
  if (res.status === 200 && body.status === "paid") {
    stats.checkouts += 1;
    stats.latencies.push(elapsed);
    stats.paidTokens.push(token);
  } else if (res.status === 402) {
    stats.declined += 1;
  }
}

async function runStage(args: Args, cookie: string, vus: number): Promise<StageStats> {
  const stats: StageStats = {
    vus,
    checkouts: 0,
    declined: 0,
    latencies: [],
    status: new Map(),
    shed: 0,
    serverErrors: 0,
    networkErrors: 0,
    doublePayProbes: 0,
    doublePayViolations: 0,
    paidTokens: [],
  };
  const deadline = performance.now() + args.durationSec * 1000;
  let iteration = 0;
  await Promise.all(
    Array.from({ length: vus }, async () => {
      while (performance.now() < deadline) {
        iteration += 1;
        await checkoutOnce(stats, args, cookie, iteration);
      }
    }),
  );
  return stats;
}

async function verifyPaid(args: Args, tokens: string[]): Promise<{ checked: number; notPaid: number }> {
  let notPaid = 0;
  const sample = tokens.length > 200 ? tokens.filter((_, i) => i % Math.ceil(tokens.length / 200) === 0) : tokens;
  for (const token of sample) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await fetch(`${args.baseUrl}/v1/payment-links/${token}`);
      if (res.status === 503) {
        await res.arrayBuffer();
        await sleep(1000);
        continue;
      }
      const body = (await res.json()) as { status?: string };
      if (body.status !== "paid") notPaid += 1;
      break;
    }
  }
  return { checked: sample.length, notPaid };
}

function report(s: StageStats, durationSec: number): string {
  const sorted = [...s.latencies].sort((a, b) => a - b);
  const fmt = (n: number) => (Number.isNaN(n) ? "-" : `${Math.round(n)}ms`);
  return [
    `VUs=${String(s.vus).padStart(3)}`,
    `checkouts=${String(s.checkouts).padStart(5)}`,
    `rate=${(s.checkouts / durationSec).toFixed(1).padStart(5)}/s`,
    `p50=${fmt(percentile(sorted, 50))}`,
    `p95=${fmt(percentile(sorted, 95))}`,
    `p99=${fmt(percentile(sorted, 99))}`,
    `declined=${s.declined}`,
    `shed503=${s.shed}`,
    `5xx=${s.serverErrors}`,
    `net=${s.networkErrors}`,
    `doublePay=${s.doublePayViolations}/${s.doublePayProbes}`,
  ].join("  ");
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`target ${args.baseUrl}, stages ${args.stages.join(",")} VUs x ${args.durationSec}s`);
  const cookie = await login(args);

  const results: StageStats[] = [];
  for (const vus of args.stages) {
    const stats = await runStage(args, cookie, vus);
    results.push(stats);
    console.log(report(stats, args.durationSec));
    console.log(
      "  status:",
      [...stats.status.entries()]
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    );
    await sleep(5000);
  }

  const allPaid = results.flatMap((r) => r.paidTokens);
  const check = await verifyPaid(args, allPaid);
  const violations = results.reduce((n, r) => n + r.doublePayViolations, 0);
  console.log(
    `\ncorrectness: ${check.checked} paid links re-read, ${check.notPaid} not 'paid'; ` +
      `double-pay probes with two 200s: ${violations}`,
  );
  if (check.notPaid > 0 || violations > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
