import { useEffect, useState } from "react";

/**
 * Keeps a conditionally rendered panel mounted long enough to run its exit
 * transition: closing sets visible=false (the CSS fades/slides out) and only
 * then unmounts the node.
 */
export function useMountedVisible(open: boolean, duration = 240): { mounted: boolean; visible: boolean } {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Double rAF: the element must paint its closed state once before the
      // .show class lands, otherwise the browser batches both DOM updates into
      // a single frame and the opening transition never runs.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(first);
        if (second !== 0) cancelAnimationFrame(second);
      };
    }
    setVisible(false);
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : duration);
    return () => window.clearTimeout(timer);
  }, [open, duration]);
  return { mounted, visible };
}
