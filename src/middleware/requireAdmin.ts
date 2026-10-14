import type { Response, NextFunction } from "express";
import mongoose from "mongoose";

import { User } from "../models/user.model";
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

    const user = await User.findById(userId).select("isAdmin").lean();

    if (!user || !user.isAdmin) {
      res.status(403).json({
        message: "Admin access required",
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
};
