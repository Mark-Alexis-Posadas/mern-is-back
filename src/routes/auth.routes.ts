import { Router, json, type ErrorRequestHandler } from "express";
import { AuthController } from "../controllers/auth.controller";
import { protect } from "../middleware/auth.middleware";
import {
  createAuthRateLimiter,
  LOGIN_RATE_LIMIT,
  REGISTRATION_RATE_LIMIT,
} from "../middleware/authRateLimit";

const router = Router();

// Public routes
const authJson = json({ limit: "8kb" });
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.post(
  "/register",
  createAuthRateLimiter(REGISTRATION_RATE_LIMIT),
  authJson,
  AuthController.register,
);
router.post(
  "/login",
  createAuthRateLimiter(LOGIN_RATE_LIMIT),
  authJson,
  AuthController.login,
);

// Protected routes
router.get("/me", protect, AuthController.getMe);

const authErrors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const type =
    typeof error === "object" && error !== null && "type" in error
      ? error.type
      : undefined;
  if (type === "entity.too.large") {
    res.status(413).json({ message: "Authentication request is too large." });
  } else if (type === "entity.parse.failed" || error instanceof SyntaxError) {
    res.status(400).json({ message: "A valid JSON request is required." });
  } else {
    res
      .status(500)
      .json({ message: "Authentication unavailable. Please try again." });
  }
};
router.use(authErrors);

export default router;
