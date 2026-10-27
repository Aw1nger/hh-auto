/**
 * Поиск вакансий на hh.ru через публичную HTML-выдачу.
 *
 * Логинимся для поиска не нужно: hh отдаёт SERP анонимно. Парсим карточки
 * `[data-qa="vacancy-serp__vacancy"]`, поддерживаем пагинацию.
 */
import { load, type CheerioAPI } from "cheerio";

import type { Config } from "../config";
import { Logger } from "../logger";
import type { ParsedVacancy } from "../models";
import { sleep } from "../utils/async";
import { CookieJar } from "../utils/cookies";
import { normalizeSpaces } from "../utils/text";
import { HH_ACCEPT_LANGUAGE, HH_BASE, HH_SEARCH, DESKTOP_UA } from "./constants";
import { HHCaptchaSolver, isHHCaptchaPage } from "./captcha";

const log = new Logger("hh:search");

const EXPERIENCE_MAP: Record<string, string> = {
  no: "noExperience",
  "1-3": "between1And3",
  "3-6": "between3And6",
  "6+": "moreThan6",
};

const EXPERIENCE_LABELS: Record<string, string> = {
  noExperience: "Без опыта",
  between1And3: "1–3 года",
  between3And6: "3–6 лет",
  moreThan6: "Более 6 лет",
};

export interface SearchFilters {
  remote?: boolean;
  experience?: string;
  pages?: number;
}

export interface ParsedSalary {
  from: number | null;
  to: number | null;
  currency: string;
}

/** Распарсить зарплату из текста карточки. */
export function parseSalaryFromText(rawText: string): ParsedSalary {
  const text = normalizeSpaces(rawText).toLowerCase();
  if (!text) return { from: null, to: null, currency: "" };

  let currency = "";
  if (/₽|руб/.test(text)) currency = "RUB";
  else if (/\$|usd|доллар/.test(text)) currency = "USD";
  else if (/€|eur|евро/.test(text)) currency = "EUR";
  else if (/₸|kzt|тенге/.test(text)) currency = "KZT";

  // Отбрасываем слова «опыт», «лет», «месяц» — они не про деньги.
  const moneyChunk = text.replace(/опыт[^,;.]*/g, " ").replace(/за\s+месяц/g, " ");
  const numbers = [...moneyChunk.matchAll(/(\d[\d\s]{2,}\d|\d{3,})/g)]
    .map((match) => Number.parseInt(match[0].replace(/\s/g, ""), 10))
    .filter((value) => Number.isFinite(value) && value >= 1000);

  if (numbers.length === 0) return { from: null, to: null, currency };

  const rangeMatch = /(\d[\d\s]*)\s*[–—-]\s*(\d[\d\s]*)/.exec(moneyChunk);
  if (rangeMatch) {
    const first = Number.parseInt((rangeMatch[1] ?? "").replace(/\s/g, ""), 10);
    const second = Number.parseInt((rangeMatch[2] ?? "").replace(/\s/g, ""), 10);
    if (Number.isFinite(first) && Number.isFinite(second)) {
      return { from: Math.min(first, second), to: Math.max(first, second), currency };
    }
  }

  const hasFrom = /(?:^|\s)от(?:\s|$)/u.test(moneyChunk);
  const hasTo = /(?:^|\s)до(?:\s|$)/u.test(moneyChunk);
  if (hasFrom && hasTo && numbers.length >= 2) {
    return { from: numbers[0] ?? null, to: numbers[1] ?? null, currency };
  }
  if (hasFrom) {
    return { from: numbers[0] ?? null, to: null, currency };
  }
  if (hasTo) {
    return { from: null, to: numbers[0] ?? null, currency };
  }
  return {
    from: numbers[0] ?? null,
    to: numbers.length > 1 ? (numbers[1] ?? null) : null,
    currency,
  };
}

/** Привести ссылку на вакансию к каноническому виду hh.ru. */
export function normalizeVacancyUrl(href: string): { url: string; externalId: string } | null {
  if (!href) return null;
  try {
    const url = new URL(href, HH_BASE);
    const match = /\/vacancy\/(\d+)/.exec(url.pathname);
    if (!match?.[1]) return null;
    return {
      url: `${HH_BASE}/vacancy/${match[1]}`,
      externalId: match[1],
    };
  } catch {
    const match = /\/vacancy\/(\d+)/.exec(href);
    if (!match?.[1]) return null;
    return { url: `${HH_BASE}/vacancy/${match[1]}`, externalId: match[1] };
  }
}

function extractExperience(card: ReturnType<CheerioAPI>): string {
  const node = card.find('[data-qa^="vacancy-serp__vacancy-work-experience-"]').first();
  const qa = node.attr("data-qa") ?? "";
  const code = qa.replace("vacancy-serp__vacancy-work-experience-", "");
  if (code && EXPERIENCE_LABELS[code]) return EXPERIENCE_LABELS[code]!;
  const text = normalizeSpaces(node.text());
  return text.replace(/^опыт\s*/i, "");
}

function extractSalary(card: ReturnType<CheerioAPI>): ParsedSalary {
  // Ищем span, в котором есть валюта — именно там сумма.
  let salaryText = "";
  card.find("span").each((_, element) => {
    if (salaryText) return;
    const text = normalizeSpaces(card.find(element).text());
    if (/[₽$€₸]/.test(text) && /\d/.test(text)) salaryText = text;
  });
  if (!salaryText) salaryText = normalizeSpaces(card.text());
  return parseSalaryFromText(salaryText);
}

