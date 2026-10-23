import mongoose, { type ClientSession, Types } from "mongoose";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { Product } from "../models/product.model";

interface MovementInput {
  product: Types.ObjectId;
  type: "manual" | "sale" | "cancellation";
  actorType: "admin" | "customer" | "system";
  actor?: Types.ObjectId;
  order?: Types.ObjectId;
  adjustment: number;
  previousStock: number;
  newStock: number;
  reason: string;
  note?: string;
}

// Audit only: never changes stock. The caller must pass its business session.
export async function recordInventoryMovement(
  session: ClientSession,
  input: MovementInput,
) {
  if (!session.inTransaction())
    throw new Error("Inventory auditing requires an active transaction.");
  if (
    !Number.isSafeInteger(input.adjustment) ||
    input.adjustment === 0 ||
    !Number.isSafeInteger(input.previousStock) ||
    input.previousStock < 0 ||
    !Number.isSafeInteger(input.newStock) ||
    input.newStock < 0 ||
    input.newStock - input.previousStock !== input.adjustment ||
    (input.type === "sale" && (input.adjustment >= 0 || !input.order)) ||
    (input.type === "cancellation" &&
      (input.adjustment <= 0 || !input.order)) ||
    (input.actorType !== "system" && !input.actor)
  )
    throw new Error("Invalid inventory movement.");
  await InventoryMovement.create(
    [
      {
        ...input,
        ...(input.actorType === "admin" ? { admin: input.actor } : {}),
      },
    ],
    { session },
  );
}

// Product creation is also a stock-changing operation when initial stock > 0.
export async function createProductWithInventory(
  data: Record<string, unknown>,
  adminId: string,
) {
  const stock = data.stock ?? 0;
  if (typeof stock !== "number" || !Number.isSafeInteger(stock) || stock < 0)
    throw new Error("Initial stock must be a non-negative integer");
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const product = new Product({ ...data, stock });
      await product.save({ session });
      if (stock > 0)
        await recordInventoryMovement(session, {
          product: product._id,
          type: "manual",
          actorType: "admin",
          actor: new Types.ObjectId(adminId),
          adjustment: stock,
          previousStock: 0,
          newStock: stock,
          reason: "Initial product stock",
        });
      return product;
    });
  } finally {
    await session.endSession();
  }
}
