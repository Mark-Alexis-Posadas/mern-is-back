import mongoose from "mongoose";

import { Product } from "../models/product.model";
import { recordInventoryMovement } from "./inventoryMovement.service";

type StockAdjustmentResult =
  | { result: "success"; newStock: number }
  | { result: "not_found" }
  | { result: "insufficient_stock" }
  | { result: "invalid_adjustment" }
  | { result: "invalid_reason" };

export class AdminInventoryService {
  static async adjustStock(
    productId: string,
    adminId: string,
    adjustment: number,
    reason: string,
  ): Promise<StockAdjustmentResult> {
    if (
      !mongoose.isValidObjectId(productId) ||
      !mongoose.isValidObjectId(adminId)
    ) {
      return { result: "not_found" };
    }

    if (!Number.isSafeInteger(adjustment) || adjustment === 0) {
      return { result: "invalid_adjustment" };
    }

    if (typeof reason !== "string") {
      return { result: "invalid_reason" };
    }

    const cleanReason = reason.trim();

    if (cleanReason.length < 3 || cleanReason.length > 500) {
      return { result: "invalid_reason" };
    }

    const session = await mongoose.startSession();

    try {
      const outcome = await session.withTransaction(
        async (): Promise<StockAdjustmentResult> => {
          const product = await Product.findById(productId).session(session);

          if (!product) {
            return { result: "not_found" };
          }

          const previousStock = product.stock;
          const newStock = previousStock + adjustment;

          if (!Number.isSafeInteger(newStock) || newStock < 0) {
            return { result: "insufficient_stock" };
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

          await recordInventoryMovement(session, {
            product: product._id,
            actor: new mongoose.Types.ObjectId(adminId),
            actorType: "admin",
            type: "manual",
            adjustment,
            previousStock,
            newStock,
            reason: cleanReason,
          });

          return {
            result: "success",
            newStock,
          };
        },
      );

      if (!outcome) {
        throw new Error("Stock adjustment transaction returned no result");
      }

      return outcome;
    } finally {
      await session.endSession();
    }
  }
}
