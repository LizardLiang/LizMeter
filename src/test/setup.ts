import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";

// Testing Library's 1000ms default is too tight for this suite. Pages are loaded with
// React.lazy, so a `waitFor` on a page appearing has to cover a dynamic import, and under
// full-suite load that import competes with every other worker. The result was
// TomatoClock's navigation tests failing on a different random subset each run while
// passing 85/85 in isolation.
//
// This raises only the async-utility ceiling: a test that genuinely never resolves still
// fails, just later. It does not make any assertion more lenient.
configure({ asyncUtilTimeout: 5000 });
