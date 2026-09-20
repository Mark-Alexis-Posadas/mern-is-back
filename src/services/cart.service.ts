import { Cart, ICart } from "../models/cart.model";

export class CartService {
  static async getCartByUserId(userId: string): Promise<ICart | null> {
    return await Cart.findOne({ user: userId }).populate("items.product");
  }

  static async saveOrUpdateCart(
    userId: string,
    items: Array<{ product: string; quantity: number }>,
  ): Promise<ICart> {
    let cart = await Cart.findOne({ user: userId });

    if (!cart) {
      cart = new Cart({ user: userId, items });
    } else {
      cart.items = items as any;
    }

    await cart.save();
    return await cart.populate("items.product");
  }

  static async clearCart(userId: string): Promise<void> {
    await Cart.findOneAndDelete({ user: userId });
  }
}
