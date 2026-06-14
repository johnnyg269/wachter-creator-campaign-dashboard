"use client";

// Texts reveal — transitions.dev pattern #18 (skills/18-texts-reveal.md). Lines
// rise in with a staggered blur on mount (.is-shown added next frame, exactly
// like the snippet's showText()). Children must carry .t-stagger-line (and
// .t-stagger-line--2/--3 for stagger). The .t-stagger classes + reduced-motion
// guard live in globals.css verbatim. Used sparingly on section/page-entrance
// text — never long paragraphs, never the report slide canvas (screenshot
// stability), never slot-text AnimatedText.

import { useEffect, useState } from "react";
import clsx from "clsx";

export function TextReveal({
  children,
  className,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "span";
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <Tag className={clsx("t-stagger", shown && "is-shown", className)}>{children}</Tag>
  );
}
