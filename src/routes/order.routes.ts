import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import { OrderController } from "../controllers/order.controller";

const router = Router();

router.use(protect);

router.post("/", OrderController.createOrder);
router.post("/:id/cancel", OrderController.cancelOwnOrder);
router.get("/checkout-attempts/:key", OrderController.getCheckoutAttempt);
router.get("/my", OrderController.getMyOrders);
router.get("/:id", OrderController.getOrderById);

export default router;
