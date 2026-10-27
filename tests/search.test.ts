import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { loadConfig } from "../src/config";
import {
  HHParser,
  normalizeVacancyUrl,
  parseSalaryFromText,
} from "../src/hh/search";

const fixture = readFileSync("tests/fixtures/search.html", "utf8");

function makeParser() {
  const config = loadConfig({
  } as NodeJS.ProcessEnv);
  return new HHParser({
    config,
    fetchImpl: (async () =>
      new Response(fixture, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch,
  });
}

describe("hh search parser", () => {
  it("parses cards from real hh markup", async () => {
    const parser = makeParser();
    const vacancies = await parser.searchVacancies("performance маркетолог", { pages: 1 });
    expect(vacancies.length).toBe(3);

    const first = vacancies[0]!;
    expect(first.platform).toBe("hh");
    expect(first.externalId).toMatch(/^\d+$/);
    expect(first.url).toMatch(/^https:\/\/hh\.ru\/vacancy\/\d+$/);
    expect(first.title.length).toBeGreaterThan(3);
    expect(first.companyName?.length ?? 0).toBeGreaterThan(0);
    const withSalary = vacancies.find((item) => item.salaryCurrency === "RUB");
    expect(withSalary).toBeDefined();
    expect(withSalary!.salaryFrom).toBeGreaterThan(0);
  });

  it("normalizes regional vacancy links", () => {
    expect(
      normalizeVacancyUrl(
        "https://ryazan.hh.ru/vacancy/138795148?query=performance&hhtmFrom=vacancy_search_list",
      ),
    ).toEqual({ url: "https://hh.ru/vacancy/138795148", externalId: "138795148" });
  });

  it("parses salary ranges", () => {
    expect(parseSalaryFromText("от 150 000 ₽ за месяц, на руки")).toEqual({
      from: 150_000,
      to: null,
      currency: "RUB",
    });
    expect(parseSalaryFromText("100 000 – 200 000 ₽")).toEqual({
      from: 100_000,
      to: 200_000,
      currency: "RUB",
    });
    expect(parseSalaryFromText("до 80 000 ₽")).toEqual({
      from: null,
      to: 80_000,
      currency: "RUB",
    });
    expect(parseSalaryFromText("$2 000 – $3 000")).toEqual({
      from: 2_000,
      to: 3_000,
      currency: "USD",
    });
  });
});
