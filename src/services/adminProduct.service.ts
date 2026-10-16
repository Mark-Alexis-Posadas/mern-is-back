import mongoose from "mongoose";
import { Product, type IProduct } from "../models/product.model";
const EDITABLE_FIELDS = [
  "name",
  "slug",
  "sku",
  "description",
  "shortDescription",
  "price",
  "compareAtPrice",
  "category",
  "brand",
  "lowStockThreshold",
  "images",
  "tags",
  "weight",
  "isFeatured",
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

export class AdminProductService {
  static async getAllProducts() {
    return Product.find().sort({ createdAt: -1 }).lean();
  }

  static async getProductById(id: string) {
    if (!mongoose.isValidObjectId(id)) {
      return null;
    }

    return Product.findById(id).lean();
  }

  static async createProduct(data: Record<string, unknown>) {
    const productData = this.pickEditableFields(data);

    const stock = data.stock ?? 0;

    if (
      typeof stock !== "number" ||
      !Number.isSafeInteger(stock) ||
      stock < 0
    ) {
      throw new Error("Initial stock must be a non-negative integer");
    }

    const product = new Product({
      ...productData,
      stock,
    });

    return product.save();
  }

  static async updateProduct(id: string, data: Record<string, unknown>) {
    if (!mongoose.isValidObjectId(id)) {
      return null;
    }

    // Prevent stock from being overwritten by general edits.
    if (Object.prototype.hasOwnProperty.call(data, "stock")) {
      throw new Error("Use the dedicated stock adjustment endpoint");
    }

    const updateData = this.pickEditableFields(data);

    if (Object.keys(updateData).length === 0) {
      throw new Error("No valid product fields provided");
    }

    return Product.findByIdAndUpdate(
      id,
      { $set: updateData },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  static async updateProductStatus(id: string, isActive: boolean) {
    if (!mongoose.isValidObjectId(id)) {
      return null;
    }

    return Product.findByIdAndUpdate(
      id,
      { $set: { isActive } },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  private static pickEditableFields(
    data: Record<string, unknown>,
  ): Partial<Record<EditableField, unknown>> {
    const result: Partial<Record<EditableField, unknown>> = {};

    for (const field of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        result[field] = data[field];
      }
    }

    return result;
  }
}
