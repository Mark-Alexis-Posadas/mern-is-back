import {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
} from "mongoose";

const productSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      minlength: [2, "Name must have at least 2 characters"],
      maxlength: [150, "Name cannot exceed 150 characters"],
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid product slug"],
    },

    sku: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 10000,
    },

    shortDescription: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
    },

    price: {
      type: Number,
      required: true,
      min: [0, "Price cannot be negative"],
      validate: {
        validator: Number.isFinite,
        message: "Price must be a finite number",
      },
    },

    compareAtPrice: {
      type: Number,
      min: 0,
      validate: {
        validator: (value: number | null | undefined) =>
          value == null || Number.isFinite(value),
        message: "Compare-at price must be finite",
      },
      default: null,
    },

    category: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    brand: {
      type: String,
      trim: true,
      default: "",
    },

    stock: {
      type: Number,
      required: true,
      min: [0, "Stock cannot be negative"],
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: "Stock must be a whole number",
      },
    },

    lowStockThreshold: {
      type: Number,
      min: 0,
      default: 5,
      validate: {
        validator: Number.isInteger,
        message: "Threshold must be a whole number",
      },
    },

    images: {
      type: [
        {
          url: {
            type: String,
            required: true,
            trim: true,
          },
          alt: {
            type: String,
            trim: true,
            default: "",
          },
          isPrimary: {
            type: Boolean,
            default: false,
          },
        },
      ],
      default: [],
    },

    tags: {
      type: [String],
      default: [],
    },

    weight: {
      type: Number,
      min: 0,
      default: null,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    isFeatured: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for common product listing queries
productSchema.index({
  isActive: 1,
  category: 1,
  createdAt: -1,
});

productSchema.index({
  isActive: 1,
  isFeatured: 1,
  createdAt: -1,
});

// Basic product search
productSchema.index({
  name: "text",
  description: "text",
  brand: "text",
});

export type IProduct = InferSchemaType<typeof productSchema>;

export type ProductDocument = HydratedDocument<IProduct>;

export const Product = model<IProduct>("Product", productSchema);
