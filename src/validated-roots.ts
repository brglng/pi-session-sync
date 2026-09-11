/// <reference types="node" />

/**
 * Opaque, non-forgeable validated-root token produced exclusively by
 * `validateSyncRoots`. Public callers cannot construct one: membership in
 * this module-private WeakSet is the only identity check, so a fabricated
 * object can never pass even by copying symbols or inherited properties.
 * `syncSessionsWithValidatedRoots` — the only consumer — verifies both the
 * identity and the complete validated tuple
 * (sessionsRoot, targetDir, missionsRoot, logical and physical target roots)
 * against the options it is invoked with before trusting it.
 */
const VALIDATED_ROOTS_REGISTRY = new WeakSet<object>();

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
  /** Resolved local missions root the token was validated for. */
  readonly missionsRoot: string;
  /** Fully resolved physical (ancestor aliases included) targetDir identity. */
  readonly physicalTargetRoot: string;
  /** Target sessions root `targetDir/sessions`. */
  readonly sessionsTargetRoot: string;
  /** Target missions root `targetDir/missions`. */
  readonly missionsTargetRoot: string;
}

export function makeValidatedSyncRoots(fields: ValidatedSyncRoots): ValidatedSyncRoots {
  // Freeze the token so a caller can never mutate the validated roots after
  // they were checked, and register the exact object identity in the
  // module-private WeakSet: only this factory can mint accepted tokens.
  const token: ValidatedSyncRoots = Object.freeze({ ...fields });
  VALIDATED_ROOTS_REGISTRY.add(token);
  return token;
}

export function isValidatedSyncRoots(value: unknown): value is ValidatedSyncRoots {
  return (
    typeof value === "object" && value !== null && VALIDATED_ROOTS_REGISTRY.has(value as object)
  );
}
