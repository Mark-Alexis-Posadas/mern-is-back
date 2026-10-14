import mongoose, { Types } from "mongoose";

import { Order } from "../models/order.model";
import type {
  IOrder,
  IOrderItem,
  IShippingAddress,
} from "../models/order.model";

import { Cart } from "../models/cart.model";
import { Product } from "../models/product.model";

export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderValidationError";
  }
}

interface CreateOrderInput {
  shippingAddress: IShippingAddress;
  paymentMethod: "COD";
}

export class OrderService {
  static async createOrder(
    userId: string,
    orderData: CreateOrderInput,
  ): Promise<IOrder> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new OrderValidationError("Invalid user.");
    }

    const address = orderData?.shippingAddress;

    if (!address || typeof address !== "object") {
      throw new OrderValidationError("Shipping address is required.");
    }

    const requiredFields: Array<keyof IShippingAddress> = [
      "fullName",
      "phone",
      "addressLine1",
      "city",
      "province",
      "postalCode",
    ];

    for (const field of requiredFields) {
      const value = address[field];

      if (typeof value !== "string" || !value.trim() || value.length > 200) {
        throw new OrderValidationError(
          `Invalid shipping address field: ${field}.`,
        );
      }
    }

    if (
      address.addressLine2 !== undefined &&
      (typeof address.addressLine2 !== "string" ||
        address.addressLine2.length > 200)
    ) {
      throw new OrderValidationError("Invalid address line 2.");
    }

    if (orderData.paymentMethod !== "COD") {
      throw new OrderValidationError("Only Cash on Delivery is supported.");
    }

    const shippingAddress: IShippingAddress = {
      fullName: address.fullName.trim(),
      phone: address.phone.trim(),
      addressLine1: address.addressLine1.trim(),
      addressLine2: address.addressLine2?.trim(),
      city: address.city.trim(),
      province: address.province.trim(),
      postalCode: address.postalCode.trim(),
    };

    const session = await mongoose.startSession();

    try {
      const order = await session.withTransaction(async () => {
        const cart = await Cart.findOne({
          user: userId,
        }).session(session);

        if (!cart || cart.items.length === 0) {
          throw new OrderValidationError("Your cart is empty.");
        }

        const orderItems: IOrderItem[] = [];
        const seenProducts = new Set<string>();

        let subtotal = 0;

        for (const cartItem of cart.items) {
          const productId = cartItem.product.toString();

          const quantity = cartItem.quantity;

          if (
            seenProducts.has(productId) ||
            !Number.isInteger(quantity) ||
            quantity < 1
          ) {
            throw new OrderValidationError("Your cart contains invalid items.");
          }

          seenProducts.add(productId);

          const product = await Product.findById(productId).session(session);

          if (!product || !product.isActive) {
            throw new OrderValidationError(
              "A product in your cart is unavailable.",
            );
          }

          if (!Number.isFinite(product.price) || product.price < 0) {
            throw new OrderValidationError(
              `Invalid price for ${product.name}.`,
            );
          }

          // Atomic stock check and deduction.
          const stockUpdate = await Product.updateOne(
            {
              _id: product._id,
              isActive: true,
              stock: { $gte: quantity },
            },
            {
              $inc: { stock: -quantity },
            },
            { session },
          );

          if (stockUpdate.modifiedCount !== 1) {
            throw new OrderValidationError(
              `Insufficient stock for ${product.name}.`,
            );
          }

          const imageUrl =
            product.images?.find((image) => image.isPrimary)?.url ??
            product.images?.[0]?.url;

          orderItems.push({
            product: product._id,
            name: product.name,
            sku: product.sku,
            price: product.price,
            quantity,
            imageUrl,
          });

          subtotal += product.price * quantity;
        }

        // Temporary MVP policy:
        // No shipping fee until a delivery
        // fee calculation feature is implemented.
        const shippingFee = 0;
        const total = subtotal + shippingFee;

        const [createdOrder] = await Order.create(
          [
            {
              user: new Types.ObjectId(userId),
              items: orderItems,
              shippingAddress,
              paymentMethod: "COD",
              paymentStatus: "unpaid",
              orderStatus: "pending",
              subtotal,
              shippingFee,
              total,
            },
          ],
          { session },
        );

        // Delete only the cart version we read.
        // This helps detect a concurrent cart edit.
        const cartDeletion = await Cart.deleteOne(
          {
            _id: cart._id,
            __v: cart.__v,
          },
          { session },
        );

        if (cartDeletion.deletedCount !== 1) {
          throw new Error("Cart changed during checkout. Please retry.");
        }

        return createdOrder;
      });

      if (!order) {
        throw new Error("Order creation failed.");
      }

      return order;
    } finally {
      await session.endSession();
    }
  }

  static async getMyOrders(userId: string): Promise<IOrder[]> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new OrderValidationError("Invalid user.");
    }

    return Order.find({
      user: userId,
    }).sort({ createdAt: -1 });
  }

  static async getOrderById(
    userId: string,
    orderId: string,
  ): Promise<IOrder | null> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new OrderValidationError("Invalid user.");
    }

    if (!Types.ObjectId.isValid(orderId)) {
      return null;
    }

    // User can only access their own order.
    return Order.findOne({
      _id: orderId,
      user: userId,
    });
  }
}
