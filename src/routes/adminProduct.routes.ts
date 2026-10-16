import { Router } from "express";

import { protect } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/admin.middleware";
import { AdminInventoryController } from "../controllers/adminInventory.controller";
import { AdminProductController } from "../controllers/adminProduct.controller";

const router = Router();

router.use(protect);
router.use(requireAdmin);

router.get("/", AdminProductController.getAllProducts);

router.get("/:id", AdminProductController.getProductById);

router.post("/", AdminProductController.createProduct);

router.patch("/:id", AdminProductController.updateProduct);

router.patch("/:id/status", AdminProductController.updateProductStatus);
router.patch("/:id/stock", AdminInventoryController.adjustStock);
export default router;
