import { Router } from "express";
import { OrderController } from "../controllers/order.controller";
import { protect } from "../middleware/auth.middleware";

const router = Router();

router.post("/", protect, OrderController.createOrder);
router.get("/myorders", protect, OrderController.getMyOrders);
router.get("/:id", protect, OrderController.getOrderById);

export default router;
