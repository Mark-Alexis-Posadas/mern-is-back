import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalyticsInputError, fillAnalyticsTrend, parseAnalyticsQuery } from "../src/services/adminAnalytics.service";

const now = new Date("2026-10-21T00:00:00Z");

test("preset ranges contain exactly 7/30/90 Manila calendar days", () => {
  for (const [range, days] of [["7d", 7], ["30d", 30], ["90d", 90]] as const) {
    const filters = parseAnalyticsQuery({ range }, now);
    assert.equal(filters.endExclusive.toISOString(), "2026-10-21T16:00:00.000Z");
    assert.equal((filters.endExclusive.getTime() - filters.start.getTime()) / 86_400_000, days);
    assert.equal(fillAnalyticsTrend(filters, []).length, days);
  }
  const afterMidnight = parseAnalyticsQuery({ range: "7d" }, new Date("2026-10-21T16:00:00Z"));
  assert.equal(afterMidnight.endDate, "2026-10-22");
});

test("strict custom dates reject invalid calendars, reversed, future, and excessive ranges", () => {
  for (const query of [
    { range: "custom" },
    { range: "custom", startDate: "2026-02-30", endDate: "2026-03-02" },
    { range: "custom", startDate: "2026-2-01", endDate: "2026-03-02" },
    { range: "custom", startDate: "2026-10-02", endDate: "2026-10-01" },
    { range: "custom", startDate: "2026-10-01", endDate: "2026-10-22" },
    { range: "custom", startDate: "2025-01-01", endDate: "2026-01-02" },
    { range: ["7d", "30d"] }, { range: "all" }, { interval: "year" },
    { interval: ["day"] }, { startDate: "2026-10-01" },
    { range: "custom", startDate: { $gt: "" }, endDate: "2026-10-01" },
  ]) assert.throws(() => parseAnalyticsQuery(query, now), AnalyticsInputError);
  const leap = parseAnalyticsQuery({ range: "custom", startDate: "2024-02-29", endDate: "2024-02-29" }, now);
  assert.equal(leap.start.toISOString(), "2024-02-28T16:00:00.000Z");
  assert.equal(leap.endExclusive.toISOString(), "2024-02-29T16:00:00.000Z");
  assert.doesNotThrow(() => parseAnalyticsQuery({ range: "custom", startDate: "2025-01-01", endDate: "2026-01-01" }, now));
});

test("trend zero filling aligns Mondays and month boundaries, including partial periods", () => {
  const filters = parseAnalyticsQuery({ range: "custom", startDate: "2026-09-30", endDate: "2026-10-07", interval: "week" }, now);
  assert.deepEqual(fillAnalyticsTrend(filters, [{ _id: new Date("2026-10-04T16:00:00Z"), revenue: 25, salesCount: 1 }]), [
    { date: "2026-09-28", revenue: 0, salesCount: 0 },
    { date: "2026-10-05", revenue: 25, salesCount: 1 },
  ]);
  const monthly = parseAnalyticsQuery({ range: "custom", startDate: "2025-12-31", endDate: "2026-02-01", interval: "month" }, now);
  assert.deepEqual(fillAnalyticsTrend(monthly, []).map((point) => point.date), ["2025-12-01", "2026-01-01", "2026-02-01"]);
});
