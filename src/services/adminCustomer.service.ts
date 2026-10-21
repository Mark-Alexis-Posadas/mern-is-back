import { Types } from "mongoose";
import { User } from "../models/user.model";
import { Order } from "../models/order.model";

export class CustomerInputError extends Error {}

export function parseCustomerQuery(query: Record<string, unknown>) {
  function integer(value: unknown, fallback: number, maximum: number) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      throw new CustomerInputError("Invalid pagination parameters.");
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > maximum) {
      throw new CustomerInputError("Invalid pagination parameters.");
    }
    return number;
  }
  const page = integer(query.page, 1, 1_000_000);
  const limit = integer(query.limit, 10, 100);
  if (query.search !== undefined && (typeof query.search !== "string" || query.search.length > 100)) {
    throw new CustomerInputError("Search must be a string of 100 characters or fewer.");
  }
  return { page, limit, search: typeof query.search === "string" ? query.search.trim() : "" };
}

export function customerId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
    throw new CustomerInputError("Invalid customer ID.");
  }
  return new Types.ObjectId(value);
}

export function customerFilter(search: string) {
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    isAdmin: false,
    ...(escaped ? { $or: [{ name: { $regex: escaped, $options: "i" } }, { email: { $regex: escaped, $options: "i" } }] } : {}),
  };
}

const profileFields = { _id: 1, name: 1, email: 1, createdAt: 1 } as const;
const pagination = (page: number, limit: number, total: number) => ({ page, limit, total, totalPages: Math.ceil(total / limit) });

interface CustomerSummary {
  _id: Types.ObjectId;
  orderCount: number;
  totalSpending: number;
  cancelledOrderCount: number;
}

export class AdminCustomerService {
  static async summaries(ids: Types.ObjectId[]) {
    if (!ids.length) return [];
    return Order.aggregate<CustomerSummary>([
      { $match: { user: { $in: ids } } },
      { $group: {
        _id: "$user",
        orderCount: { $sum: 1 },
        totalSpending: { $sum: { $cond: [{ $ne: ["$orderStatus", "cancelled"] }, "$total", 0] } },
        cancelledOrderCount: { $sum: { $cond: [{ $eq: ["$orderStatus", "cancelled"] }, 1, 0] } },
      } },
    ]);
  }

  static async list({ page, limit, search }: ReturnType<typeof parseCustomerQuery>) {
    const filter = customerFilter(search);
    const [customers, total] = await Promise.all([
      User.find(filter, profileFields).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    // One aggregate for the entire page, rather than one query per customer.
    const summaries = new Map((await this.summaries(customers.map((customer) => customer._id))).map((summary) => [String(summary._id), summary]));
    return {
      customers: customers.map((customer) => ({
        ...customer,
        orderCount: summaries.get(String(customer._id))?.orderCount ?? 0,
        totalSpending: summaries.get(String(customer._id))?.totalSpending ?? 0,
      })),
      pagination: pagination(page, limit, total),
    };
  }

  static async details(id: Types.ObjectId, { page, limit }: ReturnType<typeof parseCustomerQuery>) {
    const customer = await User.findOne({ _id: id, isAdmin: false }, profileFields).lean();
    if (!customer) return null;
    const [summaries, orders] = await Promise.all([
      this.summaries([id]),
      Order.find({ user: id }, { _id: 1, orderStatus: 1, paymentStatus: 1, total: 1, createdAt: 1 })
        .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    const summary = summaries[0];
    return {
      customer,
      summary: { orderCount: summary?.orderCount ?? 0, totalSpending: summary?.totalSpending ?? 0, cancelledOrderCount: summary?.cancelledOrderCount ?? 0 },
      orders,
      pagination: pagination(page, limit, summary?.orderCount ?? 0),
    };
  }
}
