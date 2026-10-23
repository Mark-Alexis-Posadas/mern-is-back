import type { Request, Response } from "express";
import { ProductService } from "../services/product.service";
import type { AuthRequest } from "../middleware/auth.middleware";

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
      const id = req.params.id;
      if (typeof id !== "string") {
        res.status(400).json({ message: "Invalid product ID." });
        return;
      }
      const product = await ProductService.getProductById(id);

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

  static async createProduct(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }
      const product = await ProductService.createProduct(req.body, req.user.id);

      res.status(201).json(product);
    } catch (error) {
      res.status(400).json({
        message: "Failed to create product",
        error: error instanceof Error ? error.message : "Invalid product data",
      });
    }
  }

  static async updateProduct(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }
      const id = req.params.id;
      if (typeof id !== "string") {
        res.status(400).json({ message: "Invalid product ID." });
        return;
      }
      const product = await ProductService.updateProduct(
        id,
        req.body,
        req.user.id,
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
      const id = req.params.id;
      if (typeof id !== "string") {
        res.status(400).json({ message: "Invalid product ID." });
        return;
      }
      const product = await ProductService.deleteProduct(id);

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
