import { Request, Response } from "express";
import { AuthService } from "../services/auth.service";
import type { AuthRequest } from "../middleware/auth.middleware";
export class AuthController {
  static async register(req: Request, res: Response): Promise<void> {
    try {
      const result = await AuthService.register(req.body);
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({
        message: error instanceof Error ? error.message : "Registration failed",
      });
    }
  }

  static async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body;
      const result = await AuthService.login(email, password);
      res.json(result);
    } catch (error) {
      res.status(401).json({
        message: error instanceof Error ? error.message : "Login failed",
      });
    }
  }

  static async getMe(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          message: "Not authorized",
        });
        return;
      }

      const user = await AuthService.getCurrentUser(req.user.id);

      res.status(200).json(user);
    } catch (error) {
      if (error instanceof Error && error.message === "User not found") {
        res.status(401).json({
          message: "User account no longer exists",
        });
        return;
      }

      res.status(500).json({
        message: "Failed to retrieve user profile",
      });
    }
  }
}
