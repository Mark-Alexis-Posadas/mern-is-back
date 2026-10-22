import type { Request, Response, NextFunction } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { getJwtSecret } from "../utils/jwt";
import { currentAccount } from "./currentAccount";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    isAdmin: boolean;
  };
}

export const protect = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      message: "Not authorized, no token provided",
    });
    return;
  }

  const token = authHeader.slice(7).trim();

  let decoded: JwtPayload | string;

  try {
    decoded = jwt.verify(token, getJwtSecret());
  } catch {
    res.status(401).json({
      message: "Not authorized, token failed",
    });
    return;
  }

  if (
    typeof decoded === "string" ||
    typeof decoded.id !== "string" ||
    !/^[a-fA-F0-9]{24}$/.test(decoded.id)
  ) {
    res.status(401).json({
      message: "Invalid token payload",
    });
    return;
  }

  try {
    const user = await currentAccount(req, decoded.id);
    if (!user) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    req.user = { id: decoded.id, isAdmin: user.isAdmin };
    next();
  } catch {
    res
      .status(500)
      .json({ message: "Unable to authenticate. Please try again." });
  }
};
