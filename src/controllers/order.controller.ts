import {
  checkoutKey,
  committedCheckout,
  CheckoutKeyValidationError,
  CheckoutKeyConflictError,
  CheckoutRetryableError,
} from "../services/checkoutAttempt.service";
import {
  parseCustomerOrderQuery,
  CustomerOrderQueryError,
} from "../services/customerOrderList.query";
import type { Response } from "express";
import type { AuthRequest } from "../types/auth.types";
import { OrderService, OrderValidationError } from "../services/order.service";
import {
  CartConflictError,
  CartValidationError,
} from "../services/cart.service";

export class OrderController {
  static async getCheckoutAttempt(
    req: AuthRequest,
    res: Response,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    try {
      const order = await committedCheckout(
        req.user.id,
        checkoutKey(req.params.key),
      );
      if (!order) {
        res.status(404).json({
          code: "CHECKOUT_NOT_FOUND",
          message: "No committed order found yet. Retry checking this attempt.",
        });
        return;
      }
      res.json(order);
    } catch (error) {
      if (error instanceof CheckoutKeyValidationError) {
        res.status(400).json({ message: error.message });
        return;
      }
      res.status(503).setHeader("Retry-After", "1");
      res.json({
        code: "CHECKOUT_RETRYABLE",
        message: "Unable to confirm checkout status. Check this attempt again.",
      });
    }
  }

  static async cancelOwnOrder(req: AuthRequest, res: Response): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("confirmed" in body) ||
      body.confirmed !== true
    ) {
      res
        .status(400)
        .json({ message: "Explicit cancellation confirmation is required." });
      return;
    }
    try {
      const result = await OrderService.cancelOwnOrder(
        req.user.id,
        String(req.params.id),
      );
      if (result?.result === "not_found") {
        res.status(404).json({ message: "Order not found." });
        return;
      }
      if (result?.result !== "success") {
        res.status(409).json({
          message:
            "This order can no longer be cancelled. Refresh its current status.",
        });
        return;
      }
      res.json(result.order);
    } catch {
      res.status(500).json({
        message:
          "Unable to cancel order. Refresh its status before trying again.",
      });
    }
  }

  static async createOrder(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      const order = await OrderService.createOrder(req.user.id, req.body);

      res.status(201).json(order);
    } catch (error) {
      if (error instanceof CheckoutKeyConflictError) {
        res
          .status(409)
          .json({ code: "CHECKOUT_KEY_CONFLICT", message: error.message });
        return;
      }
      if (error instanceof CheckoutRetryableError) {
        res.status(503).setHeader("Retry-After", "1");
        res.json({ code: "CHECKOUT_RETRYABLE", message: error.message });
        return;
      }
      if (error instanceof CartConflictError) {
        res.status(409).json({ code: "CART_CONFLICT", message: error.message });
        return;
      }
      if (
        error instanceof CheckoutKeyValidationError ||
        error instanceof OrderValidationError ||
        error instanceof CartValidationError
      ) {
        res.status(400).json({
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        message: "Failed to place order.",
      });
    }
  }

  static async getMyOrders(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      const orders = await OrderService.getMyOrders(
        req.user.id,
        parseCustomerOrderQuery(req.query),
      );

      res.json(orders);
    } catch (error) {
      if (error instanceof CustomerOrderQueryError) {
        res.status(400).json({ message: error.message });
        return;
      }

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
