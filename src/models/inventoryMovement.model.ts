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
      required: true,
    },
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

export const InventoryMovement = model(
  "InventoryMovement",
  inventoryMovementSchema,
);
