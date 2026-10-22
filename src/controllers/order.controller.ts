import type { Response } from "express";
import type { AuthRequest } from "../types/auth.types";
import { OrderService, OrderValidationError } from "../services/order.service";
import {
  CartConflictError,
  CartValidationError,
} from "../services/cart.service";

export class OrderController {
  static async createOrder(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const order = await OrderService.createOrder(req.user.id, req.body);

      res.status(201).json(order);
    } catch (error) {
      if (error instanceof CartConflictError) {
        res.status(409).json({ message: error.message });
        return;
      }
      if (
        error instanceof OrderValidationError ||
        error instanceof CartValidationError
      ) {
        res.status(400).json({
          message: error.message,
        });
        return;
      }

      console.error("Create order failed:", error);

      res.status(500).json({
        message: "Failed to place order.",
        ...(process.env.NODE_ENV !== "production" && {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  static async getMyOrders(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      console.log("Authenticated user ID:", req.user?.id);
      const orders = await OrderService.getMyOrders(req.user.id);

      res.json(orders);
    } catch (error) {
      console.error("Get orders failed:", error);

      res.status(500).json({
        message: "Failed to load orders.",
      });
    }
  }

  static async getOrderById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const order = await OrderService.getOrderById(
        req.user.id,
        String(req.params.id),
      );

      if (!order) {
        res.status(404).json({
          message: "Order not found.",
        });
        return;
      }

      res.json(order);
    } catch (error) {
      console.error("Get order failed:", error);

      res.status(500).json({
        message: "Failed to load order.",
      });
    }
  }
}
