import { describe, it, expect } from "vitest";
import manifest from "../package.json";

describe("pi-deepseek-statusline manifest", () => {
  it("declares the @ultra-omp package name", () => {
    expect(manifest.name).toBe("@ultra-omp/pi-deepseek-statusline");
  });
});
