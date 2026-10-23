import mongoose from "mongoose";

import { Order } from "../models/order.model";
import { Product } from "../models/product.model";

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

export class AdminOrderService {
  static async getAllOrders() {
    return Order.find()
      .select("+paidAt +paymentCollectedBy")
      .populate("user", "name email")
      .sort({ createdAt: -1 })
      .lean();
  }

  static async getOrderById(id: string) {
    if (!mongoose.isValidObjectId(id)) {
      return null;
    }

    return Order.findById(id)
      .select("+paidAt +paymentCollectedBy")
      .populate("user", "name email")
      .lean();
  }

  static async collectCodPayment(id: string, adminId: string) {
    const order = await Order.findOneAndUpdate(
      {
        _id: id,
        paymentMethod: "COD",
        orderStatus: "delivered",
        paymentStatus: "unpaid",
        paidAt: null,
        paymentCollectedBy: null,
      },
      {
        $set: {
          paymentStatus: "paid",
          paymentCollectedBy: new mongoose.Types.ObjectId(adminId),
        },
        $currentDate: { paidAt: true },
      },
      { returnDocument: "after", runValidators: true },
    )
      .select("+paidAt +paymentCollectedBy")
      .populate("user", "name email")
      .lean();
    if (order) return { result: "success" as const, order };
    return {
      result: (await Order.exists({ _id: id }))
        ? ("conflict" as const)
        : ("not_found" as const),
    };
  }

  static async updateOrderStatus(id: string, newStatus: OrderStatus) {
    if (!mongoose.isValidObjectId(id)) {
      return { result: "not_found" as const };
    }

    const session = await mongoose.startSession();

    try {
      let outcome:
        | { result: "success"; orderId: string }
        | { result: "not_found" }
        | { result: "invalid_transition"; currentStatus: string }
        | { result: "inventory_error" }
        | { result: "payment_conflict" }
        | undefined;

      await session.withTransaction(async () => {
        const order = await Order.findById(id).session(session);

        if (!order) {
          outcome = { result: "not_found" };
          return;
        }

        const currentStatus = order.orderStatus;

        // Legacy paid orders may precede delivery. No refunds exist, so never
        // cancel a paid order or restore its stock through fulfillment updates.
        if (newStatus === "cancelled" && order.paymentStatus === "paid") {
          outcome = { result: "payment_conflict" };
          return;
        }

        if (!ALLOWED_TRANSITIONS[currentStatus].includes(newStatus)) {
          outcome = {
            result: "invalid_transition",
            currentStatus,
          };
          return;
        }

        if (newStatus === "cancelled") {
          for (const item of order.items) {
            // Assumes Product schema uses a numeric "stock" field.
            const result = await Product.updateOne(
              { _id: item.product },
              { $inc: { stock: item.quantity } },
              { session },
            );

            if (result.matchedCount !== 1) {
              outcome = { result: "inventory_error" };
              throw new Error("INVENTORY_RESTORE_FAILED");
            }
          }
        }

        order.orderStatus = newStatus;
        await order.save({ session });

        outcome = {
          result: "success",
          orderId: String(order._id),
        };
      });

      if (outcome?.result === "success") {
        const updatedOrder = await Order.findById(id)
          .select("+paidAt +paymentCollectedBy")
          .populate("user", "name email")
          .lean();

        return {
          result: "success" as const,
          order: updatedOrder,
        };
      }

      return outcome ?? { result: "conflict" as const };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "INVENTORY_RESTORE_FAILED"
      ) {
        return { result: "inventory_error" as const };
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }
}
