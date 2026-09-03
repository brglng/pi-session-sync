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
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toThrow(expected?: unknown): void;
    toBeNull(): void;
  }
  export function expect<T>(actual: T): Matchers<T>;
}
