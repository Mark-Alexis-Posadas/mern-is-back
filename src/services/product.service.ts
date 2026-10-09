import { Types } from "mongoose";
import { Product } from "../models/product.model";

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

  static async createProduct(productData: Record<string, unknown>) {
    const product = new Product(productData);
    return product.save();
  }

  static async updateProduct(id: string, productData: Record<string, unknown>) {
    if (!Types.ObjectId.isValid(id)) {
      return null;
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
