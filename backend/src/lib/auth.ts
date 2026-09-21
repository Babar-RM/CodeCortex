import dotenv from "dotenv";
dotenv.config();

import GitHub from "@auth/express/providers/github";
import type { ExpressAuthConfig, JWTToken, Session } from "@auth/express";
import { skipCSRFCheck } from "@auth/core";

export const authConfig: ExpressAuthConfig = {
  basePath: "/auth",
  skipCSRFCheck: skipCSRFCheck,
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID || process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET || process.env.AUTH_GITHUB_SECRET,
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
    }),
  ],
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  callbacks: {
    async jwt({ token, account, profile }: { token: JWTToken; account?: { access_token?: string } | null; profile?: { id?: string | number; login?: string; avatar_url?: string } | null }) {
      if (account && profile) {
        token.githubAccessToken = account.access_token;
        token.githubId = String(profile.id);
        token.githubLogin = profile.login;
        token.avatarUrl = profile.avatar_url;
      }
      return token;
    },
    async session({ session, token }: { session: Session; token: JWTToken }) {
      session.githubAccessToken = token.githubAccessToken as string | undefined;
      session.githubId = token.githubId as string | undefined;
      session.githubLogin = token.githubLogin as string | undefined;
      session.avatarUrl = token.avatarUrl as string | undefined;
      return session;
    },
    async redirect({ url, baseUrl }: { url: string; baseUrl: string }) {
      const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
      // Allow redirects to the frontend origin (cross-origin)
      if (url.startsWith(frontendOrigin)) {
        return url;
      }
      // Allow relative URLs
      if (url.startsWith("/")) {
        return `${frontendOrigin}${url}`;
      }
      // Allow same-origin (backend) redirects
      if (url.startsWith(baseUrl)) {
        return url;
      }
      // Default: redirect to frontend dashboard
      return `${frontendOrigin}/dashboard`;
    },
  },
};
