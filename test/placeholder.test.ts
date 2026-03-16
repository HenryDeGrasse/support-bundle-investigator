import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index";

describe("project", () => {
  it("exports a version string", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
