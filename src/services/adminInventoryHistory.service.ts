import mongoose from "mongoose";
import { InventoryMovement } from "../models/inventoryMovement.model";

type GetMovementsParams = {
  page?: number;
  limit?: number;
  productId?: string;
};

export class AdminInventoryHistoryService {
  static async getMovements({
    page = 1,
    limit = 10,
    productId,
  }: GetMovementsParams) {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));

    if (productId && !mongoose.isValidObjectId(productId)) {
      throw new Error("Invalid product ID.");
    }

    const filter = productId ? { product: productId } : {};

    const [movements, total] = await Promise.all([
      InventoryMovement.find(filter)
        .populate("product", "name sku images")
        .populate("admin", "name email")
        .sort({ createdAt: -1, _id: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),

      InventoryMovement.countDocuments(filter),
    ]);

    return {
      movements,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }
}
