// O-01 — every deployed function reports unexpected errors to Sentry.
//
// Sentry's automatic Firebase integration doesn't cover firebase-functions 7,
// so each export wraps its handler in a withSentry* helper. This pins that in
// the source: every onCall / onDocument* / onSchedule / onRequest export must
// pass its own name to a wrapper, and the scan must find exactly the functions
// src/index.ts deploys, so a new function can't ship without reporting.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "../callables/_setup";
import * as deployedModule from "../../src/index";

const SRC = path.resolve(process.cwd(), "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

const TRIGGER =
  /export const (\w+) = (onCall|onDocumentCreated|onDocumentUpdated|onDocumentWritten|onDocumentDeleted|onSchedule|onRequest)(?:<[^>(]*>)?\(/g;

// The trigger call from its opening parenthesis to the matching close.
function callText(source: string, matchIndex: number): string {
  let depth = 0;
  for (let i = source.indexOf("(", matchIndex); i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) {
      return source.slice(matchIndex, i + 1);
    }
  }
  return source.slice(matchIndex);
}

const found = tsFiles(SRC).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(TRIGGER)].map((m) => ({
    name: m[1],
    file: path.relative(SRC, file),
    text: callText(source, m.index ?? 0),
  }));
});

const deployed = Object.entries(deployedModule)
  .filter(([, value]) => typeof value === "function" && "__endpoint" in (value as object))
  .map(([name]) => name)
  .sort();

describe("Sentry coverage (O-01)", () => {
  it("the source scan finds exactly the functions index.ts deploys", () => {
    expect(found.map((f) => f.name).sort()).toEqual(deployed);
  });

  for (const fn of found) {
    it(`${fn.name} (${fn.file}) reports errors through withSentry`, () => {
      expect(fn.text).toMatch(
        new RegExp(`withSentry(Callable|Event|Request)\\(\\s*"${fn.name}"`),
      );
    });
  }
});
