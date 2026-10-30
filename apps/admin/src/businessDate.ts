/**
 * Asia/Bahrain business date (fixed UTC+3, no DST) as YYYY-MM-DD, offset by
 * `days`. Settlement and credit dates are Bahrain dates on the server, so
 * the console's defaults must not depend on the operator's browser zone.
 */
export function bahrainBusinessDate(days = 0): string {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000 + days * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
