import { Product, IProduct } from "../models/product.model";

export class ProductService {
  static async getAllProducts(): Promise<IProduct[]> {
    return await Product.find({});
  }

  static async getProductById(id: string): Promise<IProduct | null> {
    return await Product.findById(id);
  }

  static async createProduct(
    productData: Partial<IProduct>,
  ): Promise<IProduct> {
    const product = new Product(productData);
    return await product.save();
  }
}
