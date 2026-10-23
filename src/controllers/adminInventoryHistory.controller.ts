import type { Request, Response } from "express";
import {
  AdminInventoryHistoryService,
  MOVEMENT_FILTERS,
  type MovementType,
} from "../services/adminInventoryHistory.service";

export class AdminInventoryHistoryController {
  static async getMovements(req: Request, res: Response) {
    try {
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      const limit =
        req.query.limit === undefined ? 10 : Number(req.query.limit);
      const productId = req.query.productId;
      const orderId = req.query.orderId;
      const search = req.query.search;
      const type = req.query.type ?? "all";

      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        return res
          .status(400)
          .json({ message: "Invalid pagination parameters." });
      }
      if (
        productId !== undefined &&
        (typeof productId !== "string" || !productId.trim())
      ) {
        return res.status(400).json({ message: "Invalid product ID." });
      }
      if (
        search !== undefined &&
        (typeof search !== "string" || search.length > 100)
      ) {
        return res.status(400).json({ message: "Invalid search query." });
      }
      if (typeof type !== "string" || !MOVEMENT_FILTERS.includes(type)) {
        return res.status(400).json({ message: "Invalid movement type." });
      }
      if (
        orderId !== undefined &&
        (typeof orderId !== "string" || !orderId.trim())
      )
        return res.status(400).json({ message: "Invalid order ID." });

      const result = await AdminInventoryHistoryService.getMovements({
        page,
        limit,
        productId: productId as string | undefined,
        orderId: orderId as string | undefined,
        search: search as string | undefined,
        type: type as MovementType,
      });
      return res.status(200).json(result);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "Invalid product ID.",
          "Invalid order ID.",
          "Invalid movement type.",
          "Invalid pagination parameters.",
          "Search must be 100 characters or fewer.",
        ].includes(error.message)
      ) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Failed to fetch inventory movements:", error);
      return res
        .status(500)
        .json({ message: "Unable to fetch inventory history." });
    }
  }
}
