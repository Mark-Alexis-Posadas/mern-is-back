import type { Response, NextFunction } from "express";
import type { AuthRequest } from "../types/auth.types";

export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.user) {
    res.status(401).json({
      message: "Authentication required",
    });
    return;
  }

  if (!req.user.isAdmin) {
    res.status(403).json({
      message: "Admin access required",
    });
    return;
  }

  next();
};
