import type { Request, Response, NextFunction } from "express";

import { AdminProductService } from "../services/adminProduct.service";
import type { AuthRequest } from "../middleware/auth.middleware";

export class AdminProductController {
  static async getAllProducts(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const products = await AdminProductService.getAllProducts();

      res.status(200).json(products);
    } catch (error) {
      next(error);
    }
  }

  static async getProductById(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const product = await AdminProductService.getProductById(
        String(req.params.id),
      );

      if (!product) {
        res.status(404).json({
          message: "Product not found",
        });
        return;
      }

      res.status(200).json(product);
    } catch (error) {
      next(error);
    }
  }

  static async createProduct(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }
      const product = await AdminProductService.createProduct(
        req.body,
        req.user.id,
      );

      res.status(201).json({
        message: "Product created successfully",
        product,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateProduct(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const product = await AdminProductService.updateProduct(
        String(req.params.id),
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
      next(error);
    }
  }

  static async updateProductStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { isActive } = req.body ?? {};

      if (typeof isActive !== "boolean") {
        res.status(400).json({
          message: "isActive must be a boolean",
        });
        return;
      }

      const product = await AdminProductService.updateProductStatus(
        String(req.params.id),
        isActive,
      );

      if (!product) {
        res.status(404).json({
          message: "Product not found",
        });
        return;
      }

      res.status(200).json({
        message: isActive
          ? "Product activated successfully"
          : "Product deactivated successfully",
        product,
      });
    } catch (error) {
      next(error);
    }
  }
}
