import { describe, expect, it } from "vitest";
import { createSettingsLoadCoordinator } from "./settingsLoadCoordinator";

describe("settings load coordinator", () => {
  it("does not let an initial settings request overwrite a later saved change", () => {
    const coordinator = createSettingsLoadCoordinator();
    const initialLoad = coordinator.beginLoad();

    coordinator.recordSettingsChange();

    expect(coordinator.canApplyLoad(initialLoad)).toBe(false);
  });

  it("accepts only the latest unchanged settings request", () => {
    const coordinator = createSettingsLoadCoordinator();
    const firstLoad = coordinator.beginLoad();
    const secondLoad = coordinator.beginLoad();

    expect(coordinator.canApplyLoad(firstLoad)).toBe(false);
    expect(coordinator.canApplyLoad(secondLoad)).toBe(true);

    coordinator.recordSettingsChange();

    expect(coordinator.canApplyLoad(secondLoad)).toBe(false);
  });
});
