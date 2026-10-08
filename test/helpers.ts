/**
 * Shared fixtures: a throwaway state root on disk so store and server tests exercise
 * the real file layout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _overrideRootDir } from "../src/store/paths.ts";
import { importExample, type ProblemBundle } from "../src/store/problems.ts";

export interface Fixture {
  root: string;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-test-"));
  _overrideRootDir(root);
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Copy the bundled example problem into the fixture root. */
export function seedExample(): ProblemBundle {
  return importExample("window-sum");
}
