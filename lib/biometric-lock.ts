/**
 * Salary lock — Face ID / Touch ID / Windows Hello through WebAuthn.
 *
 * A passkey is created on this device's built-in authenticator
 * (`authenticatorAttachment: "platform"`) with `userVerification: "required"`,
 * so every unlock needs the biometric (or the device passcode, which the OS
 * always offers as its own fallback — the web cannot opt out of that).
 *
 * What this is and isn't: a presence check on the device in hand, so someone
 * holding your unlocked phone can't read your salary. It is not encryption —
 * the figure is still protected at rest by your account sign-in and the table's
 * row-level security. The client's part is to never fetch, render or cache the
 * salary until this check passes.
 *
 * Only the credential id is stored, in localStorage, to tell the browser which
 * passkey to ask for. It is not a secret.
 */

const STORAGE_KEY = "apsara.salaryLock.credentialId";

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

const toB64 = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const readCredentialId = (): string | null => {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
};

/** True once this device has a salary passkey registered. */
export const hasBiometricLock = (): boolean => readCredentialId() !== null;

/** Whether this browser has a user-verifying built-in authenticator at all. */
export const isBiometricAvailable = async (): Promise<boolean> => {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
};

/**
 * Bit 2 of the authenticator-data flags byte is UV — "the user was verified".
 * Checked explicitly so a lax authenticator that only tested presence can't
 * open the lock.
 */
const userWasVerified = (authenticatorData: ArrayBuffer) =>
  (new Uint8Array(authenticatorData)[32] & 0x04) !== 0;

export class BiometricError extends Error {}

const describe = (err: unknown): BiometricError => {
  if (err instanceof BiometricError) return err;
  // NotAllowedError covers both "user cancelled" and "timed out" — the browser
  // deliberately doesn't say which.
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return new BiometricError("Face ID was cancelled.");
  }
  return new BiometricError("Face ID isn't available right now.");
};

/** Creates this device's salary passkey. Prompts Face ID. */
export const registerBiometricLock = async (): Promise<void> => {
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: "Apsara Spend" },
        user: {
          id: randomBytes(16),
          name: "Salary lock",
          displayName: "Apsara Spend salary lock",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },   // ES256 — what Apple's platform authenticator uses
          { type: "public-key", alg: -257 }, // RS256 — Windows Hello
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "discouraged",
        },
        timeout: 60_000,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new BiometricError("Face ID setup didn't finish.");
    localStorage.setItem(STORAGE_KEY, toB64(credential.rawId));
  } catch (err) {
    throw describe(err);
  }
};

/** Asks for Face ID against this device's salary passkey. Resolves on success. */
export const unlockWithBiometric = async (): Promise<void> => {
  const id = readCredentialId();
  if (!id) throw new BiometricError("Set up Face ID first.");
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: "public-key", id: fromB64(id), transports: ["internal"] }],
        userVerification: "required",
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    const response = assertion?.response as AuthenticatorAssertionResponse | undefined;
    if (!response || !userWasVerified(response.authenticatorData)) {
      throw new BiometricError("Face ID didn't verify you.");
    }
  } catch (err) {
    throw describe(err);
  }
};

/** Forgets this device's passkey, e.g. after it was deleted in system settings. */
export const resetBiometricLock = () => {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
};
