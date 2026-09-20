import { Router } from "express";
import { CartController } from "../controllers/cart.controller";
import { protect } from "../middleware/auth.middleware";

const router = Router();

router.get("/", protect, CartController.getCart);
router.put("/", protect, CartController.updateCart);

export default router;
