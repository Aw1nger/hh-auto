import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import { Store } from "../src/db";

const paths: string[] = [];

function makeStore(): Store {
  const path = `/tmp/hh-auto-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
  paths.push(path);
  return new Store(path);
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) unlinkSync(file);
    }
  }
});

const vacancy = {
  platform: "hh",
  externalId: "101",
  url: "https://hh.ru/vacancy/101",
  title: "Performance-маркетолог",
  companyName: "ООО Тест",
  salaryFrom: 150_000,
  salaryTo: 200_000,
  salaryCurrency: "RUB",
  location: "Москва",
  isRemote: true,
};

describe("sqlite store", () => {
  it("inserts vacancies and deduplicates by platform + external id", () => {
    const store = makeStore();
    expect(store.insertVacancies([vacancy])).toBe(1);
    expect(store.insertVacancies([vacancy])).toBe(0);
    expect(store.getUnanalyzed().length).toBe(1);
    store.close();
  });

  it("moves analyzed vacancies into the apply queue", () => {
    const store = makeStore();
    store.insertVacancies([vacancy]);
    const [item] = store.getUnanalyzed();
    store.saveAnalysis(item!.id, 75, "title=ok", "remote");
    const candidates = store.getApplyCandidates("hh", 10, 50);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.score).toBe(75);
    expect(candidates[0]!.workFormat).toBe("remote");
    store.close();
  });

  it("counts sent applications for today", () => {
    const store = makeStore();
    store.insertVacancies([vacancy]);
    const [item] = store.getUnanalyzed();
    store.addApplication({
      vacancyId: item!.id,
      platform: "hh",
      status: "sent",
      coverLetter: "hello",
    });
    expect(store.countSentToday("hh")).toBe(1);
    expect(store.getStats().sentToday).toBe(1);
    store.close();
  });

  it("deduplicates recruiter messages by thread id", () => {
    const store = makeStore();
    store.insertVacancies([vacancy]);
    const first = store.addMessageIfNew({
      platform: "hh",
      title: "Performance-маркетолог",
      company: "ООО Тест",
      text: "Статус: Приглашение",
      threadId: "hh_1|invitations|Приглашение",
    });
    const second = store.addMessageIfNew({
      platform: "hh",
      title: "Performance-маркетолог",
      company: "ООО Тест",
      text: "Статус: Приглашение",
      threadId: "hh_1|invitations|Приглашение",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    store.close();
  });

  it("skips blacklisted companies", () => {
    const store = makeStore();
    store.addBlacklist("company", "ООО Тест");
    expect(store.insertVacancies([vacancy])).toBe(0);
    store.close();
  });

  it("marks vacancies applied by external id", () => {
    const store = makeStore();
    store.insertVacancies([vacancy]);
    expect(store.markAppliedByExternalIds("hh", ["101"])).toBe(1);
    expect(store.getVacancy(1)?.status).toBe("applied");
    store.close();
  });

  it("handles companies table with strict NOT NULL on is_blacklisted", () => {
    // Симулируем старую базу, где companies.is_blacklisted создан с NOT NULL без DEFAULT
    const path = `/tmp/hh-auto-legacy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
    paths.push(path);
    const { Database } = require("bun:sqlite");
    const rawDb = new Database(path, { create: true });
    rawDb.exec(`
      CREATE TABLE companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT,
        platform TEXT NOT NULL DEFAULT 'hh',
        platform_id TEXT,
        description TEXT,
        is_blacklisted INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    rawDb.close();

    const store = new Store(path);
    const testVacancy = {
      ...vacancy,
      externalId: "legacy-999",
      companyName: "Новая Компания Без Дефолта",
    };
    const inserted = store.insertVacancies([testVacancy]);
    expect(inserted).toBe(1);
    store.close();
  });
});