function parseCard($: CheerioAPI, element: unknown): ParsedVacancy | null {
  const card = $(element as never);
  const titleLink = card.find('[data-qa="serp-item__title"]').first();
  if (titleLink.length === 0) return null;

  const href = titleLink.attr("href") ?? "";
  const normalized = normalizeVacancyUrl(href);
  if (!normalized) return null;

  const title =
    normalizeSpaces(card.find('[data-qa="serp-item__title-text"]').first().text()) ||
    normalizeSpaces(titleLink.text());
  if (!title) return null;

  const employer = card.find('[data-qa="vacancy-serp__vacancy-employer"]').first();
  const companyName =
    normalizeSpaces(card.find('[data-qa="vacancy-serp__vacancy-employer-text"]').first().text()) ||
    normalizeSpaces(employer.text());
  const companyHref = employer.attr("href") ?? "";
  const companyUrl = companyHref ? new URL(companyHref, HH_BASE).toString() : "";

  const salary = extractSalary(card);
  const location = normalizeSpaces(
    card.find('[data-qa="vacancy-serp__vacancy-address"]').first().text(),
  );
  const cardText = normalizeSpaces(card.text()).toLowerCase();
  const isRemote =
    card.find('[data-qa="vacancy-label-work-schedule-remote"]').length > 0 ||
    /удалённ|удаленн|можно удалённо|можно удаленно|\bremote\b/.test(cardText);

  return {
    platform: "hh",
    externalId: normalized.externalId,
    url: normalized.url,
    title,
    description: "",
    companyName,
    companyUrl,
    salaryFrom: salary.from,
    salaryTo: salary.to,
    salaryCurrency: salary.currency,
    location,
    isRemote,
    experience: extractExperience(card),
    employmentType: "",
    skills: [],
  };
}

export interface BrowserCaptchaLike {
  isAvailable(): boolean;
  solveCaptchaUrl(url: string, reason: string): Promise<boolean>;
}

export class HHParser {
  readonly platform = "hh";
  private readonly config: Config;
  private readonly captcha?: HHCaptchaSolver;
  private readonly browserCaptcha?: BrowserCaptchaLike;
  private readonly jar = new CookieJar();
  private readonly fetchImpl: typeof fetch;
  private readonly proxyUrl?: string;

  constructor(options: {
    config: Config;
    captcha?: HHCaptchaSolver;
    browserCaptcha?: BrowserCaptchaLike;
    fetchImpl?: typeof fetch;
  }) {
    this.config = options.config;
    this.captcha = options.captcha;
    this.browserCaptcha = options.browserCaptcha;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.proxyUrl = options.config.proxyUrl || undefined;
  }

  async searchVacancies(query: string, filters: SearchFilters = {}): Promise<ParsedVacancy[]> {
    const pages = Math.max(1, filters.pages ?? this.config.searchPages);
    const found = new Map<string, ParsedVacancy>();

    for (let page = 0; page < pages; page += 1) {
      const params = new URLSearchParams({
        text: query,
        search_field: "name",
        enable_snippets: "true",
        no_magic: "true",
        items_on_page: String(this.config.searchPerPage),
        page: String(page),
      });
      if (filters.remote) params.set("schedule", "remote");
      if (filters.experience && EXPERIENCE_MAP[filters.experience]) {
        params.set("experience", EXPERIENCE_MAP[filters.experience]!);
      }

      let html: string;
      try {
        html = await this.fetchSearchPage(`${HH_SEARCH}?${params.toString()}`);
      } catch (error) {
        log.error("search_page_error", {
          query,
          page,
          error: error instanceof Error ? error.message : error,
        });
        break;
      }

      const $ = load(html);
      const cards = $('[data-qa="vacancy-serp__vacancy"]');
      log.info("search_page", { query, page, cards: cards.length });
      if (cards.length === 0) break;

      cards.each((_, element) => {
        const vacancy = parseCard($, element);
        if (vacancy) found.set(vacancy.externalId, vacancy);
      });

      if (page + 1 < pages) await sleep(1200);
    }

    return [...found.values()];
  }

  private async fetchSearchPage(url: string): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.fetchWithCookies(url);
      const html = await result.response.text();
      if (!isHHCaptchaPage(result.finalUrl, html)) {
        if (!result.response.ok) {
          throw new Error(`hh search HTTP ${result.response.status}`);
        }
        return html;
      }

      log.warn("search_captcha", { url: result.finalUrl });
      if (!this.config.captchaEnabled) {
        throw new Error("hh просит капчу при поиске");
      }

      let solved = false;
      if (this.browserCaptcha?.isAvailable()) {
        solved = await this.browserCaptcha.solveCaptchaUrl(
          result.finalUrl,
          "поиск вакансий на hh.ru",
        );
      } else if (this.captcha) {
        solved = (await this.captcha.solve(result.finalUrl, "поиск вакансий на hh.ru")).solved;
      }
      if (!solved) throw new Error("капча при поиске не решена");
      await sleep(1200);
    }
    throw new Error("hh просит капчу при поиске");
  }

  private async fetchWithCookies(url: string): Promise<{ response: Response; finalUrl: string }> {
    let currentUrl = url;
    for (let redirect = 0; redirect <= 10; redirect += 1) {
      const headers: Record<string, string> = {
        "User-Agent": DESKTOP_UA,
        "Accept-Language": HH_ACCEPT_LANGUAGE,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      };
      const cookie = this.jar.header(currentUrl);
      if (cookie) headers.Cookie = cookie;

      const init: RequestInit & { proxy?: string } = {
        method: "GET",
        headers,
        redirect: "manual",
      };
      if (this.proxyUrl) init.proxy = this.proxyUrl;

      const response = await this.fetchImpl(currentUrl, init);
      this.jar.setFromHeaders(currentUrl, response.headers);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { response, finalUrl: currentUrl };
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      return { response, finalUrl: currentUrl };
    }
    throw new Error("слишком много редиректов при поиске");
  }
}
