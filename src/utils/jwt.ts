import jwt from "jsonwebtoken";

export const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  return secret;
};

export const generateToken = (userId: string, isAdmin: boolean): string => {
  return jwt.sign({ id: userId, isAdmin }, getJwtSecret(), { expiresIn: "7d" });
};
