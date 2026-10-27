/**
 * Оценка вакансии по правилам — без LLM и без токенов.
 *
 * Балл складывается из совпадения заголовка с целевыми словами, стека,
 * зарплаты, удалёнки и уровня. Все ключевые слова задаются в `.env`.
 */
import type { AnalyzeResult } from "./models";

export interface AnalyzerConfig {
  targetKeywords: string[];
  negativeKeywords: string[];
  stackKeywords: string[];
  salaryFloor: number;
}

const LEVEL_MIDDLE = [/\bmiddle\b/, /\bmid\b/, /\bсредн/];
const LEVEL_SENIOR = [
  /\bsenior\b/,
  /\bстарш/,
  /\bлид\b/,
  /\blead\b/,
  /\bhead\b/,
  /руководител/,
  /директор/,
  /начальник/,
  /глава/,
];

function containsAny(text: string, words: string[]): boolean {
  return words.some((word) => word && text.includes(word.toLowerCase()));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function analyzeVacancy(
  input: {
    title: string;
    description?: string;
    skills?: string;
    salaryFrom?: number | null;
    salaryTo?: number | null;
    isRemote?: boolean;
    salaryCurrency?: string;
    desiredSalaryMin?: number;
    desiredSalaryMax?: number;
  },
  config: AnalyzerConfig,
): AnalyzeResult {
  const title = (input.title ?? "").toLowerCase();
  const description = (input.description ?? "").toLowerCase();
  const skills = (input.skills ?? "").toLowerCase();
  const full = `${title}\n${description}\n${skills}`;
  const redFlags: string[] = [];

  // 1. Заголовок должен содержать хотя бы одно целевое слово.
  if (!containsAny(title, config.targetKeywords)) {
    return {
      score: 0,
      reason: "Заголовок не соответствует целевым словам",
      isRelevant: false,
      seniority: "unknown",
      redFlags: ["title_mismatch"],
      stackMatch: 0,
    };
  }

  // 2. Стоп-слова в заголовке — дисквалификация.
  if (containsAny(title, config.negativeKeywords)) {
    return {
      score: 0,
      reason: "Дисквалифицировано стоп-словом",
      isRelevant: false,
      seniority: "unknown",
      redFlags: ["negative_keyword"],
      stackMatch: 0,
    };
  }

  // 3. Зарплата ниже порога (если указана и в рублях) — отсеиваем.
  const currency = (input.salaryCurrency ?? "").toUpperCase();
  const salaryFrom = input.salaryFrom ?? null;
  const salaryTo = input.salaryTo ?? null;
  if ((salaryFrom || salaryTo) && (!currency || ["RUR", "RUB", "РУБ"].includes(currency))) {
    const best = Math.max(salaryFrom ?? 0, salaryTo ?? 0);
    if (best > 0 && best < config.salaryFloor) {
      return {
        score: 0,
        reason: `Зарплата ${best} ниже порога ${config.salaryFloor}`,
        isRelevant: false,
        seniority: "unknown",
        redFlags: ["salary_below_floor"],
        stackMatch: 0,
      };
    }
  }

  // 4. Считаем балл.
  let score = 30; // совпал заголовок
  const stackHits = config.stackKeywords.filter((keyword) => full.includes(keyword.toLowerCase())).length;
  const stackScore = Math.min(stackHits * 5, 40);
  score += stackScore;

  const desiredMin = input.desiredSalaryMin ?? 150_000;
  if (salaryFrom || salaryTo) {
    const middle =
      salaryFrom && salaryTo ? Math.floor((salaryFrom + salaryTo) / 2) : salaryFrom || salaryTo || 0;
    if (middle >= desiredMin) score += 15;
    else if (middle >= desiredMin * 0.7) score += 5;
    else redFlags.push("low_salary");
  }

  if (input.isRemote || /удалён|удален|remote/.test(description)) {
    score += 5;
  }

  let seniority = "middle";
  const isSenior = matchesAny(full, LEVEL_SENIOR);
  const isMiddle = matchesAny(full, LEVEL_MIDDLE);
  if (isSenior && !isMiddle) {
    seniority = "senior";
    score += 5;
  } else if (isMiddle) {
    score += 10;
  }

  score = Math.max(0, Math.min(score, 100));

  return {
    score,
    reason: `title=ok, stack=${stackHits}(${stackScore}p), level=${seniority}`,
    isRelevant: score >= 60,
    seniority,
    redFlags,
    stackMatch: stackScore > 0 ? Math.floor((stackScore * 100) / 40) : 0,
  };
}
