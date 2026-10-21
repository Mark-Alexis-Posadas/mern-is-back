import { Router, type ErrorRequestHandler } from "express";
import { protect } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/requireAdmin";
import { getAdminAnalytics } from "../controllers/adminAnalytics.controller";

const router = Router();
router.use(protect, requireAdmin);
router.get("/", getAdminAnalytics);
// Also sanitize database errors raised by authorization, before the controller runs.
const analyticsErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  console.error("Sales analytics authorization failed:", error instanceof Error ? error.name : "Unknown error");
  res.status(500).json({ message: "Unable to load sales analytics. Please try again." });
};
router.use(analyticsErrorHandler);
export default router;
