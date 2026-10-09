import { Router } from "express";
import { ProductController } from "../controllers/product.controller";
import { protect } from "../middleware/auth.middleware";

import { requireAdmin } from "../middleware/admin.middleware";

const router = Router();

// Public storefront
router.get("/", ProductController.getProducts);
router.get("/:id", ProductController.getProductById);

// Admin-only operations
router.post("/", protect, requireAdmin, ProductController.createProduct);

router.patch("/:id", protect, requireAdmin, ProductController.updateProduct);

router.delete("/:id", protect, requireAdmin, ProductController.deleteProduct);

export default router;
