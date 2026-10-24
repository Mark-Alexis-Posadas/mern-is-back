import { Schema, model } from "mongoose";
const checkoutAttemptSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    key: { type: String, required: true, maxlength: 128 },
    fingerprint: { type: String, required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
  },
  { timestamps: true },
);
// Must exist before enabling keyed checkout. A reservation is visible only once
// its stock/order/cart transaction commits; aborted attempts leave no record.
checkoutAttemptSchema.index({ user: 1, key: 1 }, { unique: true });
export const CheckoutAttempt = model("CheckoutAttempt", checkoutAttemptSchema);
