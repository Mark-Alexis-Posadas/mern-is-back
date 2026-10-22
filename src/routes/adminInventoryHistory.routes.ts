import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/requireAdmin";
import { AdminInventoryHistoryController } from "../controllers/adminInventoryHistory.controller";

const router = Router();

router.use(protect, requireAdmin);

router.get("/movements", AdminInventoryHistoryController.getMovements);

export default router;
