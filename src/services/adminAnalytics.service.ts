import type { PipelineStage, Types } from "mongoose";
import { Order } from "../models/order.model";
import { ORDER_STATUSES } from "./adminOrder.service";

export const ANALYTICS_TIMEZONE = "Asia/Manila";
const DAY = 86_400_000;
const OFFSET = 8 * 60 * 60 * 1000;
export class AnalyticsInputError extends Error {}
export type AnalyticsInterval = "day" | "week" | "month";

export function parseAnalyticsQuery(
  query: Record<string, unknown>,
  now = new Date(),
) {
  const range = query.range ?? "30d";
  const interval = query.interval ?? "day";
  if (
    range !== "7d" &&
    range !== "30d" &&
    range !== "90d" &&
    range !== "custom"
  ) {
    throw new AnalyticsInputError("Range must be 7d, 30d, 90d, or custom.");
  }
  if (interval !== "day" && interval !== "week" && interval !== "month") {
    throw new AnalyticsInputError("Interval must be day, week, or month.");
  }
  const today = new Date(now.getTime() + OFFSET).toISOString().slice(0, 10);
  function date(value: unknown) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new AnalyticsInputError("Custom dates must use YYYY-MM-DD.");
    }
    const timestamp = Date.parse(`${value}T00:00:00+08:00`);
    if (
      !Number.isFinite(timestamp) ||
      new Date(timestamp + OFFSET).toISOString().slice(0, 10) !== value
    ) {
      throw new AnalyticsInputError("Invalid calendar date.");
    }
    return timestamp;
  }
  let start: number;
  let end: number;
  if (range === "custom") {
    start = date(query.startDate);
    end = date(query.endDate);
    if (end < start || end - start >= 366 * DAY) {
      throw new AnalyticsInputError(
        "Choose an ordered date range of at most 366 days.",
      );
    }
    if (String(query.endDate) > today) {
      throw new AnalyticsInputError("End date cannot be in the future.");
    }
  } else {
    if (query.startDate !== undefined || query.endDate !== undefined) {
      throw new AnalyticsInputError(
        "Use range=custom with startDate and endDate.",
      );
    }
    end = date(today);
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    start = end - (days - 1) * DAY;
  }
  return {
    range,
    interval: interval as AnalyticsInterval,
    start: new Date(start),
    endExclusive: new Date(end + DAY),
    startDate: new Date(start + OFFSET).toISOString().slice(0, 10),
    endDate: new Date(end + OFFSET).toISOString().slice(0, 10),
  };
}

export type AnalyticsFilters = ReturnType<typeof parseAnalyticsQuery>;
interface Summary {
  totalOrders: number;
  totalRevenue: number;
  salesCount: number;
  unitsSold: number;
}
interface Trend {
  _id: Date;
  revenue: number;
  salesCount: number;
}
interface ProductSales {
  _id: Types.ObjectId;
  name: string;
  sku: string;
  quantitySold: number;
  revenue: number;
}
interface RecentSale {
  _id: Types.ObjectId;
  createdAt: Date;
  total: number;
  orderStatus: string;
  quantity: number;
}
interface AnalyticsAggregate {
  summary: Summary[];
  statuses: { _id: string | null; count: number }[];
  trend: Trend[];
  topProducts: ProductSales[];
  recentSales: RecentSale[];
}
interface CollectionAggregate {
  summary: { totalRevenue: number; collectionCount: number }[];
  trend: Trend[];
}

// Payment must be explicitly recorded. Delivered COD orders are not implicitly paid.
const isSale = {
  $and: [
    { $eq: ["$paymentStatus", "paid"] },
    { $ne: ["$orderStatus", "cancelled"] },
  ],
};
const saleFilter = { paymentStatus: "paid", orderStatus: { $ne: "cancelled" } };
const quantity = {
  $sum: {
    $map: {
      input: { $ifNull: ["$items", []] },
      as: "item",
      in: "$$item.quantity",
    },
  },
};

export function buildAnalyticsPipeline(
  filters: AnalyticsFilters,
): PipelineStage[] {
  return [
    {
      $match: { createdAt: { $gte: filters.start, $lt: filters.endExclusive } },
    },
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              totalOrders: { $sum: 1 },
              totalRevenue: { $sum: { $cond: [isSale, "$total", 0] } },
              salesCount: { $sum: { $cond: [isSale, 1, 0] } },
              unitsSold: { $sum: { $cond: [isSale, quantity, 0] } },
            },
          },
          {
            $project: {
              _id: 0,
              totalOrders: 1,
              totalRevenue: 1,
              salesCount: 1,
              unitsSold: 1,
            },
          },
        ],
        statuses: [{ $group: { _id: "$orderStatus", count: { $sum: 1 } } }],
        trend: [
          { $match: saleFilter },
          {
            $group: {
              _id: {
                $dateTrunc: {
                  date: "$createdAt",
                  unit: filters.interval,
                  timezone: ANALYTICS_TIMEZONE,
                  ...(filters.interval === "week"
                    ? { startOfWeek: "monday" }
                    : {}),
                },
              },
              revenue: { $sum: "$total" },
              salesCount: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        topProducts: [
          { $match: saleFilter },
          { $sort: { createdAt: -1, _id: -1 } },
          { $unwind: "$items" },
          {
            $group: {
              _id: "$items.product",
              name: { $first: "$items.name" },
              sku: { $first: "$items.sku" },
              quantitySold: { $sum: "$items.quantity" },
              revenue: {
                $sum: { $multiply: ["$items.price", "$items.quantity"] },
              },
            },
          },
          { $sort: { quantitySold: -1, revenue: -1, _id: 1 } },
          { $limit: 10 },
        ],
        recentSales: [
          { $match: saleFilter },
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 10 },
          {
            $project: {
              _id: 1,
              createdAt: 1,
              total: 1,
              orderStatus: 1,
              quantity,
            },
          },
        ],
      },
    },
  ];
}

