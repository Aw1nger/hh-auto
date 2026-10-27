import { describe, expect, it } from "bun:test";

import { classifyApplyResponse } from "../src/hh/oauth";

describe("hh apply response classification", () => {
  it("treats 2xx as success", () => {
    expect(classifyApplyResponse(200, "").result).toBe(true);
    expect(classifyApplyResponse(201, "").result).toBe(true);
    expect(classifyApplyResponse(204, "").result).toBe(true);
  });

  it("detects captcha", () => {
    const body = JSON.stringify({
      errors: [
        {
          value: "captcha_required",
          captcha_url: "https://hh.ru/account/captcha?state=abc",
        },
      ],
    });
    const outcome = classifyApplyResponse(403, body);
    expect(outcome.error).toBe("captcha_failed");
    expect(outcome.captcha).toBe(true);
  });

  it("detects the daily limit", () => {
    const outcome = classifyApplyResponse(
      400,
      JSON.stringify({ errors: [{ value: "limit_exceeded" }] }),
    );
    expect(outcome.error).toBe("daily_limit");
  });

  it("detects already applied", () => {
    expect(
      classifyApplyResponse(400, JSON.stringify({ errors: [{ value: "already_applied" }] })).result,
    ).toBe("already");
  });

  it("detects a required test", () => {
    expect(
      classifyApplyResponse(403, JSON.stringify({ errors: [{ value: "test_required" }] })).error,
    ).toBe("needs_test");
  });

  it("treats 404 as already", () => {
    expect(classifyApplyResponse(404, "").result).toBe("already");
  });

  it("treats 401 as expired auth", () => {
    expect(classifyApplyResponse(401, "").error).toBe("auth_expired");
  });

  it("treats application_denied as already", () => {
    expect(
      classifyApplyResponse(
        403,
        JSON.stringify({ errors: [{ value: "application_denied" }] }),
      ).result,
    ).toBe("already");
  });

  it("reports server errors", () => {
    expect(classifyApplyResponse(502, "bad gateway").error).toBe("server_error_502");
  });
});
