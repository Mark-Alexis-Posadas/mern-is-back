import mongoose, { type QueryFilter } from "mongoose";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { Product } from "../models/product.model";

export type MovementType =
  "all" | "added" | "removed" | "manual" | "sale" | "cancellation";
export const MOVEMENT_FILTERS: readonly string[] = [
  "all",
  "added",
  "removed",
  "manual",
  "sale",
  "cancellation",
];

type GetMovementsParams = {
  page?: number;
  limit?: number;
  productId?: string;
  orderId?: string;
  search?: string;
  type?: MovementType;
};

export class AdminInventoryHistoryService {
  static async getMovements({
    page = 1,
    limit = 10,
    productId,
    orderId,
    search = "",
    type = "all",
  }: GetMovementsParams) {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error("Invalid pagination parameters.");
    }
    if (productId && !mongoose.isValidObjectId(productId)) {
      throw new Error("Invalid product ID.");
    }
    if (!MOVEMENT_FILTERS.includes(type)) {
      throw new Error("Invalid movement type.");
    }
    if (orderId && !mongoose.isValidObjectId(orderId))
      throw new Error("Invalid order ID.");
    const query = search.trim();
    if (query.length > 100) {
      throw new Error("Search must be 100 characters or fewer.");
    }

    const filter: QueryFilter<InstanceType<typeof InventoryMovement>> = {};
    if (productId) filter.product = new mongoose.Types.ObjectId(productId);
    if (type === "added") filter.adjustment = { $gt: 0 };
    if (type === "removed") filter.adjustment = { $lt: 0 };
    if (type === "manual")
      filter.$or = [{ type: "manual" }, { type: { $exists: false } }];
    if (type === "sale" || type === "cancellation") filter.type = type;
    if (orderId) filter.order = new mongoose.Types.ObjectId(orderId);

    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matchingProducts = await Product.find({
        $or: [
          { name: { $regex: escaped, $options: "i" } },
          { sku: { $regex: escaped, $options: "i" } },
        ],
      }).distinct("_id");
      if (productId) {
        if (!matchingProducts.some((id) => String(id) === productId)) {
          return {
            movements: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
          };
        }
      } else {
        filter.product = { $in: matchingProducts };
      }
    }

    const [movements, total] = await Promise.all([
      InventoryMovement.find(filter)
        .populate("product", "name sku images")
        .populate("admin", "name email")
        .populate("actor", "name email")
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      InventoryMovement.countDocuments(filter),
    ]);

    return {
      movements: movements.map((movement) => ({
        ...movement,
        admin: movement.admin ?? null,
        type: movement.type ?? "manual",
        actorType: movement.actorType ?? "admin",
        actor: movement.actor ?? movement.admin ?? null,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
