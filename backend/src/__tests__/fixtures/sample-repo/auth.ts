import { BaseManager } from "./base";
import { verifyToken } from "./helpers";

export class AuthManager extends BaseManager {
  public authenticate(token: string): boolean {
    return handleAuth(token);
  }
}

export function handleAuth(token: string): boolean {
  return verifyToken(token);
}
