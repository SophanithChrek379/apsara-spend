/**
 * The one ordering for transaction rows.
 *
 * The dashboard list and the report's "Recent entries" show the same rows, so
 * they have to agree: the same two entries appearing in opposite orders in the
 * two places reads as a bug. That used to be held together by a comment in each
 * file; it lives here instead so there is only one sort to keep correct.
 */

import type { Transaction } from "@/lib/types";
import { clockMinutes, dayFromIso } from "@/lib/calendar-day";

/**
 * Newest first, by what the row *displays*: calendar day, then time of day.
 *
 * `date` only names a day — every entry on 07 Oct compares equal on it — so the
 * within-day order has to come from the clock time printed under each row
 * (`time`, or the local reading of `createdAt` when the user picked none).
 * Sorting on `createdAt` alone instead put rows in the order they were *typed*,
 * which is why a 5PM snack logged in the morning sat above an 8AM coffee logged
 * after it.
 *
 * `createdAt` stays on as the tiebreak for two entries at the same minute, and
 * `id` below it, so the order is stable across renders rather than reshuffling.
 *
 * `now` is read once per sort, not per comparison: a comparator whose own keys
 * move mid-sort is not a consistent ordering.
 */
export const makeByNewest = (now = new Date()) => {
  const nowIso = now.toISOString();
  return (a: Transaction, b: Transaction): number =>
    dayFromIso(b.date).localeCompare(dayFromIso(a.date)) ||
    clockMinutes(b.time, b.createdAt, now) - clockMinutes(a.time, a.createdAt, now) ||
    (b.createdAt ?? nowIso).localeCompare(a.createdAt ?? nowIso) ||
    b.id.localeCompare(a.id);
};
