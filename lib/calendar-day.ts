/**
 * An expense happens on a calendar day, not at an instant.
 *
 * `Transaction.date` stays an ISO string — the cache, the backup format and the
 * diff all compare it as an opaque string — but what it *denotes* is a day, and
 * a day has no timezone. The canonical form is therefore anchored at noon UTC:
 *
 *     2026-07-27   ⇄   "2026-07-27T12:00:00.000Z"
 *
 * WHY NOON, AND WHAT WENT WRONG BEFORE
 *
 * The previous anchor was *local* midnight: `new Date("2026-07-27T00:00:00")`.
 * In Cambodia (UTC+7) that serialises to "2026-07-26T17:00:00.000Z" — already
 * the previous day in UTC. The client got away with it because it read the
 * instant back with local components. The server does not: `toSpentOn` read
 * `getFullYear()/getMonth()/getDate()`, which are *server*-local, and Node on
 * Vercel runs in UTC. So the day the user picked was written to `spent_on` one
 * day early, and reading it back showed yesterday.
 *
 * Noon is the fix because it is 12 hours from both midnights. Every offset in
 * real use (UTC-12 … UTC+14) leaves it inside the same calendar day, so the day
 * survives the round trip whether it is read with local or UTC components, on
 * the client, on the server, or on a device that has since changed timezone.
 *
 * Rule of thumb for anything added here: a calendar day must never be converted
 * to an instant and back using the *ambient* timezone. Use these helpers.
 */

const DAY_RE       = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T12:00:00\.000Z$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" → the canonical ISO form. */
export const isoFromDay = (day: string): string => `${day}T12:00:00.000Z`;

/**
 * Canonical ISO form → "YYYY-MM-DD".
 *
 * Deliberately UTC components, never local ones: the stored value already names
 * a specific day, so re-projecting it through whatever timezone this code
 * happens to be running in is exactly the bug this module exists to prevent.
 */
export const dayFromIso = (iso: string): string => {
  if (DAY_RE.test(iso)) return iso; // already a bare day
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** Month key ("YYYY-MM") for a stored transaction date. */
export const monthKeyFromIso = (iso: string): string => dayFromIso(iso).slice(0, 7);

/**
 * Human-readable day label: "2026-04-09" → "09 Apr 2026".
 *
 * Reads the day at local noon so no DST or timezone edge case can shift the
 * Date object onto the neighbouring calendar day.
 */
export const formatDisplayDate = (day: string): string => {
  if (!day) return "Select date";
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/** Today as the user's device reckons it — the right default for a date picker. */
export const todayDay = (d = new Date()): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Migrates a legacy local-midnight date to the canonical form.
 *
 * Legacy values are read with *local* components on purpose. That is how the
 * client has always interpreted them, so it is the day the user has been
 * looking at, and preserving it means the migration shifts nothing on screen.
 * It also means an edit made offline before this fix shipped flushes with the
 * day the user actually picked rather than the one UTC would have inferred.
 *
 * Applied when the cache is read, so the diff never compares a canonical value
 * against a legacy one and mistakes the difference for an un-pushed edit.
 */
export const canonicalizeIso = (iso: string): string => {
  if (typeof iso !== "string" || iso === "") return iso;
  if (CANONICAL_RE.test(iso)) return iso;
  if (DAY_RE.test(iso)) return isoFromDay(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // leave junk alone; validation rejects it
  return isoFromDay(todayDay(d));
};
