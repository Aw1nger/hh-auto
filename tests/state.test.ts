import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import { SchedulerState } from "../src/state";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ["", ".tmp"]) {
      if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
    }
  }
});

describe("scheduler auto-apply pause", () => {
  it("persists captcha pause and resumes", () => {
    const path = `/tmp/hh-state-test-${Date.now()}.json`;
    paths.push(path);

    const state = new SchedulerState(path);
    state.setAutoApply(true);
    state.pauseAutoApply("captcha_failed");
    expect(state.autoApplyPaused).toBe(true);
    expect(state.autoApplyPausedReason).toBe("captcha_failed");

    const reloaded = new SchedulerState(path);
    expect(reloaded.autoApplyPaused).toBe(true);
    expect(reloaded.autoApply).toBe(true);

    reloaded.resumeAutoApply();
    expect(reloaded.autoApplyPaused).toBe(false);
    expect(reloaded.autoApply).toBe(true);

    const after = new SchedulerState(path);
    expect(after.autoApplyPaused).toBe(false);
    expect(after.autoApply).toBe(true);
  });

  it("manual toggle clears an automatic pause", () => {
    const path = `/tmp/hh-state-test-${Date.now()}-2.json`;
    paths.push(path);
    const state = new SchedulerState(path);
    state.pauseAutoApply("captcha_failed");
    state.setAutoApply(false);
    expect(state.autoApplyPaused).toBe(false);
    expect(state.autoApply).toBe(false);
  });
});
