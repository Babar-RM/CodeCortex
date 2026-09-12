import express, { Express, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ExpressAuth } from "@auth/express";
import { authConfig } from "./lib/auth";
import { requireAuth } from "./middleware/requireAuth";
import { reposRouter } from "./routes/repos";
import { chatRouter } from "./routes/chat";

dotenv.config();

export const app: Express = express();
const port = process.env.PORT || 4000;
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

app.use(
  cors({
    origin: frontendOrigin,
    credentials: true,
  })
);

// Auth.js route mounted BEFORE express.json() per RFC 0002
app.use("/auth", ExpressAuth(authConfig));

app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// Protected identity test route (RFC 0002)
app.get("/api/me", requireAuth, (req: Request, res: Response) => {
  res.status(200).json({
    user: req.user,
    hasToken: Boolean(req.githubAccessToken),
  });
});

// Protected repository connection routes (RFC 0004)
app.use("/api/repos", reposRouter);

// Protected chat persistence routes (RFC 0012)
app.use("/api/chat", chatRouter);

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`Backend API server running on port ${port}`);
  });
}
