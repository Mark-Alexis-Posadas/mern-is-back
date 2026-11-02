import jwt from "jsonwebtoken";

export const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  return secret;
};

export const generateToken = (
  userId: string,
  isAdmin: boolean,
  authVersion = 0,
): string => {
  return jwt.sign({ id: userId, isAdmin, authVersion }, getJwtSecret(), {
    expiresIn: "7d",
  });
};
