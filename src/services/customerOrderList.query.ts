import type { IOrder } from "../models/order.model";

export class CustomerOrderQueryError extends Error {}
export interface CustomerOrderQuery {
  page: number;
  limit: number;
  orderStatus?: IOrder["orderStatus"];
  paymentStatus?: IOrder["paymentStatus"];
  sort: "newest" | "oldest";
}
export function parseCustomerOrderQuery(
  input: Record<string, unknown>,
): CustomerOrderQuery {
  const allowed = ["page", "limit", "orderStatus", "paymentStatus", "sort"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new CustomerOrderQueryError("Unsupported order filter.");
  const text = (key: string) => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > 20)
      throw new CustomerOrderQueryError(`Invalid ${key}.`);
    return value;
  };
  const integer = (key: string, fallback: number, max: number) => {
    const value = text(key);
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
      throw new CustomerOrderQueryError(`Invalid ${key}.`);
    return Number(value);
  };
  const page = integer("page", 1, 10000),
    limit = integer("limit", 10, 50);
  if ((page - 1) * limit > 10000)
    throw new CustomerOrderQueryError(
      "Page exceeds the supported range. Narrow your filters.",
    );
  const orderStatus = text("orderStatus"),
    paymentStatus = text("paymentStatus"),
    sort = text("sort") ?? "newest";
  if (
    orderStatus !== undefined &&
    !["pending", "confirmed", "shipped", "delivered", "cancelled"].includes(
      orderStatus,
    )
  )
    throw new CustomerOrderQueryError("Invalid order status.");
  if (
    paymentStatus !== undefined &&
    !["unpaid", "paid"].includes(paymentStatus)
  )
    throw new CustomerOrderQueryError("Invalid payment status.");
  if (sort !== "newest" && sort !== "oldest")
    throw new CustomerOrderQueryError("Invalid sort.");
  return {
    page,
    limit,
    orderStatus: orderStatus as CustomerOrderQuery["orderStatus"],
    paymentStatus: paymentStatus as CustomerOrderQuery["paymentStatus"],
    sort,
  };
}
