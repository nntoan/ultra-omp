import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const expected = ["build.md", "code-simplify.md", "constraints.md", "ship.md", "spec.md", "test.md", "to-plan.md", "to-review.md", "webperf.md"];

test("OMP lifecycle command catalog is exact and described", async () => {
  const dir = join(import.meta.dir, "..", "commands");
  expect((await readdir(dir)).sort()).toEqual(expected);
  for (const name of expected) {
    const content = await Bun.file(join(dir, name)).text();
    expect(content).toMatch(/^---\s*\ndescription:\s*[^\n]+\s*\n---/);
  }
});
