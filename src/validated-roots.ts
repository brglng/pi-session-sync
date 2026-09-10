/// <reference types="node" />

/**
 * Opaque, non-forgeable validated-root token produced exclusively by
 * `validateSyncRoots`. Public callers cannot construct one: the private brand
 * symbol is defined in this module (never re-exported from the package's
 * public surface), and `syncSessionsWithValidatedRoots` — the only consumer —
 * verifies both the brand and the complete validated tuple
 * (sessionsRoot, targetDir, missionsRoot, logical and physical target roots)
 * against the options it is invoked with before trusting it.
 */
const VALIDATED_ROOTS_BRAND: unique symbol = Symbol("brglng.pi-session-sync.validatedRoots");

/**
 * Validated root tuple produced by `validateSyncRoots`: resolved lexical
 * target paths plus the physical (fully resolved) targetDir identity used for
 * source-symlink containment checks. The brand is a private, non-enumerable
 * marker so forged or fabricated objects never pass the token check.
 */
export interface ValidatedSyncRoots {
  /** Resolved local sessions root the token was validated for. */
  readonly sessionsRoot: string;
  /** Resolved lexical targetDir the token was validated for. */
  readonly targetRoot: string;
  /** Resolved local missions root (undefined when missions are disabled). */
  readonly missionsRoot: string | undefined;
  /** Fully resolved physical (ancestor aliases included) targetDir identity. */
  readonly physicalTargetRoot: string;
  /** Target sessions root `targetDir/sessions`. */
  readonly sessionsTargetRoot: string;
  /** Target missions root `targetDir/missions`; undefined when missions are disabled. */
  readonly missionsTargetRoot: string | undefined;
}

export function makeValidatedSyncRoots(fields: ValidatedSyncRoots): ValidatedSyncRoots {
  const token: Record<symbol, unknown> = { ...fields };
  Object.defineProperty(token, VALIDATED_ROOTS_BRAND, {
    value: VALIDATED_ROOTS_BRAND,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // SAFETY: the brand symbol is a non-enumerable, non-writable, non-configurable
  // property and the returned object's structurally-typed fields are exactly the
  // validated strings passed in; the cast only widens the branded object back to
  // the public interface after the private brand was attached.
  return token as unknown as ValidatedSyncRoots;
}

export function isValidatedSyncRoots(value: unknown): value is ValidatedSyncRoots {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<symbol, unknown>)[VALIDATED_ROOTS_BRAND] === VALIDATED_ROOTS_BRAND;
}
