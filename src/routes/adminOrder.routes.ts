import { Router } from "express";

import { protect } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  getAllAdminOrders,
  getAdminOrderById,
  updateAdminOrderStatus,
} from "../controllers/adminOrder.controller";

const router = Router();

// This router is mounted at /api/admin. Guard matched order endpoints only so
// sibling admin modules do not perform a second authentication/role lookup.
router.get("/orders", protect, requireAdmin, getAllAdminOrders);
router.get("/orders/:id", protect, requireAdmin, getAdminOrderById);
router.patch(
  "/orders/:id/status",
  protect,
  requireAdmin,
  updateAdminOrderStatus,
);

export default router;
