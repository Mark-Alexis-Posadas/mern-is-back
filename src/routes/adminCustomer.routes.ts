import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/requireAdmin";
import { getAdminCustomer, getAdminCustomers } from "../controllers/adminCustomer.controller";

const router = Router();
router.use(protect, requireAdmin);
router.get("/", getAdminCustomers);
router.get("/:id", getAdminCustomer);
export default router;
