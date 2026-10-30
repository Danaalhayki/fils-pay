// Live-site screenshots for the submission (headless Edge over CDP).
//   node docs/submission/screenshots.mjs [--refunds]
// --refunds first makes one partial and one full refund on the demo merchant.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://157-245-99-130.sslip.io";
const HOST = "157-245-99-130.sslip.io";
const MERCHANT = "9972daab-2c86-459f-9d78-3fe1be4e3280";
const DEMO_LINK = "plink_nIFfk8f_0WcfUkx-unpM0A";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "img");
mkdirSync(OUT, { recursive: true });

const cookieOf = (res, name) => {
  const c = res.headers.getSetCookie().find((s) => s.startsWith(`${name}=`));
  if (!c) throw new Error(`no ${name} cookie`);
  return c.split(";", 1)[0].slice(name.length + 1);
};

async function loginMerchant() {
  const l = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchantId: MERCHANT, email: "owner@alpharetail.example", password: "FilsPaySeed!2026" }),
  });
  const { devOtpCode } = await l.json();
  const v = await fetch(`${BASE}/v1/auth/otp/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `fp_sid=${cookieOf(l, "fp_sid")}` },
    body: JSON.stringify({ code: devOtpCode }),
  });
  return cookieOf(v, "fp_sid");
}

async function loginAdmin() {
  const l = await fetch(`${BASE}:8443/v1/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "superadmin@filspay.test", password: "FilsPayAdminSeed!2026" }),
  });
  const { devOtpCode } = await l.json();
  const v = await fetch(`${BASE}:8443/v1/admin/auth/otp/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `fp_admin_sid=${cookieOf(l, "fp_admin_sid")}` },
    body: JSON.stringify({ code: devOtpCode }),
  });
  return cookieOf(v, "fp_admin_sid");
}

async function makeRefunds(sid) {
  const list = await (await fetch(`${BASE}/v1/transactions?status=captured&limit=10`, { headers: { cookie: `fp_sid=${sid}` } })).json();
  const rows = list.data ?? list.items ?? list.transactions ?? list;
  const [a, b] = rows.filter((t) => (t.amountCapturedFils ?? t.capturedFils ?? 0) >= 2000);
  const out = {};
  for (const [label, txn, amount] of [["partial", a, Math.floor((a.amountCapturedFils ?? a.capturedFils) / 2)], ["full", b, undefined]]) {
    const res = await fetch(`${BASE}/v1/merchants/${MERCHANT}/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `fp_sid=${sid}`, "idempotency-key": randomUUID() },
      body: JSON.stringify({ transactionId: txn.id, ...(amount ? { amountFils: amount } : {}), reason: `judge demo ${label} refund` }),
    });
    console.log(label, txn.id, res.status, (await res.text()).slice(0, 200));
    out[label] = txn.id;
  }
  writeFileSync(join(OUT, "refunds.json"), JSON.stringify(out, null, 2));
  return out;
}

function findBrowser() {
  return [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].find((p) => existsSync(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpSession(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        };
        const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
        return { send, close: () => ws.close() };
      }
    } catch {}
    await sleep(250);
  }
  throw new Error("no CDP page");
}

async function shot(s, url, file, waitMs = 3500) {
  await s.send("Page.navigate", { url });
  await sleep(waitMs);
  const { result } = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, file), Buffer.from(result.data, "base64"));
  console.log("saved", file);
}

const sid = await loginMerchant();
let refunds = existsSync(join(OUT, "refunds.json")) ? JSON.parse((await import("node:fs")).readFileSync(join(OUT, "refunds.json"), "utf8")) : null;
if (process.argv.includes("--refunds") || !refunds) refunds = await makeRefunds(sid);
const adminSid = await loginAdmin();

const port = 9333;
const browser = spawn(findBrowser(), [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1366,900",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "fp-shots-"))}`, "about:blank",
], { stdio: "ignore" });

try {
  const s = await cdpSession(port);
  await s.send("Page.enable");
  await s.send("Network.enable");
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });

  await shot(s, `${BASE}/`, "08-root-redirect-after.png");
  await shot(s, `${BASE}/pay/${DEMO_LINK}`, "10-checkout-after.png");

  await s.send("Network.setCookie", { name: "fp_sid", value: sid, domain: HOST, path: "/", secure: true, httpOnly: true });
  await shot(s, `${BASE}/dashboard/transactions`, "09-transactions-after.png");
  await shot(s, `${BASE}/dashboard/transactions/${refunds.partial}`, "01-partial-refund-after.png");
  await shot(s, `${BASE}/dashboard/transactions/${refunds.full}`, "03-full-refund-after.png");
  await shot(s, `${BASE}/dashboard/overview`, "05-overview-after.png");
  await shot(s, `${BASE}/dashboard/settlement`, "11-settlement-after.png");
  await shot(s, `${BASE}/dashboard/reconciliation`, "12-reconciliation-after.png");

  await s.send("Network.setCookie", { name: "fp_admin_sid", value: adminSid, domain: HOST, path: "/", secure: true, httpOnly: true });
  await shot(s, `${BASE}:8443/`, "13-admin-after.png");
  await shot(s, `${BASE}:8443/merchants/${MERCHANT}`, "06-admin-merchant-after.png");
  s.close();
} finally {
  browser.kill();
}
