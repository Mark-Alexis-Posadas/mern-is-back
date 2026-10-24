import { createHash } from "node:crypto";
import { CheckoutAttempt } from "../models/checkoutAttempt.model";
import { Order, type IShippingAddress } from "../models/order.model";
export class CheckoutKeyValidationError extends Error {}
export class CheckoutKeyConflictError extends Error {
  constructor() {
    super(
      "This checkout key was already used with different checkout details. Check the original order.",
    );
  }
}
export class CheckoutRetryableError extends Error {
  constructor() {
    super(
      "Checkout status is not yet confirmed. Retry or check the same checkout attempt.",
    );
  }
}
export function checkoutKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value))
    throw new CheckoutKeyValidationError(
      "A valid checkout idempotency key is required.",
    );
  return value;
}
export function checkoutFingerprint(
  cartId: string,
  version: number,
  address: IShippingAddress,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        cartId.toLowerCase(),
        version,
        "COD",
        address.fullName,
        address.phone,
        address.addressLine1,
        address.addressLine2 ?? "",
        address.city,
        address.province,
        address.postalCode,
      ]),
    )
    .digest("hex");
}
export async function committedCheckout(
  userId: string,
  key: string,
  fingerprint?: string,
) {
  const attempt = await CheckoutAttempt.findOne({ user: userId, key })
    .readConcern("majority")
    .maxTimeMS(3000)
    .lean();
  if (!attempt) return null;
  if (fingerprint !== undefined && attempt.fingerprint !== fingerprint)
    throw new CheckoutKeyConflictError();
  const order = await Order.findOne({ _id: attempt.order, user: userId })
    .select(
      "user items shippingAddress paymentMethod paymentStatus orderStatus subtotal shippingFee total createdAt updatedAt",
    )
    .maxTimeMS(3000);
  if (!order) throw new CheckoutRetryableError();
  return order;
}
