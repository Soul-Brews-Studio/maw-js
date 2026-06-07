import { Elysia } from "elysia";

export function createTriggersApi() {
  return new Elysia();
}

export const triggersApi = createTriggersApi();
