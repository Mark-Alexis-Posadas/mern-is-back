import express, { Application, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import productRoutes from "./routes/product.routes";

dotenv.config();

const app: Application = express();

// Middleware
app.use(cors());
app.use(express.json());

app.use("/api/products", productRoutes);

// Base Route
app.get("/", (req: Request, res: Response) => {
  res.json({ message: "Welcome to the E-Commerce API!" });
});

export default app;
