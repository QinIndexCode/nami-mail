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
    // Without this call the fixture byte-source would be enabled by a module
    // level side effect in demo.ts — which a static importer (CalendarDialog's
    // `demoTranslate`) would trigger even in real mode, hijacking every preview.
    // Registering here, on the demo-only dynamic-import path, keeps the proxy
    // equal to demo mode exactly.
    module.registerDemoAttachmentProvider();
    return module;
  });
  return demoPromise;
}

export function demoDataSnapshot(): Demo | null {
  return demoResolved;
}