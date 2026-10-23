import mongoose, { Types } from "mongoose";
import { Product } from "../models/product.model";
import {
  createProductWithInventory,
  recordInventoryMovement,
} from "./inventoryMovement.service";

export class ProductService {
  static async getAllProducts() {
    return Product.find({
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .lean();
  }

  static async getProductById(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }

    return Product.findOne({
      _id: id,
      isActive: true,
    }).lean();
  }

  static async createProduct(
    productData: Record<string, unknown>,
    adminId: string,
  ) {
    return createProductWithInventory(productData, adminId);
  }

  static async updateProduct(
    id: string,
    productData: Record<string, unknown>,
    adminId: string,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }

    // Preserve the legacy absolute-stock contract, but make it auditable and
    // transactional instead of bypassing the dedicated adjustment workflow.
    if (Object.prototype.hasOwnProperty.call(productData, "stock")) {
      const stock = productData.stock;
      if (
        typeof stock !== "number" ||
        !Number.isSafeInteger(stock) ||
        stock < 0
      )
        throw new Error("Stock must be a non-negative safe integer.");
      const session = await mongoose.startSession();
      try {
        return await session.withTransaction(async () => {
          const before = await Product.findById(id).session(session);
          if (!before) return null;
          const updated = await Product.findOneAndUpdate(
            { _id: id, stock: before.stock },
            { $set: productData },
            { session, returnDocument: "after", runValidators: true },
          );
          if (!updated)
            throw new Error("Stock changed. Refresh the product and retry.");
          const adjustment = stock - before.stock;
          if (adjustment !== 0)
            await recordInventoryMovement(session, {
              product: before._id,
              type: "manual",
              actorType: "admin",
              actor: new Types.ObjectId(adminId),
              adjustment,
              previousStock: before.stock,
              newStock: stock,
              reason: "Legacy product stock edit",
            });
          return updated;
        });
      } finally {
        await session.endSession();
      }
    }

    return Product.findByIdAndUpdate(
      id,
      { $set: productData },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  static async deleteProduct(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }

    // Soft delete: hide product from storefront
    return Product.findByIdAndUpdate(
      id,
      { $set: { isActive: false } },
      { new: true },
    );
  }
}
