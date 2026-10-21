import type { Request, Response } from "express";
import { AdminAnalyticsService, AnalyticsInputError, parseAnalyticsQuery } from "../services/adminAnalytics.service";

export async function getAdminAnalytics(req: Request, res: Response) {
  try {
    const filters = parseAnalyticsQuery(req.query);
    const report = await AdminAnalyticsService.report(filters);
    res.setHeader("Cache-Control", "no-store");
    return res.json(report);
  } catch (error) {
    if (error instanceof AnalyticsInputError) return res.status(400).json({ message: error.message });
    console.error("Sales analytics request failed:", error instanceof Error ? error.name : "Unknown error");
    return res.status(500).json({ message: "Unable to load sales analytics. Please try again." });
  }
}
