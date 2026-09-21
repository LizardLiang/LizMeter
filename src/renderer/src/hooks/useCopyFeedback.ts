// src/renderer/src/hooks/useCopyFeedback.ts
// Shared timer machinery behind a "Copied ✓" (or "Copy failed") label that reverts on its own.
// Extracted out of TodoRowMenu and TodoDetailPage, which each carried a byte-identical copy of
// this state + ref + unmount-cleanup effect. 476f49a fixed two bugs in exactly that duplicated
// code: a stale timer left armed by an earlier copy that fires late and acts on whatever is on
// screen by then, and a clipboard write that resolves after unmount touching state or arming a
// timer on a dead component. Both guards live here now, once, so a future call site cannot lose
// them the way the two duplicates nearly did.
//
// What is deliberately NOT folded in here, because it differs per call site:
// - what happens when the feedback window expires naturally (`onExpire` -- the row menu closes,
//   the detail page's overflow menu stays open and only reverts its label);
// - how the caller gathers the data to copy (this hook only owns showing the result of the copy).

import { useCallback, useEffect, useRef, useState } from "react";

/** "Copied ✓" (or "Copy failed") shows for this long before it reverts. Both call sites this was
 * extracted from used this same value under their own, separately duplicated constant. */
export const DEFAULT_COPY_FEEDBACK_MS = 1200;

export type CopyFeedbackStatus = "copied" | "failed";

export interface CopyFeedbackState<TAction extends string> {
  action: TAction;
  status: CopyFeedbackStatus;
}

export interface UseCopyFeedbackResult<TAction extends string> {
  /** The action currently showing feedback, and whether it succeeded -- `null` when nothing is. */
  feedback: CopyFeedbackState<TAction> | null;
  /** Arms feedback for `action`. Clears any timer still running from a previous call before
   * arming this one -- skipping that would leave the previous timer unreachable but still alive,
   * so it fires late and (through `onExpire`) acts on whatever is on screen by then (476f49a). */
  trigger: (action: TAction, status?: CopyFeedbackStatus) => void;
}

/**
 * `onExpire` runs once the feedback window elapses on its own -- never on unmount, and never when
 * a later `trigger` call cleared this timer first. `durationMs` defaults to
 * `DEFAULT_COPY_FEEDBACK_MS`.
 */
export function useCopyFeedback<TAction extends string>(
  onExpire?: () => void,
  durationMs: number = DEFAULT_COPY_FEEDBACK_MS,
): UseCopyFeedbackResult<TAction> {
  const [feedback, setFeedback] = useState<CopyFeedbackState<TAction> | null>(null);
  const timeoutRef = useRef<number | null>(null);
  /** Flipped false by the unmount cleanup below so a copy chain that resolves after this
   * component is gone (Escape / outside click / navigating away while
   * `navigator.clipboard.writeText` or an IPC call was still pending) can tell it is too late to
   * touch state or arm a timer. */
  const aliveRef = useRef(true);
  const onExpireRef = useRef(onExpire);
  // Refs are read outside render (in `trigger`'s timer callback), so syncing this one is deferred
  // to an effect rather than done inline during render -- matching `RichTextInput.tsx`'s
  // `onChangeRef` and `useStopwatch.ts`'s `onSavedRef`.
  useEffect(() => {
    onExpireRef.current = onExpire;
  });

  useEffect(() => {
    return () => {
      aliveRef.current = false;
      // A stale timer must never touch state -- or call `onExpire` -- once this is gone.
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const trigger = useCallback((action: TAction, status: CopyFeedbackStatus = "copied") => {
    // Checked on entry (here) *and* again inside the timer callback below -- the work leading to
    // a `trigger` call is always async, so either point may run after unmount.
    if (!aliveRef.current) return;
    setFeedback({ action, status });
    // Clear any timer still armed from a previous call before replacing the ref, or that first
    // timer becomes unreachable and fires late.
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      if (!aliveRef.current) return;
      setFeedback(null);
      onExpireRef.current?.();
    }, durationMs);
  }, [durationMs]);

  return { feedback, trigger };
}

/**
 * The label a "Copy ..." menu item should render: its normal label, or the feedback label when
 * `feedback` belongs to this `action`. Pulled out of the two call sites alongside the hook since
 * both rendered this exact same swap.
 */
export function copyFeedbackLabel<TAction extends string>(
  feedback: CopyFeedbackState<TAction> | null,
  action: TAction,
  normalLabel: string,
): string {
  if (feedback === null || feedback.action !== action) return normalLabel;
  return feedback.status === "failed" ? "Copy failed" : "Copied ✓";
}
