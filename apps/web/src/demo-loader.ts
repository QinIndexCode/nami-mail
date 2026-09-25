// The demo dataset (~16 kB) is only read when the app runs with ?demo=1.
// Loading it through this indirection keeps it out of the initial bundle's
// import graph; the first demo request imports the chunk once and every
// later site reuses the settled promise or the resolved snapshot.
import type * as DemoModule from "./demo";

type Demo = typeof DemoModule;

let demoPromise: Promise<Demo> | undefined;
let demoResolved: Demo | null = null;

export function ensureDemoLoaded(): Promise<Demo> {
  demoPromise ??= import("./demo").then((module) => {
    demoResolved = module;
    return module;
  });
  return demoPromise;
}

export function demoDataSnapshot(): Demo | null {
  return demoResolved;
}