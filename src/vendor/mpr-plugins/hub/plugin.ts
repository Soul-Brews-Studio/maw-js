import { definePlugin } from "maw-js/sdk";

const plugin = {
  name: "hub",
  version: "1.0.0",
  entry: "./index.ts",
  sdk: "^1.0.0",
  tier: "core",
  description: "Workspace hub transport for routing messages through configured hub workspaces.",
  author: "Soul-Brews-Studio",
  hooks: {
    transport: {
      script: "./index.ts",
      handler: "transport",
      ensures: ["transport:workspace-hub"],
      policy: "best-effort",
    },
  },
  module: {
    path: "./index.ts",
    exports: ["transport", "createHubTransport", "HubTransport", "loadWorkspaceConfigs"],
  },
  capabilities: ["transport:workspace-hub"],
  capabilityNamespaces: ["transport"],
  handler: async () => ({ ok: true, output: "hub transport plugin" }),
};

export default definePlugin(plugin);
