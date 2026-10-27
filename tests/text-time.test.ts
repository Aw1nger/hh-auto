import { describe, expect, it } from "bun:test";

import { renderLetter, formatSalary, escapeHtml, truncate } from "../src/utils/text";
import { getMoscowHour, startOfMoscowDayUtcIso } from "../src/utils/time";

describe("text helpers", () => {
  it("renders letter placeholders", () => {
    expect(renderLetter("Здравствуйте! Вакансия {vacancy} в {company}.", "Маркетолог", "ООО")).toBe(
      "Здравствуйте! Вакансия Маркетолог в ООО.",
    );
  });

  it("formats salary", () => {
    expect(formatSalary(150_000, 200_000, "RUB")).toContain("150");
    expect(formatSalary(null, 80_000, "RUB")).toContain("до");
    expect(formatSalary(null, null, "RUB")).toBe("");
  });

  it("escapes HTML", () => {
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  it("truncates long strings", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("moscow time", () => {
  it("computes the start of the Moscow day in UTC", () => {
    // 27.10.2026 20:10 МСК = 17:10 UTC; начало суток МСК = 26.10 21:00 UTC.
    expect(startOfMoscowDayUtcIso(new Date("2026-10-27T17:10:00Z"))).toBe(
      "2026-10-26T21:00:00.000Z",
    );
  });

  it("returns the Moscow hour", () => {
    expect(getMoscowHour(new Date("2026-10-27T17:10:00Z"))).toBe(20);
  });
});
