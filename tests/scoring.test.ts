import { describe, expect, it } from "bun:test";

import { analyzeVacancy } from "../src/scoring";

const config = {
  targetKeywords: ["маркетолог", "performance"],
  negativeKeywords: ["junior", "стажёр"],
  stackKeywords: ["performance", "cpa", "seo", "аналитика"],
  salaryFloor: 100_000,
};

describe("rule-based scoring", () => {
  it("scores a matching vacancy", () => {
    const result = analyzeVacancy(
      {
        title: "Performance-маркетолог",
        description: "Google Ads, CPA, SEO, аналитика",
        salaryFrom: 150_000,
        salaryTo: 200_000,
        isRemote: true,
      },
      config,
    );
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.isRelevant).toBe(true);
    expect(result.stackMatch).toBeGreaterThan(0);
  });

  it("rejects a title without target words", () => {
    const result = analyzeVacancy({ title: "Бухгалтер" }, config);
    expect(result.score).toBe(0);
    expect(result.redFlags).toContain("title_mismatch");
  });

  it("rejects negative keywords", () => {
    const result = analyzeVacancy({ title: "Junior performance-маркетолог" }, config);
    expect(result.score).toBe(0);
    expect(result.redFlags).toContain("negative_keyword");
  });

  it("rejects salaries below the floor in rubles", () => {
    const result = analyzeVacancy(
      { title: "Маркетолог", salaryFrom: 50_000, salaryCurrency: "RUB" },
      config,
    );
    expect(result.score).toBe(0);
    expect(result.redFlags).toContain("salary_below_floor");
  });

  it("does not apply the ruble floor to USD salaries", () => {
    const result = analyzeVacancy(
      { title: "Performance-маркетолог", salaryFrom: 2_000, salaryCurrency: "USD" },
      config,
    );
    expect(result.score).toBeGreaterThan(0);
  });
});
