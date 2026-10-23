import { Schema, model } from "mongoose";

const inventoryMovementSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    admin: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    type: {
      type: String,
      enum: ["manual", "sale", "cancellation"],
      default: "manual",
    },
    actorType: {
      type: String,
      enum: ["admin", "customer", "system"],
      default: "admin",
    },
    actor: { type: Schema.Types.ObjectId, ref: "User" },
    order: { type: Schema.Types.ObjectId, ref: "Order" },
    note: { type: String, trim: true, maxlength: 500 },
    adjustment: {
      type: Number,
      required: true,
    },
    previousStock: {
      type: Number,
      required: true,
    },
    newStock: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
  },
);

inventoryMovementSchema.index({
  product: 1,
  createdAt: -1,
});
inventoryMovementSchema.index({ createdAt: -1, _id: -1 });
inventoryMovementSchema.index({ type: 1, createdAt: -1, _id: -1 });
// At most one sale and one cancellation row per order/product. Legacy manual
// rows have no order and are excluded, so no historical backfill is required.
inventoryMovementSchema.index(
  { order: 1, product: 1, type: 1 },
  { unique: true, partialFilterExpression: { order: { $type: "objectId" } } },
);

export const InventoryMovement = model(
  "InventoryMovement",
  inventoryMovementSchema,
);
