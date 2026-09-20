import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { CartService } from "../services/cart.service";

export class CartController {
  static async getCart(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const cart = await CartService.getCartByUserId(req.user.id);
      res.json(cart || { user: req.user.id, items: [] });
    } catch (error) {
      res
        .status(500)
        .json({
          message: "Server error",
          error: error instanceof Error ? error.message : error,
        });
    }
  }

  static async updateCart(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const { items } = req.body; // Expects an array of { product: productId, quantity }
      const updatedCart = await CartService.saveOrUpdateCart(
        req.user.id,
        items,
      );
      res.json(updatedCart);
    } catch (error) {
      res
        .status(400)
        .json({
          message: "Failed to update cart",
          error: error instanceof Error ? error.message : error,
        });
    }
  }
}
