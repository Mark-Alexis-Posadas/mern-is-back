import { Types } from "mongoose";
import { Cart } from "../models/cart.model";
import { Product } from "../models/product.model";

interface CartItemInput {
  product: string;
  quantity: number;
}

export class CartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartValidationError";
  }
}

export class CartService {
  static async getCartByUserId(userId: string) {
    return Cart.findOne({ user: userId }).populate("items.product");
  }

  static async saveOrUpdateCart(userId: string, items: CartItemInput[]) {
    if (!Array.isArray(items)) {
      throw new CartValidationError("Cart items must be an array.");
    }

    if (items.length > 100) {
      throw new CartValidationError(
        "Cart cannot contain more than 100 products.",
      );
    }

    const productIds = new Set<string>();

    for (const item of items) {
      if (
        !item ||
        typeof item.product !== "string" ||
        !Types.ObjectId.isValid(item.product)
      ) {
        throw new CartValidationError("Invalid product ID.");
      }

      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new CartValidationError("Quantity must be a positive integer.");
      }

      const normalizedId = new Types.ObjectId(item.product).toHexString();

      if (productIds.has(normalizedId)) {
        throw new CartValidationError("Duplicate product in cart.");
      }

      productIds.add(normalizedId);
    }

    const products = await Product.find({
      _id: { $in: [...productIds] },
      isActive: true,
    }).select("_id name stock");

    const productMap = new Map(
      products.map((product) => [product._id.toString(), product]),
    );

    for (const item of items) {
      const productId = new Types.ObjectId(item.product).toHexString();

      const product = productMap.get(productId);

      if (!product) {
        throw new CartValidationError("Product not found or unavailable.");
      }

      if (item.quantity > product.stock) {
        throw new CartValidationError(
          `Only ${product.stock} unit(s) available for ${product.name}.`,
        );
      }
    }

    const cartItems = items.map((item) => ({
      product: new Types.ObjectId(item.product),
      quantity: item.quantity,
    }));

    const cart = await Cart.findOneAndUpdate(
      { user: userId },
      { $set: { items: cartItems } },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    await cart.populate("items.product");

    return cart;
  }

  static async clearCart(userId: string): Promise<void> {
    await Cart.findOneAndDelete({
      user: userId,
    });
  }
}
