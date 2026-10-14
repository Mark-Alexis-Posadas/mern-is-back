import type { Request, Response, NextFunction } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { getJwtSecret } from "../utils/jwt";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    isAdmin: boolean;
  };
}

export const protect = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      message: "Not authorized, no token provided",
    });
    return;
  }

  const token = authHeader.slice(7).trim();

  let decoded: JwtPayload;

  try {
    decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
  } catch (error) {
    console.error(
      "JWT verification error:",
      error instanceof Error ? error.message : error,
    );

    res.status(401).json({
      message: "Not authorized, token failed",
    });
    return;
  }

  if (typeof decoded.id !== "string") {
    res.status(401).json({
      message: "Invalid token payload",
    });
    return;
  }

  req.user = {
    id: decoded.id,
    isAdmin: decoded.isAdmin === true,
  };

  next();
};
