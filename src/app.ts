import express, { Application, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import productRoutes from "./routes/product.routes";
import authRoutes from "./routes/auth.routes";
import cartRoutes from "./routes/cart.routes";
import orderRoutes from "./routes/order.routes";
import adminOrderRoutes from "./routes/adminOrder.routes";
import adminCustomerRoutes from "./routes/adminCustomer.routes";
import adminAnalyticsRoutes from "./routes/adminAnalytics.routes";
import adminProductRoutes from "./routes/adminProduct.routes";
import adminInventoryHistoryRoutes from "./routes/adminInventoryHistory.routes";

dotenv.config();

const app: Application = express();

// Middleware
app.use(cors());
// Auth applies throttling before its bounded JSON parser, including bad bodies.
app.use("/api/auth", authRoutes);
app.use(express.json());
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
// Each admin router authorizes its own endpoints against the current database role.
app.use("/api/admin/analytics", adminAnalyticsRoutes);
app.use("/api/admin", adminOrderRoutes);
app.use("/api/admin/customers", adminCustomerRoutes);
app.use("/api/admin/products", adminProductRoutes);
app.use("/api/admin/inventory", adminInventoryHistoryRoutes);
// Base Route
app.get("/", (req: Request, res: Response) => {
  res.json({ message: "Welcome to the E-Commerce API!" });
});

export default app;
