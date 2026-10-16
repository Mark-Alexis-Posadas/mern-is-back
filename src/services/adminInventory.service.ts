import mongoose from "mongoose";

import { Product } from "../models/product.model";
import { InventoryMovement } from "../models/inventoryMovement.model";

export class AdminInventoryService {
  static async adjustStock(
    productId: string,
    adminId: string,
    adjustment: number,
    reason: string,
  ) {
    if (
      !mongoose.isValidObjectId(productId) ||
      !mongoose.isValidObjectId(adminId)
    ) {
      return { result: "not_found" as const };
    }

    if (!Number.isSafeInteger(adjustment) || adjustment === 0) {
      return { result: "invalid_adjustment" as const };
    }

    const cleanReason = reason.trim();

    if (cleanReason.length < 3 || cleanReason.length > 500) {
      return { result: "invalid_reason" as const };
    }

    const session = await mongoose.startSession();

    try {
      let outcome:
        | { result: "success"; newStock: number }
        | { result: "not_found" }
        | { result: "insufficient_stock" }
        | { result: "invalid_adjustment" }
        | { result: "invalid_reason" } = {
        result: "not_found",
      };

      await session.withTransaction(async () => {
        const product = await Product.findById(productId).session(session);

        if (!product) {
          outcome = { result: "not_found" };
          return;
        }

        const previousStock = product.stock;
        const newStock = previousStock + adjustment;

        if (!Number.isSafeInteger(newStock) || newStock < 0) {
          outcome = { result: "insufficient_stock" };
          return;
        }

        const update = await Product.updateOne(
          {
            _id: productId,
            stock: previousStock,
          },
          {
            $inc: { stock: adjustment },
          },
          { session },
        );

        if (update.modifiedCount !== 1) {
          throw new Error("STOCK_UPDATE_CONFLICT");
        }

        await InventoryMovement.create(
          [
            {
              product: product._id,
              admin: new mongoose.Types.ObjectId(adminId),
              adjustment,
              previousStock,
              newStock,
              reason: cleanReason,
            },
          ],
          { session },
        );

        outcome = {
          result: "success",
          newStock,
        };
      });

      return outcome;
    } finally {
      await session.endSession();
    }
  }
}
