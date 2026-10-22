import type { Response, NextFunction } from "express";
import mongoose from "mongoose";

import { currentAccount } from "./currentAccount";
import type { AuthRequest } from "./auth.middleware";

export const requireAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId || !mongoose.isValidObjectId(userId)) {
      res.status(401).json({
        message: "Authentication required",
      });
      return;
    }

    // Reuse protect's server-owned request cache, or load it when called alone.
    const user = await currentAccount(req, userId);

    if (!user) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    if (user.isAdmin !== true) {
      res.status(403).json({
        message: "Admin access required",
      });
      return;
    }

    // Downstream handlers see the authorized current role, even for older JWTs.
    req.user = { id: userId, isAdmin: true };
    next();
  } catch (error) {
    next(error);
  }
};