// Separate date-filtered scan: never place this after the createdAt filter above.
export function buildCollectionPipeline(
  filters: AnalyticsFilters,
): PipelineStage[] {
  return [
    {
      $match: {
        ...saleFilter,
        paymentMethod: "COD",
        paidAt: { $gte: filters.start, $lt: filters.endExclusive },
      },
    },
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: "$total" },
              collectionCount: { $sum: 1 },
            },
          },
        ],
        trend: [
          {
            $group: {
              _id: {
                $dateTrunc: {
                  date: "$paidAt",
                  unit: filters.interval,
                  timezone: ANALYTICS_TIMEZONE,
                  ...(filters.interval === "week"
                    ? { startOfWeek: "monday" }
                    : {}),
                },
              },
              revenue: { $sum: "$total" },
              salesCount: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ];
}

// Manila currently uses a fixed UTC+08 offset, with no daylight-saving changes.
function bucketStart(timestamp: number, interval: AnalyticsInterval) {
  const local = new Date(timestamp + OFFSET);
  local.setUTCHours(0, 0, 0, 0);
  if (interval === "month") local.setUTCDate(1);
  if (interval === "week")
    local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  return local.getTime() - OFFSET;
}

export function fillAnalyticsTrend(filters: AnalyticsFilters, rows: Trend[]) {
  const values = new Map(rows.map((row) => [new Date(row._id).getTime(), row]));
  const trend: { date: string; revenue: number; salesCount: number }[] = [];
  let cursor = bucketStart(filters.start.getTime(), filters.interval);
  while (cursor < filters.endExclusive.getTime()) {
    const value = values.get(cursor);
    trend.push({
      date: new Date(cursor + OFFSET).toISOString().slice(0, 10),
      revenue: value?.revenue ?? 0,
      salesCount: value?.salesCount ?? 0,
    });
    if (filters.interval === "month") {
      const next = new Date(cursor + OFFSET);
      next.setUTCMonth(next.getUTCMonth() + 1);
      cursor = next.getTime() - OFFSET;
    } else cursor += filters.interval === "week" ? 7 * DAY : DAY;
  }
  return trend;
}

export class AdminAnalyticsService {
  static async report(filters: AnalyticsFilters) {
    const [[result], [collection]] = await Promise.all([
      Order.aggregate<AnalyticsAggregate>(
        buildAnalyticsPipeline(filters),
      ).option({ maxTimeMS: 15_000 }),
      Order.aggregate<CollectionAggregate>(
        buildCollectionPipeline(filters),
      ).option({ maxTimeMS: 15_000 }),
    ]);
    const summary = result?.summary[0] ?? {
      totalOrders: 0,
      totalRevenue: 0,
      salesCount: 0,
      unitsSold: 0,
    };
    const totalRevenue =
      Math.round((summary.totalRevenue + Number.EPSILON) * 100) / 100;
    const counts = new Map(result?.statuses.map((row) => [row._id, row.count]));
    const knownStatuses: readonly string[] = ORDER_STATUSES;
    const unknown = (result?.statuses ?? [])
      .filter((row) => !knownStatuses.includes(row._id ?? ""))
      .reduce((sum, row) => sum + row.count, 0);
    return {
      filters: {
        range: filters.range,
        interval: filters.interval,
        startDate: filters.startDate,
        endDate: filters.endDate,
        start: filters.start.toISOString(),
        endExclusive: filters.endExclusive.toISOString(),
        timezone: ANALYTICS_TIMEZONE,
      },
      currency: "PHP",
      revenueBasis:
        "Explicitly paid, non-cancelled orders, grouped by order creation date. Includes shipping; product revenue excludes shipping.",
      collections: {
        basis:
          "Recorded COD collections by paidAt, including shipping, excluding cancelled and unpaid orders. Legacy paid orders without paidAt are excluded.",
        totalRevenue:
          Math.round((collection?.summary[0]?.totalRevenue ?? 0) * 100) / 100,
        collectionCount: collection?.summary[0]?.collectionCount ?? 0,
        trend: fillAnalyticsTrend(filters, collection?.trend ?? []).map(
          (row) => ({
            date: row.date,
            revenue: Math.round(row.revenue * 100) / 100,
            collectionCount: row.salesCount,
          }),
        ),
      },
      summary: {
        ...summary,
        totalRevenue,
        averageOrderValue: summary.salesCount
          ? Math.round((totalRevenue / summary.salesCount) * 100) / 100
          : 0,
        paidOrderShare: summary.totalOrders
          ? Math.round((summary.salesCount / summary.totalOrders) * 10000) / 100
          : 0,
      },
      ordersByStatus: [
        ...ORDER_STATUSES.map((status) => ({
          status,
          count: counts.get(status) ?? 0,
        })),
        ...(unknown ? [{ status: "unknown", count: unknown }] : []),
      ],
      trend: fillAnalyticsTrend(filters, result?.trend ?? []).map((row) => ({
        ...row,
        revenue: Math.round(row.revenue * 100) / 100,
      })),
      topProducts: (result?.topProducts ?? []).map((row) => ({
        productId: row._id,
        name: row.name,
        sku: row.sku,
        quantitySold: row.quantitySold,
        revenue: Math.round(row.revenue * 100) / 100,
      })),
      recentSales: result?.recentSales ?? [],
    };
  }
}
