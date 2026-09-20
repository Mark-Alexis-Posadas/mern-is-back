import { Request, Response } from "express";
import { ProductService } from "../services/product.service";

export class ProductController {
  static async getProducts(req: Request, res: Response): Promise<void> {
    try {
      const products = await ProductService.getAllProducts();
      res.json(products);
    } catch (error) {
      res.status(500).json({
        message: "Server error",
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  static async getProductById(req: Request, res: Response): Promise<void> {
    try {
      const product = await ProductService.getProductById(req.params.id);
      if (!product) {
        res.status(404).json({ message: "Product not found" });
        return;
      }
      res.json(product);
    } catch (error) {
      res.status(500).json({
        message: "Server error",
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  static async createProduct(req: Request, res: Response): Promise<void> {
    try {
      const newProduct = await ProductService.createProduct(req.body);
      res.status(201).json(newProduct);
    } catch (error) {
      res.status(400).json({
        message: "Invalid product data",
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
