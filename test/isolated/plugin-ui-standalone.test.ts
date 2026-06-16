import { describe, test } from "bun:test";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

describe("ui plugin standalone boundary", () => {
  test("keeps declared config/xdg exceptions explicit", () => {
    expectStandalonePluginBoundary({
      plugin: "ui",
      requireSdk: false,
      allowMawJs: ["maw-js/config", "maw-js/core/ghq"],
      allowRelative: [/^\.\.\/\.\.\/\.\.\/core\/xdg$/],
    });
  });
});
