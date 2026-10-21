import { Schema, Document, model } from "mongoose";

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
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

    isAdmin: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

// Customer directory filtering and deterministic newest-first pagination.
userSchema.index({ isAdmin: 1, createdAt: -1, _id: -1 });

export const User = model<IUser>("User", userSchema);
