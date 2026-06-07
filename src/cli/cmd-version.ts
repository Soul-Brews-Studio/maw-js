import { getRuntimeVersionString } from "../core/runtime/build-info";

export function getVersionString(): string {
  return getRuntimeVersionString();
}
