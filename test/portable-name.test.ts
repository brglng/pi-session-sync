/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalPortableSessionDirName,
  decodePortableSessionDirName,
  defaultSessionDirName,
  foldPortablePrefixesForFingerprint,
  normalizePortableNameOptions,
  portableNameOptionsFingerprint,
  portableSessionDirName,
  portableSessionDirNameFromPath,
  RESERVED_STATE_FILE_NAME,
  toPosixAbsolute,
} from "../src/portable-name.ts";

describe("portable session names", () => {
  it("uses HOME for paths below home", () => {
    const cwd = join(homedir(), "projects", "demo");
    const name = portableSessionDirName(cwd);
    expect(name).toBe("HOME%2Fprojects%2Fdemo");
    expect(decodePortableSessionDirName(name)?.cwd).toBe(cwd);
  });

  it("uses ROOT for paths outside home", () => {
    if (process.platform === "win32") return;
    const name = portableSessionDirName("/var/www");
    expect(name).toBe("ROOT%2Fvar%2Fwww");
    expect(decodePortableSessionDirName(name)?.cwd).toBe("/var/www");
  });

  it("round-trips literal POSIX backslashes in cwd names", () => {
    if (process.platform === "win32") return;
    const cwd = "/tmp/pi-session-sync-literal\\cwd";
    const name = portableSessionDirName(cwd);
    expect(name).toBe("ROOT%2Ftmp%2Fpi-session-sync-literal%5Ccwd");
    expect(decodePortableSessionDirName(name)?.cwd).toBe(cwd);
  });

  it("strictly encodes basename-invalid remainder characters that encodeURIComponent leaves", () => {
    if (process.platform === "win32") return;
    // `*` is invalid in Windows basenames and a terminal dot is stripped by
    // Windows, so both must be percent-encoded in portable names.
    const starName = portableSessionDirName("/tmp/a*b");
    expect(starName).toBe("ROOT%2Ftmp%2Fa%2Ab");
    expect(starName.includes("*")).toBe(false);
    expect(decodePortableSessionDirName(starName)?.cwd).toBe("/tmp/a*b");

    const dotName = portableSessionDirName("/tmp/a.");
    expect(dotName).toBe("ROOT%2Ftmp%2Fa%2E");
    expect(dotName.endsWith(".")).toBe(false);
    expect(decodePortableSessionDirName(dotName)?.cwd).toBe("/tmp/a.");

    // Every dot of a terminal run must be encoded; interior dots stay literal.
    const dotsName = portableSessionDirName("/tmp/a..");
    expect(dotsName).toBe("ROOT%2Ftmp%2Fa%2E%2E");
    expect(decodePortableSessionDirName(dotsName)?.cwd).toBe("/tmp/a..");
    const interiorName = portableSessionDirName("/tmp/a.b");
    expect(interiorName).toBe("ROOT%2Ftmp%2Fa.b");
    expect(decodePortableSessionDirName(interiorName)?.cwd).toBe("/tmp/a.b");
  });

  it("still decodes legacy loose encodeURIComponent spellings", () => {
    if (process.platform === "win32") return;
    // Older target trees were written with plain encodeURIComponent, which
    // leaves `*` and terminal dots literal; those names keep decoding.
    expect(decodePortableSessionDirName("ROOT%2Ftmp%2Fa*b")?.cwd).toBe("/tmp/a*b");
    expect(decodePortableSessionDirName("ROOT%2Ftmp%2Fa.")?.cwd).toBe("/tmp/a.");
  });

  it("decodes ROOT names that happen to be under current home", () => {
    const cwd = join(homedir(), "root-labeled-project");
    const rootName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    expect(portableSessionDirName(cwd)).toBe(`HOME%2Froot-labeled-project`);
    expect(decodePortableSessionDirName(rootName)?.cwd).toBe(cwd);
  });

  it("returns native Windows separators from decoded cwd on win32", () => {
    if (process.platform !== "win32") return;
    const options = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "C:/work": "WIN", "//server/share": "UNC" },
    };
    // Drive paths, extra prefixes, and UNC shares all decode to the native
    // path.join spelling; portable-name internals keep the POSIX
    // representation for encoding and hashing.
    expect(decodePortableSessionDirName("ROOTD%3A%2Frepo", options)?.cwd).toBe("D:\\repo");
    expect(decodePortableSessionDirName("WIN%2Fproject", options)?.cwd).toBe("C:\\work\\project");
    expect(decodePortableSessionDirName("UNC%2Fproject", options)?.cwd).toBe(
      "\\\\server\\share\\project",
    );
    expect(decodePortableSessionDirName("ROOTD%3A%2Frepo", options)?.cwd).toBe(
      win32.join("D:", "repo"),
    );
    // Round trip through the portable encoding stays stable.
    expect(portableSessionDirName("C:\\work\\project", options)).toBe("WIN%2Fproject");
  });

  it("rejects malformed or non-canonical names", () => {
    expect(decodePortableSessionDirName("unknown%2Fpath")).toBeNull();
    expect(decodePortableSessionDirName("HOME%ZZ")).toBeNull();
    expect(decodePortableSessionDirName("HOME%2F..%2Foutside")).toBeNull();
    expect(decodePortableSessionDirName("ROOT%2Ftmp%2Fbad%00cwd")).toBeNull();
    expect(decodePortableSessionDirName("ROOT%2Ftmp%2Fbad%01cwd")).toBeNull();
  });

  it("folds only native Windows CWD case in portable identities", () => {
    if (process.platform !== "win32") {
      const name = "ROOT%2Ftmp%2FProject";
      expect(canonicalPortableSessionDirName(name)).toBe(name);
      return;
    }
    const upper = portableSessionDirNameFromPath("C:/Users/Alice/Project", "C:/Users/Alice");
    const lower = portableSessionDirNameFromPath("c:/users/alice/project", "C:/Users/Alice");
    expect(canonicalPortableSessionDirName(upper)).toBe(canonicalPortableSessionDirName(lower));
    const root = portableSessionDirNameFromPath("C:/Users/Alice/Project", "D:/Users/Alice");
    const lowerRoot = portableSessionDirNameFromPath("c:/users/alice/project", "D:/Users/Alice");
    expect(canonicalPortableSessionDirName(root)).toBe(canonicalPortableSessionDirName(lowerRoot));
    expect(canonicalPortableSessionDirName(upper) === canonicalPortableSessionDirName(root)).toBe(
      false,
    );
  });

  it("keeps Windows drive letters in ROOT names", () => {
    expect(portableSessionDirNameFromPath("D:/repo", "C:/Users/alice")).toBe("ROOTD%3A%2Frepo");
    if (process.platform === "win32") {
      expect(decodePortableSessionDirName("ROOTD%3A%2Frepo")?.cwd).toBe("D:\\repo");
    } else {
      expect(decodePortableSessionDirName("ROOTD%3A%2Frepo")).toBeNull();
    }
  });

  it("canonicalizes only native Windows case in the naming-config fingerprint", () => {
    const upper = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "C:/work": "WIN", "C:/work2": "WIN2" },
    };
    const lower = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "c:/work": "WIN", "c:/work2": "WIN2" },
    };
    const differentLabel = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "c:/work": "WIN2", "c:/work2": "WIN" },
    };
    if (process.platform === "win32") {
      // Case-only prefix spelling shares one fingerprint while label
      // semantics stay distinct. Decoding returns the configured spelling.
      expect(portableNameOptionsFingerprint(upper) === portableNameOptionsFingerprint(lower)).toBe(
        true,
      );
      expect(
        portableNameOptionsFingerprint(upper) === portableNameOptionsFingerprint(differentLabel),
      ).toBe(false);
      expect(decodePortableSessionDirName("WIN%2Fproject", upper)?.cwd).toBe("C:\\work\\project");
      expect(decodePortableSessionDirName("WIN%2Fproject", lower)?.cwd).toBe("c:\\work\\project");
      expect(normalizePortableNameOptions(upper).extraPrefixes).toEqual({
        "C:/work": "WIN",
        "C:/work2": "WIN2",
      });
    } else {
      // POSIX paths remain case-sensitive in the fingerprint; Windows-shaped
      // keys are foreign there and never decode to native paths.
      expect(portableNameOptionsFingerprint(upper) === portableNameOptionsFingerprint(lower)).toBe(
        false,
      );
      expect(normalizePortableNameOptions(upper).extraPrefixes).toEqual({
        "C:/work": "WIN",
        "C:/work2": "WIN2",
      });
      expect(decodePortableSessionDirName("WIN%2Fproject", upper)).toBeNull();
    }
  });

  it("folds extra-prefix keys before sorting in the fingerprint", () => {
    // Folded keys sort differently from the configured spellings: folding
    // must happen before sorting so case-only spellings and insertion orders
    // fingerprint identically while labels stay distinct.
    const crossed = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "C:/Zoo": "Z", "C:/apple": "A" },
    };
    const crossedOtherSpelling = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "c:/apple": "A", "C:/ZOO": "Z" },
    };
    const folded = foldPortablePrefixesForFingerprint(crossed.extraPrefixes);
    const foldedOther = foldPortablePrefixesForFingerprint(crossedOtherSpelling.extraPrefixes);
    expect(Object.keys(folded)).toEqual(["c:/apple", "c:/zoo"]);
    expect(folded).toEqual(foldedOther);
    expect(JSON.stringify(folded)).toBe(JSON.stringify(foldedOther));
    if (process.platform === "win32") {
      expect(portableNameOptionsFingerprint(crossed)).toBe(
        portableNameOptionsFingerprint(crossedOtherSpelling),
      );
      const relabeled = {
        homeLabel: "HOME",
        rootLabel: "ROOT",
        extraPrefixes: { "c:/apple": "Z", "c:/zoo": "A" },
      };
      expect(
        portableNameOptionsFingerprint(crossed) === portableNameOptionsFingerprint(relabeled),
      ).toBe(false);
      // Decoding still returns the configured prefix spelling.
      expect(decodePortableSessionDirName("Z%2Fx", crossed)?.cwd).toBe("C:\\Zoo\\x");
      expect(decodePortableSessionDirName("Z%2Fx", crossedOtherSpelling)?.cwd).toBe("c:\\zoo\\x");
    }
  });

  it("falls back from an overlapping label when drive-root remainder is invalid", () => {
    const options = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "D:/": "ROOTD" },
    };
    if (process.platform === "win32") {
      expect(decodePortableSessionDirName("ROOTD%3A%2Frepo", options)).toEqual({
        name: "ROOTD%3A%2Frepo",
        cwd: "D:\\repo",
      });
    } else {
      expect(decodePortableSessionDirName("ROOTD%3A%2Frepo", options)).toBeNull();
    }
  });

  it("rejects foreign Windows-shaped extra-prefix names on POSIX", () => {
    const options = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: {
        "C:/work": "WIN",
        "//server/share": "UNC",
      },
    };
    if (process.platform === "win32") {
      expect(decodePortableSessionDirName("WIN%2Fproject", options)?.cwd).toBe("C:\\work\\project");
      expect(decodePortableSessionDirName("UNC%2Fproject", options)?.cwd).toBe(
        "\\\\server\\share\\project",
      );
    } else {
      expect(decodePortableSessionDirName("WIN%2Fproject", options)).toBeNull();
      expect(decodePortableSessionDirName("UNC%2Fproject", options)).toBeNull();
    }
  });

  it("keeps POSIX backslashes literal when matching extra-prefix boundaries", () => {
    if (process.platform === "win32") return;
    const options = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "/tmp/pi-sync\\literal": "LITERAL" },
    };
    const child = "/tmp/pi-sync\\literal/child";
    const sibling = "/tmp/pi-sync\\literal-child";
    expect(portableSessionDirName(child, options)).toBe("LITERAL%2Fchild");
    expect(decodePortableSessionDirName("LITERAL%2Fchild", options)?.cwd).toBe(child);
    expect(portableSessionDirName(sibling, options)).toBe("ROOT%2Ftmp%2Fpi-sync%5Cliteral-child");
  });

  it("supports custom labels, longest prefixes, and segment boundaries", () => {
    if (process.platform === "win32") return;
    const options = {
      homeLabel: "USER",
      rootLabel: "SYSTEM",
      extraPrefixes: {
        "/tmp/work": "WORK",
        "/tmp/work/project": "PROJECT",
      },
    };
    expect(portableSessionDirName("/tmp/work/project/app", options)).toBe("PROJECT%2Fapp");
    expect(portableSessionDirName("/tmp/work/project-two/app", options)).toBe(
      "WORK%2Fproject-two%2Fapp",
    );
    expect(decodePortableSessionDirName("PROJECT%2Fapp", options)?.cwd).toBe(
      "/tmp/work/project/app",
    );
    expect(portableSessionDirNameFromPath("/home/test/project", "/home/test", options)).toBe(
      "USER%2Fproject",
    );
  });

  it("selects longest overlapping labels while rejecting ambiguous exact labels", () => {
    if (process.platform === "win32") return;
    const options = {
      homeLabel: "H",
      rootLabel: "R",
      extraPrefixes: { "/tmp/label": "HOME" },
    };
    expect(decodePortableSessionDirName("HOME%2Fchild", options)?.cwd).toBe("/tmp/label/child");
    expect(() =>
      normalizePortableNameOptions({
        homeLabel: "SAME",
        rootLabel: "ROOT",
        extraPrefixes: { "/tmp/a": "SAME" },
      }),
    ).toThrow(/Ambiguous portable label/);
  });

  it("rejects equal-length conflicting prefixes", () => {
    if (process.platform === "win32") return;
    expect(() =>
      portableSessionDirName("/tmp/work/x", {
        homeLabel: "H",
        rootLabel: "R",
        extraPrefixes: { "/tmp/work": "W", "/tmp/work/": "OTHER" },
      }),
    ).toThrow(/same normalized path/);
    expect(() =>
      normalizePortableNameOptions({
        homeLabel: "H",
        rootLabel: "R",
        extraPrefixes: { "/tmp/aa": "A", "/tmp/bb": "B" },
      }),
    ).toThrow(/equal length/);
  });

  it("allows explicit HOME and ROOT prefix overrides", () => {
    if (process.platform === "win32") return;
    const options = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: {
        [homedir()]: "USER",
        "/": "ABS",
      },
    };
    expect(portableSessionDirName(join(homedir(), "project"), options)).toBe("USER%2Fproject");
    expect(portableSessionDirName("/tmp/project", options)).toBe("ABS%2Ftmp%2Fproject");
    expect(decodePortableSessionDirName("USER%2Fproject", options)?.cwd).toBe(
      join(homedir(), "project"),
    );
    expect(decodePortableSessionDirName("ABS%2Ftmp%2Fproject", options)?.cwd).toBe("/tmp/project");
  });

  it("rejects unsafe configured labels but allows Unicode labels", () => {
    for (const label of [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "a%b",
      "a:b",
      "a?b",
      "a*b",
      'a"b',
      "a<b",
      "a>b",
      "a|b",
      "trailing.",
      "trailing ",
      "CON",
      "con.txt",
      "PRN",
      "AUX.log",
      "NUL",
      "COM1",
      "lpt9.txt",
      "a\u0000b",
      "a\u0001b",
    ]) {
      expect(() => normalizePortableNameOptions({ homeLabel: label, rootLabel: "ROOT" })).toThrow();
    }
    for (const label of [RESERVED_STATE_FILE_NAME, ".PI-SESSION-SYNC-STATE.JSON"]) {
      expect(() => normalizePortableNameOptions({ homeLabel: label, rootLabel: "ROOT" })).toThrow(
        /reserved/,
      );
    }
    expect(() =>
      normalizePortableNameOptions({
        homeLabel: "HOME",
        rootLabel: "ROOT",
        extraPrefixes: { [toPosixAbsolute(join(tmpdir(), "state"))]: RESERVED_STATE_FILE_NAME },
      }),
    ).toThrow(/reserved/);
    expect(normalizePortableNameOptions({ homeLabel: "工作区", rootLabel: "根" }).homeLabel).toBe(
      "工作区",
    );
  });

  it("matches Pi's default directory encoding", () => {
    if (process.platform === "win32") return;
    expect(defaultSessionDirName("/Users/alice/project")).toBe("--Users-alice-project--");
    expect(defaultSessionDirName("/tmp/a:b")).toBe("--tmp-a-b--");
  });
});
