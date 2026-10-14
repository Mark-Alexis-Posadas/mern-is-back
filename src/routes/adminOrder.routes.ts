import { Router } from "express";

import { protect } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/admin.middleware";
import {
  getAllAdminOrders,
  getAdminOrderById,
  updateAdminOrderStatus,
} from "../controllers/adminOrder.controller";

const router = Router();

router.use(protect);
router.use(requireAdmin);

router.get("/orders", getAllAdminOrders);
router.get("/orders/:id", getAdminOrderById);
router.patch("/orders/:id/status", updateAdminOrderStatus);

export default router;
