import { Order, IOrder } from "../models/order.model";

export class OrderService {
  static async createOrder(
    userId: string,
    orderData: Partial<IOrder>,
  ): Promise<IOrder> {
    const {
      orderItems,
      shippingAddress,
      paymentMethod,
      itemsPrice,
      taxPrice,
      shippingPrice,
      totalPrice,
    } = orderData;

    if (!orderItems || orderItems.length === 0) {
      throw new Error("No order items provided");
    }

    const order = new Order({
      user: userId,
      orderItems,
      shippingAddress,
      paymentMethod,
      itemsPrice,
      taxPrice,
      shippingPrice,
      totalPrice,
    });

    return await order.save();
  }

  static async getOrderById(orderId: string): Promise<IOrder | null> {
    return await Order.findById(orderId).populate("user", "name email");
  }

  static async getOrdersByUserId(userId: string): Promise<IOrder[]> {
    return await Order.find({ user: userId }).sort({ createdAt: -1 });
  }

  static async updateOrderToPaid(orderId: string): Promise<IOrder | null> {
    const order = await Order.findById(orderId);
    if (!order) return null;

    order.isPaid = true;
    order.paidAt = new Date();
    return await order.save();
  }
}
