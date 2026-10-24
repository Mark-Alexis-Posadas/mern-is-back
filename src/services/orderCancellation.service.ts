import mongoose, { type ClientSession, type HydratedDocument } from "mongoose";
import type { IOrder } from "../models/order.model";
import { Product } from "../models/product.model";
import { recordInventoryMovement } from "./inventoryMovement.service";

// Caller checks eligibility and saves the order in this same transaction.
export async function restoreCancelledOrderStock(
  order: HydratedDocument<IOrder>,
  session: ClientSession,
  actor: { type: "admin" | "customer" | "system"; id?: string },
) {
  const restorations = new Map<
    string,
    { product: mongoose.Types.ObjectId; quantity: number }
  >();
  for (const item of order.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new Error("INVENTORY_RESTORE_FAILED");
    }
    const key = String(item.product);
    const quantity = (restorations.get(key)?.quantity ?? 0) + item.quantity;
    if (!Number.isSafeInteger(quantity))
      throw new Error("INVENTORY_RESTORE_FAILED");
    restorations.set(key, { product: item.product, quantity });
  }
  // Legacy orders may contain repeated product lines. Restore their sum
  // once, retaining one auditable before/after pair per order/product.
  for (const item of restorations.values()) {
    const before = await Product.findOneAndUpdate(
      {
        _id: item.product,
        stock: {
          $gte: 0,
          $lte: Number.MAX_SAFE_INTEGER - item.quantity,
        },
      },
      { $inc: { stock: item.quantity } },
      { session, returnDocument: "before" },
    );

    if (!before) {
      throw new Error("INVENTORY_RESTORE_FAILED");
    }
    await recordInventoryMovement(session, {
      product: item.product,
      type: "cancellation",
      actorType: actor.type,
      ...(actor.id ? { actor: new mongoose.Types.ObjectId(actor.id) } : {}),
      order: order._id,
      adjustment: item.quantity,
      previousStock: before.stock,
      newStock: before.stock + item.quantity,
      reason: "Order cancellation stock restoration",
    });
  }
}
