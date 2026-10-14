import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import { OrderController } from "../controllers/order.controller";

const router = Router();

router.use(protect);

router.post("/", OrderController.createOrder);
router.get("/my", OrderController.getMyOrders);
router.get("/:id", OrderController.getOrderById);

export default router;
