import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { validateBody } from "../../src/lib/validate";

function makeContext(jsonImpl: () => unknown | Promise<unknown>) {
  const setCalls: Array<[string, unknown]> = [];
  const jsonCalls: Array<[unknown, number | undefined]> = [];

  return {
    context: {
      req: {
        json: jsonImpl,
      },
      set: (key: string, value: unknown) => {
        setCalls.push([key, value]);
      },
      json: (payload: unknown, status?: number) => {
        jsonCalls.push([payload, status]);
        return { payload, status };
      },
    },
    setCalls,
    jsonCalls,
  };
}

describe("validateBody middleware coverage", () => {
  const schema = Type.Object({
    name: Type.String(),
    count: Type.Optional(Type.Number()),
  });

  test("stores valid JSON bodies and awaits the downstream middleware", async () => {
    const body = { name: "oracle", count: 2 };
    const { context, setCalls, jsonCalls } = makeContext(() => body);
    let nextCalled = false;

    const result = await validateBody(schema)(context as any, async () => {
      nextCalled = true;
    });

    expect(result).toBeUndefined();
    expect(nextCalled).toBe(true);
    expect(setCalls).toEqual([["body", body]]);
    expect(jsonCalls).toEqual([]);
  });

  test("returns a 400 response when request JSON parsing fails", async () => {
    const { context, setCalls, jsonCalls } = makeContext(() => {
      throw new Error("not json");
    });
    let nextCalled = false;

    const result = await validateBody(schema)(context as any, async () => {
      nextCalled = true;
    });

    expect(result).toEqual({ payload: { error: "invalid JSON" }, status: 400 });
    expect(nextCalled).toBe(false);
    expect(setCalls).toEqual([]);
    expect(jsonCalls).toEqual([[{ error: "invalid JSON" }, 400]]);
  });

  test("returns TypeBox validation details for schema mismatches", async () => {
    const { context, setCalls, jsonCalls } = makeContext(() => ({ name: 42 }));
    let nextCalled = false;

    const result = await validateBody(schema)(context as any, async () => {
      nextCalled = true;
    });

    expect(result).toMatchObject({
      payload: {
        error: "validation failed",
        details: [
          {
            path: "/name",
          },
        ],
      },
      status: 400,
    });
    expect((result as any).payload.details[0].message).toBeString();
    expect(nextCalled).toBe(false);
    expect(setCalls).toEqual([]);
    expect(jsonCalls).toHaveLength(1);
  });
});
