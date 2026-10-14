import type { Request, Response, NextFunction } from "express";

import {
  AdminOrderService,
  ORDER_STATUSES,
  type OrderStatus,
} from "../services/adminOrder.service";

export const getAllAdminOrders = async (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const orders = await AdminOrderService.getAllOrders();
    res.status(200).json(orders);
  } catch (error) {
    next(error);
  }
};

export const getAdminOrderById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);

    const order = await AdminOrderService.getOrderById(id);

    if (!order) {
      res.status(404).json({
        message: "Order not found",
      });
      return;
    }

    res.status(200).json(order);
  } catch (error) {
    next(error);
  }
};

export const updateAdminOrderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const status: unknown = req.body?.status;

    if (
      typeof status !== "string" ||
      !ORDER_STATUSES.some((value) => value === status)
    ) {
      res.status(400).json({
        message: "Invalid order status",
        allowedStatuses: ORDER_STATUSES,
      });
      return;
    }

    const result = await AdminOrderService.updateOrderStatus(
      id,
      status as OrderStatus,
    );

    if (result.result === "not_found") {
      res.status(404).json({
        message: "Order not found",
      });
      return;
    }

    if (result.result === "invalid_transition") {
      res.status(409).json({
        message: `Cannot change order status from ${result.currentStatus} to ${status}`,
      });
      return;
    }

    if (result.result === "inventory_error") {
      res.status(409).json({
        message: "Unable to restore product inventory",
      });
      return;
    }

    if (result.result === "conflict") {
      res.status(409).json({
        message: "Order update conflict. Please retry.",
      });
      return;
    }

    res.status(200).json({
      message: "Order status updated successfully",
      order: result.order,
    });
  } catch (error) {
    next(error);
  }
};
