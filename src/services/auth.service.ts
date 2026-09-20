import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User, IUser } from "../models/user.model";

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_key";

export class AuthService {
  static async register(
    userData: Partial<IUser>,
  ): Promise<{ user: Omit<IUser, "password">; token: string }> {
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

    const token = jwt.sign(
      { id: user._id, isAdmin: user.isAdmin },
      JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );

    const userObj = user.toObject();
    delete (userObj as any).password;

    return { user: userObj, token };
  }

  static async login(
    email: string,
    password: string,
  ): Promise<{ user: Omit<IUser, "password">; token: string }> {
    const user = await User.findOne({ email });
    if (!user) {
      throw new Error("Invalid email or password");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      throw new Error("Invalid email or password");
    }

    const token = jwt.sign(
      { id: user._id, isAdmin: user.isAdmin },
      JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );

    const userObj = user.toObject();
    delete (userObj as any).password;

    return { user: userObj, token };
  }
}
