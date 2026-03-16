// electron/main/music/music-error.ts
// Typed error class for all music-related errors (v2.0 -- MAJOR-04)
// Follows the existing IssueProviderError pattern in electron/main/issue-providers/types.ts

import type { MusicErrorCode } from "../../../src/shared/types.ts";

export class MusicError extends Error {
  constructor(
    message: string,
    public readonly code: MusicErrorCode,
  ) {
    super(message);
    this.name = "MusicError";
  }
}
