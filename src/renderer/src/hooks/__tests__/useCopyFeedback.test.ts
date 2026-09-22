// useCopyFeedback hook tests
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFeedbackIsFailed, copyFeedbackLabel, useCopyFeedback } from "../useCopyFeedback.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("useCopyFeedback", () => {
  it("starts with no feedback armed", () => {
    const { result } = renderHook(() => useCopyFeedback<"id" | "prompt">());
    expect(result.current.feedback).toBeNull();
  });

  it("trigger arms feedback with a \"copied\" status by default", () => {
    const { result } = renderHook(() => useCopyFeedback<"id" | "prompt">());
    act(() => result.current.trigger("id"));
    expect(result.current.feedback).toEqual({ action: "id", status: "copied" });
  });

  it("trigger can arm a \"failed\" status", () => {
    const { result } = renderHook(() => useCopyFeedback<"id" | "prompt">());
    act(() => result.current.trigger("prompt", "failed"));
    expect(result.current.feedback).toEqual({ action: "prompt", status: "failed" });
  });

  it("reverts to no feedback on its own after the default duration and calls onExpire", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useCopyFeedback<"id" | "prompt">(onExpire));

    act(() => result.current.trigger("id"));
    expect(result.current.feedback).not.toBeNull();

    act(() => vi.advanceTimersByTime(1200));
    expect(result.current.feedback).toBeNull();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("honors a custom duration instead of the 1200ms default", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useCopyFeedback<"id" | "prompt">(onExpire, 400));

    act(() => result.current.trigger("id"));
    act(() => vi.advanceTimersByTime(399));
    expect(result.current.feedback).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.feedback).toBeNull();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it(
    "clears a timer still armed from a previous trigger before arming the next, so only the later call's timer fires",
    () => {
      vi.useFakeTimers();
      const onExpire = vi.fn();
      const { result } = renderHook(() => useCopyFeedback<"id" | "prompt">(onExpire));

      act(() => result.current.trigger("id"));
      act(() => vi.advanceTimersByTime(600));
      act(() => result.current.trigger("prompt"));

      // 1200ms after the FIRST trigger -- the stale timer's original deadline. With the bug this
      // fires here and calls `onExpire` early, one full 600ms before the second trigger is due.
      act(() => vi.advanceTimersByTime(600));
      expect(result.current.feedback).toEqual({ action: "prompt", status: "copied" });
      expect(onExpire).not.toHaveBeenCalled();

      // 1200ms after the SECOND trigger -- the surviving timer's real deadline.
      act(() => vi.advanceTimersByTime(600));
      expect(result.current.feedback).toBeNull();
      expect(onExpire).toHaveBeenCalledTimes(1);
    },
  );

  it("does not call onExpire when unmounted before the timer elapses", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result, unmount } = renderHook(() => useCopyFeedback<"id" | "prompt">(onExpire));

    act(() => result.current.trigger("id"));
    unmount();
    act(() => vi.advanceTimersByTime(1200));
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("a trigger call that resolves after unmount does not throw and leaves no feedback armed", () => {
    const { result, unmount } = renderHook(() => useCopyFeedback<"id" | "prompt">());
    unmount();
    expect(() => act(() => result.current.trigger("id"))).not.toThrow();
    expect(result.current.feedback).toBeNull();
  });

  it(
    "still produces feedback after StrictMode's dev-only double-invoke (mount, cleanup, mount) -- aliveRef must be re-armed on setup, not just initialized once (regression, bun run dev)",
    () => {
      // Mounting under <StrictMode> is what makes React 18 run this hook's cleanup effect once
      // (setup -> cleanup -> setup) before anything ever calls `trigger`. Without re-arming
      // `aliveRef` in the effect's setup body, that first cleanup leaves it permanently false, so
      // `trigger`'s entry guard bails forever -- exactly what happened in `bun run dev` (StrictMode
      // is on there; RTL does not wrap in StrictMode by default, which is why no existing test
      // caught this).
      const { result } = renderHook(() => useCopyFeedback<"id" | "prompt">(), { wrapper: StrictMode });

      act(() => result.current.trigger("id"));

      expect(result.current.feedback).toEqual({ action: "id", status: "copied" });
    },
  );
});

describe("copyFeedbackLabel", () => {
  it("returns the normal label when there is no feedback armed", () => {
    expect(copyFeedbackLabel<"id" | "prompt">(null, "id", "Copy id")).toBe("Copy id");
  });

  it("returns the normal label when the armed feedback belongs to a different action", () => {
    expect(copyFeedbackLabel({ action: "prompt", status: "copied" }, "id", "Copy id")).toBe("Copy id");
  });

  it("returns \"Copied ✓\" when feedback matches the action with a \"copied\" status", () => {
    expect(copyFeedbackLabel({ action: "id", status: "copied" }, "id", "Copy id")).toBe("Copied ✓");
  });

  it("returns \"Copy failed\" when feedback matches the action with a \"failed\" status", () => {
    expect(copyFeedbackLabel({ action: "id", status: "failed" }, "id", "Copy id")).toBe("Copy failed");
  });
});

describe("copyFeedbackIsFailed", () => {
  it("returns false when there is no feedback armed", () => {
    expect(copyFeedbackIsFailed<"id" | "prompt">(null, "id")).toBe(false);
  });

  it("returns false when the armed feedback belongs to a different action", () => {
    expect(copyFeedbackIsFailed({ action: "prompt", status: "failed" }, "id")).toBe(false);
  });

  it("returns false when the matching feedback succeeded", () => {
    expect(copyFeedbackIsFailed({ action: "id", status: "copied" }, "id")).toBe(false);
  });

  it("returns true when the matching feedback failed", () => {
    expect(copyFeedbackIsFailed({ action: "id", status: "failed" }, "id")).toBe(true);
  });
});
