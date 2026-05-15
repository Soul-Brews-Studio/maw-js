import { describe, expect, test } from "bun:test";
import { getLiveTileRoles } from "../../src/commands/shared/wake-cmd";

describe("getLiveTileRoles (#1445)", () => {
  test("returns non-empty @maw_tile_role values from list-panes output", async () => {
    const roles = await getLiveTileRoles("47-mawjs", {
      hostExecFn: async () => "tile-1\n\n tile-2 \n\n",
    });

    expect(Array.from(roles).sort()).toEqual(["tile-1", "tile-2"]);
  });

  test("returns empty set when tmux list-panes fails", async () => {
    const roles = await getLiveTileRoles("47-mawjs", {
      hostExecFn: async () => {
        throw new Error("can't find session");
      },
    });

    expect(roles.size).toBe(0);
  });
});
