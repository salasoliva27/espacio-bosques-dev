import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { logger } from "./utils/logger";
import { errorHandler } from "./middleware/errorHandler";
import { rateLimiter } from "./middleware/rateLimiter";
import "./config/mode"; // initializes simulation mode + prints startup logs

// Routes
import authRoutes from "./routes/auth";
import projectRoutes from "./routes/projects";
import aiRoutes from "./routes/ai";
import simulationRoutes from "./routes/simulation";
import reportRoutes from "./routes/reports";
import investRoutes from "./routes/invest";
import testRoutes from "./routes/test";
import balanceRoutes from "./routes/balance";
import providerRoutes from "./routes/providers";
import governanceRoutes from "./routes/governance";
import moneyflowRoutes from "./routes/moneyflow";
import notificationRoutes from "./routes/notifications";
import feedRoutes from "./routes/feed";
import profileRoutes from "./routes/profile";
import statsRoutes from "./routes/stats";
import rfcRoutes from "./routes/rfc";
import userProfileRoutes from "./routes/userProfile";
import realityCheckRoutes from "./routes/realityCheck";
import { warmBlacklist } from "./services/satBlacklist";

// Initialize environment
dotenv.config({ path: "../.env" });

// Initialize Prisma
export const prisma = new PrismaClient();

// Create Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
const CORS_ORIGINS = [
  process.env.CORS_ORIGIN,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5175",
  "http://localhost:5176",
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Playwright direct, etc.)
    if (!origin) return callback(null, true);
    if (CORS_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("combined", { stream: { write: (message) => logger.info(message.trim()) } }));
app.use(rateLimiter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/simulate", simulationRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/invest", investRoutes);
app.use("/api/balance", balanceRoutes);
app.use("/api/providers", providerRoutes);
app.use("/api/governance", governanceRoutes);
app.use("/api/moneyflow", moneyflowRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/feed", feedRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/rfc", rfcRoutes);
app.use("/api/user/profile", userProfileRoutes);
app.use("/api/reality-check", realityCheckRoutes);

// Test harness — simulation mode only
import { SIMULATION_MODE } from "./config/mode";
if (SIMULATION_MODE()) {
  app.use("/api/test", testRoutes);
  logger.info("🧪 Test harness mounted at /api/test (simulation mode)");
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use(errorHandler);

// Start server
const server = app.listen(PORT, () => {
  logger.info(`🚀 Espacio Bosques backend listening on port ${PORT}`);
  warmBlacklist(); // pre-load SAT 69-B blacklist in background
  logger.info(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
  logger.info(`🌐 CORS enabled for: ${process.env.CORS_ORIGIN || "http://localhost:5173"}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM signal received: closing HTTP server");
  server.close(async () => {
    await prisma.$disconnect();
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  logger.info("SIGINT signal received: closing HTTP server");
  server.close(async () => {
    await prisma.$disconnect();
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

export default app;
