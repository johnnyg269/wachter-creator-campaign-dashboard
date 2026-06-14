"use client";

// Input clear with dissolve — transitions.dev pattern #13 (skills/13-input-
// clear-dissolve.md), adapted. The original needs per-frame JS + a per-word
// canvas "glow streak" + placeholder-fall — too flashy for an executive
// dashboard, so those are intentionally omitted (documented). What's kept,
// using the EXACT --clear-out-* timing/easing/fly/blur: the value clears
// INSTANTLY (so the search filter updates with no fake delay) while the old
// text dissolves out via a mirror overlay (translateY + blur + fade). The clear
// (×) button is present only when the field has text and fades in smoothly.
// The .t-clear* classes + reduced-motion guard live in globals.css.

import { useRef } from "react";
import clsx from "clsx";
import { X } from "lucide-react";

const CLEAR_OUT_MS = 400; // matches --clear-out-dur

export function ClearableInput({
  value,
  onChange,
  onClear,
  leftIcon,
  inputClassName,
  mirrorClassName,
  wrapperClassName,
  clearLabel = "Clear search",
  ...inputProps
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  leftIcon?: React.ReactNode;
  inputClassName?: string;
  /** Match the input's horizontal padding so the dissolving text aligns. */
  mirrorClassName?: string;
  wrapperClassName?: string;
  clearLabel?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  function dissolve(old: string) {
    const mirror = mirrorRef.current;
    if (!mirror || !old) return;
    mirror.textContent = old.replace(/ /g, " ");
    mirror.classList.add("is-active");
    void mirror.offsetWidth; // resting frame, then transition out
    mirror.classList.add("is-dissolving");
    window.setTimeout(() => {
      mirror.classList.remove("is-active", "is-dissolving");
      mirror.textContent = "";
    }, CLEAR_OUT_MS);
  }

  function handleClear() {
    const old = value;
    onClear(); // clears the controlled value now — filter updates immediately
    dissolve(old); // the old text dissolves over the (now empty) field
    inputRef.current?.focus();
  }

  return (
    <div className={clsx("t-clear", value.length > 0 && "has-value", wrapperClassName)}>
      {leftIcon}
      <input
        ref={inputRef}
        value={value}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            handleClear();
          }
        }}
        className={inputClassName}
        {...inputProps}
      />
      <div ref={mirrorRef} className={clsx("t-clear-mirror", mirrorClassName)} aria-hidden="true" />
      <button
        type="button"
        onClick={handleClear}
        aria-label={clearLabel}
        tabIndex={value.length > 0 ? 0 : -1}
        className="t-clear-btn absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-strong hover:text-foreground"
      >
        <X size={13} />
      </button>
    </div>
  );
}
