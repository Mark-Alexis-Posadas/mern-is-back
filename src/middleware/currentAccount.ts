import { User } from "../models/user.model";
import type { AuthRequest } from "./auth.middleware";

interface CurrentAccount {
  isAdmin: boolean;
}
// Server-owned cache tied to the actual request object; never persisted, sent to
// clients, or reused across requests. Both protect and requireAdmin use it.
const accounts = new WeakMap<
  AuthRequest,
  { id: string; account: Promise<CurrentAccount | null> }
>();

export function currentAccount(
  req: AuthRequest,
  id: string,
): Promise<CurrentAccount | null> {
  const cached = accounts.get(req);
  if (cached?.id === id) return cached.account;
  const account = Promise.resolve().then(async () => {
    const user = await User.findById(id).select("isAdmin").lean();
    return user ? { isAdmin: user.isAdmin === true } : null;
  });
  accounts.set(req, { id, account });
  return account;
}
