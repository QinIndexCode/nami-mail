import { useCallback, useEffect, useRef } from "react";
import { readDemoPresentation } from "../demoPresentation";

/**
 * Splash-screen lifecycle: the splash dismisses once the 2s brand animation
 * (~2s) AND both the mail data load and agent bootstrap preload finish.
 * The data-load and agent-preload effects report into the exposed refs and
 * call `dismissSplash` when their part settles.
 */
export interface SplashDismiss {
  dismissSplash: () => void;
  splashAnimationDoneRef: React.RefObject<boolean> & { current: boolean };
  splashDataDoneRef: React.RefObject<boolean> & { current: boolean };
  splashAgentDoneRef: React.RefObject<boolean> & { current: boolean };
  splashDismissedRef: React.RefObject<boolean> & { current: boolean };
}

export function useSplashDismiss(): SplashDismiss {
  const splashAnimationDoneRef = useRef(false);
  const splashDataDoneRef = useRef(false);
  const splashAgentDoneRef = useRef(false);
  const splashDismissedRef = useRef(false);

  const dismissSplash = useCallback(() => {
    if (splashDismissedRef.current) return;
    if (!splashAnimationDoneRef.current || !splashDataDoneRef.current || !splashAgentDoneRef.current) return;
    splashDismissedRef.current = true;
    console.log("[nami-startup] renderer-splash-dismissed");
    const el = document.getElementById("nami-splash");
    if (el) {
      el.classList.add("done");
      setTimeout(() => el.remove(), 600);
    }
  }, []);

  useEffect(() => {
    // The website already has a branded loading placeholder. Start its client
    // as soon as sample data is ready, keeping the install's startup unchanged.
    const animationDelay = readDemoPresentation(window.location.search) ? 0 : 2000;
    const timer = setTimeout(() => {
      splashAnimationDoneRef.current = true;
      console.log(animationDelay === 0 ? "[nami-startup] renderer-splash-animation-done(site-preview)" : "[nami-startup] renderer-splash-animation-done(2s)");
      // If data or agent is still loading, show the loading bar
      if (!splashDataDoneRef.current || !splashAgentDoneRef.current) {
        const loader = document.querySelector(".nami-splash-loader");
        if (loader) loader.classList.add("visible");
      }
      dismissSplash();
    }, animationDelay);
    return () => clearTimeout(timer);
  }, [dismissSplash]);

  return {
    dismissSplash,
    splashAnimationDoneRef,
    splashDataDoneRef,
    splashAgentDoneRef,
    splashDismissedRef,
  };
}
