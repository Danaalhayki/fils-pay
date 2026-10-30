import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { recordKycDocument } from "./kyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("kycPdfOnly.new.test.ts requires DATABASE_URL");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 2 });

test.after(async () => {
  await pool.end();
});

test("a JPEG named cr.pdf is rejected for a PDF-only document type", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  await assert.rejects(
    recordKycDocument(pool, config, {
      merchantId: randomUUID(),
      documentType: "commercial_registration",
      fileName: "cr.pdf",
      buffer: jpeg,
      uploadedBy: randomUUID(),
    }),
    (err: { code?: string; error?: string; message?: string }) =>
      JSON.stringify(err).includes("document_must_be_pdf") || String(err.message).includes("document_must_be_pdf"),
  );
});
