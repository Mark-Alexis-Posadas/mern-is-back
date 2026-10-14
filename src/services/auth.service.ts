import bcrypt from "bcryptjs";
import { User, type IUser } from "../models/user.model";
import { generateToken } from "../utils/jwt";

export class AuthService {
  static async register(userData: Partial<IUser>): Promise<{
    user: Omit<IUser, "password">;
    token: string;
  }> {
    const { name, email, password } = userData;

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      throw new Error("User already exists with this email");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password!, salt);

    const user = new User({
      name,
      email,
      password: hashedPassword,
    });

    await user.save();

    const token = generateToken(String(user._id), user.isAdmin);

    const userObj = user.toObject();
    delete (userObj as Partial<IUser>).password;

    return { user: userObj, token };
  }

  static async login(
    email: string,
    password: string,
  ): Promise<{
    user: Omit<IUser, "password">;
    token: string;
  }> {
    const user = await User.findOne({ email });

    if (!user) {
      throw new Error("Invalid email or password");
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      throw new Error("Invalid email or password");
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
