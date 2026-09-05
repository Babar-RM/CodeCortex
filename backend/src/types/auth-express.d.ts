declare module "@auth/express" {
  export interface Session {
    githubAccessToken?: string;
    githubId?: string;
    githubLogin?: string;
    avatarUrl?: string;
    user?: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }

  export interface JWTToken {
    githubAccessToken?: string;
    githubId?: string;
    githubLogin?: string;
    avatarUrl?: string;
    [key: string]: unknown;
  }

  export interface ExpressAuthConfig {
    providers: unknown[];
    secret?: string;
    trustHost?: boolean;
    callbacks?: {
      jwt?: (params: { token: JWTToken; account?: { access_token?: string } | null; profile?: { id?: string | number; login?: string; avatar_url?: string } | null }) => Promise<JWTToken> | JWTToken;
      session?: (params: { session: Session; token: JWTToken }) => Promise<Session> | Session;
    };
  }

  export function ExpressAuth(config: ExpressAuthConfig): (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
  export function getSession(req: unknown, config: ExpressAuthConfig): Promise<Session | null>;
}

declare module "@auth/express/providers/github" {
  export default function GitHub(config: {
    clientId?: string;
    clientSecret?: string;
    authorization?: {
      params?: {
        scope?: string;
      };
    };
  }): unknown;
}
