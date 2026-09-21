import { Request, Response, NextFunction } from "express";
import { getSession } from "@auth/express";
import { authConfig } from "../lib/auth";
import { prisma, withRetry } from "../lib/prisma";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await getSession(req, authConfig);

    if (!session || !session.githubId || !session.githubLogin) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const email = session.user?.email || null;
    const githubLogin = session.githubLogin;
    const avatarUrl = session.avatarUrl || null;

    // Upsert user profile on every authenticated request to keep data fresh
    const user = await withRetry(() =>
      prisma.user.upsert({
        where: { githubId: session.githubId },
        update: {
          githubLogin,
          avatarUrl,
          email,
        },
        create: {
          githubId: session.githubId,
          githubLogin,
          avatarUrl,
          email,
        },
      })
    );

    req.user = user;
    req.githubAccessToken = session.githubAccessToken;
    next();
  } catch (error) {
    console.error("Authentication error in requireAuth:", error);
    return res.status(401).json({ error: "Unauthorized" });
  }
}
