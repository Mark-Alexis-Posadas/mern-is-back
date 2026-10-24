import {
  parseProductQuery,
  escapeProductSearch,
  type ProductListQuery,
} from "./productList.query";
import mongoose, { Types } from "mongoose";
import { Product } from "../models/product.model";
import {
  createProductWithInventory,
  recordInventoryMovement,
} from "./inventoryMovement.service";

export class ProductService {
  static async getAllProducts(query: ProductListQuery = parseProductQuery({})) {
    const filter: Record<string, unknown> = { isActive: true };
    if (query.category) filter.category = query.category;
    if (query.search) {
      const literal = {
        $regex: escapeProductSearch(query.search),
        $options: "i",
      };
      filter.$or = [{ name: literal }, { sku: literal }, { brand: literal }];
    }
    if (query.minPrice !== undefined || query.maxPrice !== undefined)
      filter.price = {
        ...(query.minPrice !== undefined ? { $gte: query.minPrice } : {}),
        ...(query.maxPrice !== undefined ? { $lte: query.maxPrice } : {}),
      };
    const sorts: Record<ProductListQuery["sort"], Record<string, 1 | -1>> = {
      newest: { createdAt: -1, _id: -1 },
      priceAsc: { price: 1, _id: 1 },
      priceDesc: { price: -1, _id: -1 },
      nameAsc: { name: 1, _id: 1 },
      nameDesc: { name: -1, _id: -1 },
    };
    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort(sorts[query.sort])
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .maxTimeMS(3000)
        .lean(),
      Product.countDocuments(filter).maxTimeMS(3000),
    ]);
    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
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
