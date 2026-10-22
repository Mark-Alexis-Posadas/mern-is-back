import { Types } from "mongoose";
import { Cart, type CartDocument } from "../models/cart.model";
import { Product } from "../models/product.model";

interface CartItemInput {
  product: string;
  quantity: number;
}
export interface CartRevision {
  cartId: string | null;
  version: number;
}

export class CartValidationError extends Error {}
export class CartConflictError extends Error {
  constructor() {
    super("Your cart changed. Reload it, review your items, and try again.");
  }
}

export function cartRevision(input: unknown): CartRevision {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CartValidationError(
      "A cart ID and version are required. Reload your cart.",
    );
  const { cartId, version } = input as Record<string, unknown>;
  if (
    (cartId !== null &&
      (typeof cartId !== "string" || !/^[a-fA-F0-9]{24}$/.test(cartId))) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version >= Number.MAX_SAFE_INTEGER ||
    (cartId === null && version !== 0)
  )
    throw new CartValidationError(
      "A valid cart ID and version are required. Reload your cart.",
    );
  return { cartId, version };
}

// Tolerate legacy documents inserted without Mongoose's default __v=0.
export function revisionFilter(version: number) {
  return version === 0
    ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] }
    : { __v: version };
}

async function presentCart(userId: string, cart: CartDocument | null) {
  const products = cart?.items.length
    ? await Product.find({
        _id: { $in: cart.items.map((item) => item.product) },
      }).lean()
    : [];
  const byId = new Map(
    products.map((product) => [String(product._id), product]),
  );
  return {
    _id: cart ? String(cart._id) : null,
    user: userId,
    version: cart?.__v ?? 0,
    items: (cart?.items ?? []).map((item) => ({
      productId: String(item.product),
      product: byId.get(String(item.product)) ?? null,
      quantity: item.quantity,
    })),
  };
}

export class CartService {
  static async getCartByUserId(userId: string) {
    return presentCart(userId, await Cart.findOne({ user: userId }));
  }

  static async saveOrUpdateCart(userId: string, input: unknown) {
    const revision = cartRevision(input);
    const { items } = input as Record<string, unknown>;
    if (!Array.isArray(items) || items.length > 100)
      throw new CartValidationError(
        "Cart items must be an array of at most 100 products.",
      );
    const normalized: CartItemInput[] = [];
    const ids = new Set<string>();
    for (const value of items) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new CartValidationError("Invalid cart item.");
      const item = value as Record<string, unknown>;
      if (
        typeof item.product !== "string" ||
        !/^[a-fA-F0-9]{24}$/.test(item.product)
      )
        throw new CartValidationError("Invalid product ID.");
      if (
        typeof item.quantity !== "number" ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1
      )
        throw new CartValidationError(
          "Quantity must be a positive safe integer.",
        );
      const product = new Types.ObjectId(item.product).toHexString();
      if (ids.has(product))
        throw new CartValidationError("Duplicate product in cart.");
      ids.add(product);
      normalized.push({ product, quantity: item.quantity });
    }

    // Retained unavailable rows can stay unchanged/decrease while another bad
    // row is removed, but cannot be added/increased. Checkout rejects them all.
    const previous = revision.cartId
      ? await Cart.findOne({
          _id: revision.cartId,
          user: userId,
          ...revisionFilter(revision.version),
        })
      : null;
    if (revision.cartId && !previous) throw new CartConflictError();
    const products = await Product.find({ _id: { $in: [...ids] } }).select(
      "_id name stock isActive",
    );
    const byId = new Map(
      products.map((product) => [String(product._id), product]),
    );
    for (const item of normalized) {
      const product = byId.get(item.product);
      const oldQuantity =
        previous?.items.find((old) => String(old.product) === item.product)
          ?.quantity ?? 0;
      if (!product || !product.isActive || item.quantity > product.stock) {
        if (oldQuantity >= item.quantity) continue;
        throw new CartValidationError(
          "A product is unavailable or has insufficient stock. Review your cart.",
        );
      }
    }
    const cartItems = normalized.map((item) => ({
      product: new Types.ObjectId(item.product),
      quantity: item.quantity,
    }));
    let cart: CartDocument | null;
    if (revision.cartId === null) {
      try {
        // A fresh identity ensures this can only insert; the unique user index
        // rejects stale "no cart" snapshots. Explicit __v avoids save() resetting
        // a new document's version to zero after assignment.
        cart = await Cart.findOneAndUpdate(
          { _id: new Types.ObjectId(), user: userId },
          { $set: { items: cartItems }, $setOnInsert: { __v: 1 } },
          { upsert: true, returnDocument: "after", runValidators: true },
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === 11000
        )
          throw new CartConflictError();
        throw error;
      }
    } else {
      cart = await Cart.findOneAndUpdate(
        {
          _id: revision.cartId,
          user: userId,
          ...revisionFilter(revision.version),
        },
        { $set: { items: cartItems }, $inc: { __v: 1 } },
        { returnDocument: "after", runValidators: true },
      );
      if (!cart) throw new CartConflictError();
    }
    return presentCart(userId, cart);
  }
}
