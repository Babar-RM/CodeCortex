import GitHub from "@auth/express/providers/github";
import type { ExpressAuthConfig, JWTToken, Session } from "@auth/express";

export const authConfig: ExpressAuthConfig = {
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID || "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
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
  },
};
