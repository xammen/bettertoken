/**
 * BetterToken patch manifest
 * Maps OpenCode versions to their patch files and git tags.
 * Add new entries when new OpenCode versions are released.
 */

export const SUPPORTED_VERSIONS: Record<string, { tag: string; patch: string }> = {
  "1.3.13": { tag: "v1.3.13", patch: "opencode-1.3.13.patch" },
  "1.3.14": { tag: "v1.3.14", patch: "opencode-1.3.13.patch" }, // Same prompt structure
  "1.3.15": { tag: "v1.3.15", patch: "opencode-1.3.13.patch" }, // Same prompt structure
}

export const LATEST_SUPPORTED = "1.3.13"

export function isSupported(version: string): boolean {
  return version in SUPPORTED_VERSIONS
}

export function resolve(version: string) {
  return SUPPORTED_VERSIONS[version]
}

export function printSupported(): string {
  return Object.keys(SUPPORTED_VERSIONS).join(", ")
}
