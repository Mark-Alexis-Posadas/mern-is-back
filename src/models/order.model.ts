import { Schema, model, Types } from "mongoose";

export interface IOrderItem {
  product: Types.ObjectId;
  name: string;
  sku: string;
  price: number;
  quantity: number;
  imageUrl?: string;
}

export interface IShippingAddress {
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  province: string;
  postalCode: string;
}

export interface IOrder {
  user: Types.ObjectId;
  items: IOrderItem[];
  shippingAddress: IShippingAddress;
  paymentMethod: "COD";
  paymentStatus: "unpaid" | "paid";
  paidAt?: Date;
  paymentCollectedBy?: Types.ObjectId;
  orderStatus: "pending" | "confirmed" | "shipped" | "delivered" | "cancelled";
  subtotal: number;
  shippingFee: number;
  total: number;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: { type: String, required: true },
    sku: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    imageUrl: String,
  },
  { _id: false },
);

const shippingAddressSchema = new Schema<IShippingAddress>(
  {
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    addressLine1: { type: String, required: true, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    province: { type: String, required: true, trim: true },
    postalCode: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (items: IOrderItem[]) => items.length > 0,
        message: "Order must contain at least one item.",
      },
    },
    shippingAddress: {
      type: shippingAddressSchema,
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ["COD"],
      default: "COD",
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid"],
      default: "unpaid",
    },
    // Payment audit is admin-only by default; legacy orders may omit both.
    paidAt: { type: Date, select: false },
    paymentCollectedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      select: false,
    },
    orderStatus: {
      type: String,
      enum: ["pending", "confirmed", "shipped", "delivered", "cancelled"],
      default: "pending",
    },
    subtotal: { type: Number, required: true, min: 0 },
    shippingFee: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

// Reverse scans support oldest-first as well as newest-first customer history.
orderSchema.index({ user: 1, createdAt: -1, _id: -1 });
// Analytics date-range scans across all customers.
orderSchema.index({ createdAt: -1, _id: -1 });
// Collection-date reporting is independent of the order creation date.
orderSchema.index(
  { paidAt: -1, _id: -1 },
  { partialFilterExpression: { paidAt: { $exists: true } } },
);

export const Order = model<IOrder>("Order", orderSchema);
