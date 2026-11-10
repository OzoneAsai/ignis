/**
 * Token authentication is a live session state. Durable authentication is a
 * separate fact that needs an acknowledged write to the OS credential store.
 *
 * Obsidian's older mobile SecretStorage#setSecret is synchronous but starts
 * an unawaited native adapter.save(). In particular an ad-hoc signed iOS app
 * can report in-memory success while Keychain rejects its entitlement
 * (-34018). Test the backend's *actual* durable write and readback before
 * the public in-memory setter, where that backend is available.
 *
 * Unknown SecretStorage implementations remain usable for the current
 * session, but must not be described as restart-safe.
 */
export type SecretDurability = "verified" | "unverified" | "session-only";
type NativeAdapter = {
  save(contents: Record<string, string>): Promise<void>;
  load(): Promise<Record<string, string>>;
};
export type ScopedSecretStore = {
  setSecret(id: string, value: string): void | Promise<void>;
  secrets?: Record<string, string>;
  adapter?: Partial<NativeAdapter> | null;
};

export async function persistScopedDeviceCredential(
  store: ScopedSecretStore | null | undefined,
  secretId: string,
  token: string
): Promise<SecretDurability> {
  if (!store?.setSecret) return "session-only";
  const backend = store.adapter;
  if (backend && typeof backend.save === "function" &&
      typeof backend.load === "function" &&
      store.secrets && typeof store.secrets === "object") {
    try {
      // Preserve all unrelated secrets; do not overwrite this user's keychain
      // with a singleton object merely to test one Vault-scoped token.
      const proposed = { ...store.secrets, [secretId]: token };
      await backend.save(proposed);
      const restored = await backend.load();
      if (restored?.[secretId] !== token) return "session-only";
      await store.setSecret(secretId, token);
      return "verified";
    } catch {
      // Do not print tokens or backend error objects. The caller can keep
      // the already-verified network session and show a recovery warning.
      return "session-only";
    }
  }
  try {
    await store.setSecret(secretId, token);
    return "unverified";
  } catch {
    return "session-only";
  }
}
