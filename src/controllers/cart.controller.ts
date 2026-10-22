import { Response } from "express";
import type { AuthRequest } from "../middleware/auth.middleware";

import {
  CartService,
  CartValidationError,
  CartConflictError,
} from "../services/cart.service";
export class CartController {
  static async getCart(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const cart = await CartService.getCartByUserId(req.user.id);
      res.json(cart);
    } catch {
      res.status(500).json({ message: "Failed to load cart." });
    }
  }

  static async updateCart(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const updatedCart = await CartService.saveOrUpdateCart(
        req.user.id,
        req.body,
      );
      res.json(updatedCart);
    } catch (error) {
      if (error instanceof CartConflictError) {
        res.status(409).json({ message: error.message });
        return;
      }
      if (error instanceof CartValidationError) {
        res.status(400).json({
          message: error.message,
        });
        return;
      }

      console.error("Cart update failed:", error);

      res.status(500).json({
        message: "Failed to update cart.",
      });
    }
  }
}
