import bcrypt from "bcryptjs";
import { User, type IUser } from "../models/user.model";
import { generateToken } from "../utils/jwt";
import {
  validateLogin,
  validateRegistration,
} from "../validators/auth.validation";

export class AuthError extends Error {
  constructor(
    public readonly status: 400 | 401,
    message: string,
  ) {
    super(message);
  }
}

// Public, non-account bcrypt hash (cost 10). Missing accounts still do a compare
// to reduce the obvious fast-failure distinction; this is not constant-time auth.
const DUMMY_PASSWORD_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export class AuthService {
  static async register(userData: unknown): Promise<{
    user: Omit<IUser, "password">;
    token: string;
  }> {
    const { name, email, password } = validateRegistration(userData);

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      throw new AuthError(400, "Unable to register with these details.");
    }

    const user = new User({
      name,
      email,
      password: hashedPassword,
    });

    try {
      await user.save();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 11000
      ) {
        throw new AuthError(400, "Unable to register with these details.");
      }
      throw error;
    }

    const token = generateToken(String(user._id), user.isAdmin);

    const userObj = user.toObject();
    delete (userObj as Partial<IUser>).password;

    return { user: userObj, token };
  }

  static async login(
    emailInput: unknown,
    passwordInput: unknown,
  ): Promise<{
    user: Omit<IUser, "password">;
    token: string;
  }> {
    const { email, password } = validateLogin({
      email: emailInput,
      password: passwordInput,
    });
    const user = await User.findOne({ email });
    const isMatch = await bcrypt.compare(
      password,
      user?.password ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !isMatch) {
      throw new AuthError(401, "Invalid email or password");
    }

    const token = generateToken(String(user._id), user.isAdmin);

    const userObj = user.toObject();
    delete (userObj as Partial<IUser>).password;

    return { user: userObj, token };
  }

  static async getCurrentUser(userId: string) {
    const user = await User.findById(userId).select("-password").lean();

    if (!user) {
      throw new Error("User not found");
    }

    return user;
  }
}
