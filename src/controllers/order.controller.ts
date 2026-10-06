import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { OrderService } from "../services/order.service";

export class OrderController {
  static async createOrder(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const newOrder = await OrderService.createOrder(req.user.id, req.body);
      res.status(201).json(newOrder);
    } catch (error) {
      res
        .status(400)
        .json({
          message:
            error instanceof Error ? error.message : "Failed to create order",
        });
    }
  }

  static async getOrderById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const order = await OrderService.getOrderById(req.params.id);
      if (!order) {
        res.status(404).json({ message: "Order not found" });
        return;
      }
      res.json(order);
    } catch (error) {
      res
        .status(500)
        .json({
          message: "Server error",
          error: error instanceof Error ? error.message : error,
        });
    }
  }

  static async getMyOrders(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const orders = await OrderService.getOrdersByUserId(req.user.id);
      res.json(orders);
    } catch (error) {
      res
        .status(500)
        .json({
          message: "Server error",
          error: error instanceof Error ? error.message : error,
        });
    }
  }
}
