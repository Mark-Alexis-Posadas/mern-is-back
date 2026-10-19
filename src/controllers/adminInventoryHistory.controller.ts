import type { Request, Response } from "express";
import { AdminInventoryHistoryService } from "../services/adminInventoryHistory.service";

export class AdminInventoryHistoryController {
  static async getMovements(req: Request, res: Response) {
    try {
      const rawPage = req.query.page;
      const rawLimit = req.query.limit;
      const rawProductId = req.query.productId;

      const page = rawPage === undefined ? 1 : Number(rawPage);
      const limit = rawLimit === undefined ? 10 : Number(rawLimit);

      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        return res.status(400).json({
          message: "Invalid pagination parameters.",
        });
      }

      if (
        rawProductId !== undefined &&
        (typeof rawProductId !== "string" || !rawProductId.trim())
      ) {
        return res.status(400).json({
          message: "Invalid product ID.",
        });
      }

      const result = await AdminInventoryHistoryService.getMovements({
        page,
        limit,
        productId: rawProductId as string | undefined,
      });

      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid product ID.") {
        return res.status(400).json({
          message: error.message,
        });
      }

      console.error("Failed to fetch inventory movements:", error);

      return res.status(500).json({
        message: "Unable to fetch inventory history.",
      });
    }
  }
}
