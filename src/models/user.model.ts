import { Schema, Document, model } from "mongoose";

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  resetPasswordTokenHash?: string;
  resetPasswordExpiresAt?: Date;
  authVersion: number;
  isAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },
    password: { type: String, required: true },
    resetPasswordTokenHash: { type: String, select: false },
    resetPasswordExpiresAt: { type: Date, select: false },
    authVersion: { type: Number, required: true, default: 0 },

    isAdmin: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

// Customer directory filtering and deterministic newest-first pagination.
userSchema.index({ isAdmin: 1, createdAt: -1, _id: -1 });

export const User = model<IUser>("User", userSchema);
