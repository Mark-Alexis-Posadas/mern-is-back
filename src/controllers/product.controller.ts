import type { Request, Response } from "express";
import { ProductService } from "../services/product.service";

export class ProductController {
  static async getProducts(req: Request, res: Response): Promise<void> {
    try {
      const products = await ProductService.getAllProducts();

      res.status(200).json(products);
    } catch {
      res.status(500).json({
        message: "Failed to fetch products",
      });
    }
  }

  static async getProductById(req: Request, res: Response): Promise<void> {
    try {
      const product = await ProductService.getProductById(req.params.id);

      if (!product) {
        res.status(404).json({
          message: "Product not found",
        });
        return;
      }

      res.status(200).json(product);
    } catch {
      res.status(500).json({
        message: "Failed to fetch product",
      });
    }
  }

  static async createProduct(req: Request, res: Response): Promise<void> {
    try {
      const product = await ProductService.createProduct(req.body);

      res.status(201).json(product);
    } catch (error) {
      res.status(400).json({
        message: "Failed to create product",
        error: error instanceof Error ? error.message : "Invalid product data",
      });
    }
  }

  static async updateProduct(req: Request, res: Response): Promise<void> {
    try {
      const product = await ProductService.updateProduct(
        req.params.id,
        req.body,
      );

      if (!product) {
        res.status(404).json({
          message: "Product not found",
        });
        return;
      }

      res.status(200).json({
        message: "Product updated successfully",
        product,
      });
    } catch (error) {
      res.status(400).json({
        message: "Failed to update product",
        error: error instanceof Error ? error.message : "Invalid product data",
      });
    }
  }

  static async deleteProduct(req: Request, res: Response): Promise<void> {
    try {
      const product = await ProductService.deleteProduct(req.params.id);

      if (!product) {
        res.status(404).json({
          message: "Product not found",
        });
        return;
      }

      res.status(200).json({
        message: "Product deactivated successfully",
      });
    } catch {
      res.status(500).json({
        message: "Failed to delete product",
      });
    }
  }
}
