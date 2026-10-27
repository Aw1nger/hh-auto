import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

import { loadConfig } from "../src/config";
import { generateHHApiUserAgent, HHOAuthClient } from "../src/hh/oauth";

const tokenPaths: string[] = [];

function makeConfig(tokenPath: string) {
  return loadConfig({
    HH_RESUME_ID: "resume-hash",
    HH_TOKEN_PATH: tokenPath,
    CAPTCHA_SUBMIT_DELAY_SEC: "0",
    CAPTCHA_COOLDOWN_SEC: "0",
  } as NodeJS.ProcessEnv);
}

function makeToken(tokenPath: string): void {
  writeFileSync(
    tokenPath,
    JSON.stringify({
      access_token: "USER_TOKEN",
      refresh_token: "REFRESH",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  tokenPaths.push(tokenPath);
}

afterEach(() => {
  for (const path of tokenPaths.splice(0)) {
    if (existsSync(path)) unlinkSync(path);
  }
});

const CAPTCHA_BODY = JSON.stringify({
  errors: [
    {
      value: "captcha_required",
      captcha_url: "https://hh.ru/account/captcha?state=STATE123",
    },
  ],
  request_id: "req-1",
});

describe("oauth apply + captcha", () => {
  it("generates a random official-format Android UA", () => {
    const first = generateHHApiUserAgent();
    const second = generateHHApiUserAgent();
    expect(first).toMatch(
      /^ru\.hh\.android\/7\.\d+\.\d+, Device: [A-Z0-9]{10}, Android OS: \d+ \(UUID: [0-9a-f-]+\)$/,
    );
    expect(first).not.toBe(second);
  });

  it("solves captcha and retries the apply", async () => {
    const tokenPath = `/tmp/hh-oauth-test-${Date.now()}.json`;
    makeToken(tokenPath);
    const config = makeConfig(tokenPath);
    let calls = 0;
    let solvedUrl = "";

    const captcha = {
      solve: async (url: string) => {
        solvedUrl = url;
        return { solved: true, attempts: 1 };
      },
      wasRecentlySolved: () => false,
    };

    const client = new HHOAuthClient({
      config,
      captcha: captcha as never,
      browser: {} as never,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(CAPTCHA_BODY, {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });

    const outcome = await client.apply("12345", "Здравствуйте!");
    expect(outcome.result).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(solvedUrl).toContain("captcha");
    expect(calls).toBe(2);
  });

  it("returns captcha_failed when the user does not solve it", async () => {
    const tokenPath = `/tmp/hh-oauth-test-${Date.now()}-2.json`;
    makeToken(tokenPath);
    const config = makeConfig(tokenPath);

    const captcha = {
      solve: async () => ({ solved: false, reason: "cancelled", attempts: 1 }),
      wasRecentlySolved: () => false,
    };

    const client = new HHOAuthClient({
      config,
      captcha: captcha as never,
      browser: {} as never,
      fetchImpl: (async () =>
        new Response(CAPTCHA_BODY, {
          status: 403,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    const outcome = await client.apply("12345", "Здравствуйте!");
    expect(outcome.result).toBe(false);
    expect(outcome.error).toBe("captcha_failed");
  });

  it("solves captcha in browser and retries the apply", async () => {
    const tokenPath = `/tmp/hh-oauth-test-${Date.now()}-3.json`;
    makeToken(tokenPath);
    const config = makeConfig(tokenPath);
    let directCalls = 0;
    let solveCalls = 0;

    const client = new HHOAuthClient({
      config,
      captcha: {
        solve: async () => ({ solved: false, attempts: 1 }),
        wasRecentlySolved: () => false,
      } as never,
      browser: {
        isAvailable: () => true,
      } as never,
      browserCaptcha: {
        solveCaptchaUrl: async () => {
          solveCalls += 1;
          return true;
        },
      } as never,
      fetchImpl: (async () => {
        directCalls += 1;
        if (directCalls === 1) {
          return new Response(CAPTCHA_BODY, {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });

    const outcome = await client.apply("12345", "Здравствуйте!");
    expect(outcome.result).toBe(true);
    expect(solveCalls).toBe(1);
    expect(directCalls).toBe(2);
  });
});
