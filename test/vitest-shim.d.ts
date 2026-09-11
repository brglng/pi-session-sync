declare module "vitest" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
  interface Matchers<T> {
    rejects: Matchers<unknown>;
    resolves: Matchers<Awaited<T>>;
    not: Matchers<T>;
    toBe(expected: unknown): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeTruthy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toThrow(expected?: unknown): void;
    toBeNull(): void;
  }
  export function expect<T>(actual: T): Matchers<T>;
  /**
   * Minimal `vi` surface used by tests that deterministically inject a file
   * system failure. Only `mock` with a module factory is needed; `importOriginal`
   * resolves the real module so the override can delegate for every other call.
   */
  export const vi: {
    mock(
      modulePath: string,
      factory: (importOriginal: <T = unknown>() => Promise<T>) => unknown,
    ): void;
    /** Lift a value above the hoisted `vi.mock` factories. */
    hoisted<T>(factory: () => T): T;
  };
}
