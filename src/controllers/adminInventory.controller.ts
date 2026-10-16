import type { Response, NextFunction } from "express";

import { AuthRequest } from "../middleware/auth.middleware";
import { AdminInventoryService } from "../services/adminInventory.service";

export class AdminInventoryController {
  static async adjustStock(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const productId = String(req.params.id);
      const adminId = req.user?.id;

      const { adjustment, reason } = req.body ?? {};

      if (!adminId) {
        res.status(401).json({
          message: "Authentication required",
        });
        return;
      }

      if (
        typeof adjustment !== "number" ||
        !Number.isSafeInteger(adjustment) ||
        adjustment === 0
      ) {
        res.status(400).json({
          message: "Adjustment must be a non-zero integer",
        });
        return;
      }

      if (typeof reason !== "string") {
        res.status(400).json({
          message: "Reason is required",
        });
        return;
      }

      const result = await AdminInventoryService.adjustStock(
        productId,
        adminId,
        adjustment,
        reason,
      );

      switch (result.result) {
        case "not_found":
          res.status(404).json({
            message: "Product not found",
          });
          return;

        case "insufficient_stock":
          res.status(409).json({
            message: "Insufficient stock for this adjustment",
          });
          return;

        case "invalid_adjustment":
          res.status(400).json({
            message: "Invalid stock adjustment",
          });
          return;

        case "invalid_reason":
          res.status(400).json({
            message: "Reason must contain 3 to 500 characters",
          });
          return;

        case "success":
          res.status(200).json({
            message: "Stock adjusted successfully",
            newStock: result.newStock,
          });
          return;
      }
    } catch (error) {
      next(error);
    }
  }
}
