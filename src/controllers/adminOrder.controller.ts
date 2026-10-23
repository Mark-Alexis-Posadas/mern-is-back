import type {
  Request,
  Response,
  NextFunction,
  ErrorRequestHandler,
} from "express";
import type { AuthRequest } from "../middleware/auth.middleware";
import {
  AdminOrderService,
  ORDER_STATUSES,
  type OrderStatus,
} from "../services/adminOrder.service";

// Mounted on the collection path at app level so parser failures raised before
// routing cannot fall back to Express's development stack/parser excerpts.
export const codCollectionErrors: ErrorRequestHandler = (
  failure: unknown,
  req,
  res,
  next,
) => {
  if (req.method !== "POST") {
    next(failure);
    return;
  }
  const type =
    typeof failure === "object" && failure !== null && "type" in failure
      ? failure.type
      : undefined;
  if (type === "entity.parse.failed") {
    res
      .status(400)
      .json({ message: "A valid JSON collection confirmation is required." });
  } else if (type === "entity.too.large") {
    res
      .status(413)
      .json({ message: "Collection confirmation request is too large." });
  } else {
    res.status(500).json({
      message:
        "Unable to confirm COD collection. Refresh the order before trying again.",
    });
  }
};

export async function collectAdminCodPayment(req: AuthRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }
  const id = req.params.id;
  if (typeof id !== "string" || !/^[a-fA-F0-9]{24}$/.test(id)) {
    res.status(400).json({ message: "Invalid order ID." });
    return;
  }
  const body: unknown = req.body;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("confirmed" in body) ||
    body.confirmed !== true ||
    Object.keys(body).length !== 1
  ) {
    res.status(400).json({
      message: "Explicit confirmation is required: send only confirmed: true.",
    });
    return;
  }
  try {
    const result = await AdminOrderService.collectCodPayment(id, req.user.id);
    if (result.result === "not_found") {
      res.status(404).json({ message: "Order not found" });
      return;
    }
    if (result.result === "conflict") {
      res.status(409).json({
        message:
          "Collection not recorded. Only delivered, unpaid COD orders without a previous collection may be confirmed. Refresh the order.",
      });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      message: "COD collection confirmed successfully",
      order: result.order,
    });
  } catch {
    res.status(500).json({
      message:
        "Unable to confirm COD collection. Refresh the order before trying again.",
    });
  }
}

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

    if (result.result === "payment_conflict") {
      res.status(409).json({
        message: "Paid orders cannot be cancelled without a refund workflow.",
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
