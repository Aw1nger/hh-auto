import { describe, expect, it } from "bun:test";

import { Notifier } from "../src/notifier";

const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("notifier captcha flow", () => {
  it("sends a captcha and resolves it with the user's answer", async () => {
    const notifier = new Notifier();
    const sent: string[] = [];
    let resolveAsk!: () => void;
    const asked = new Promise<void>((resolve) => {
      resolveAsk = resolve;
    });

    notifier.configure({
      sendText: async (text) => {
        sent.push(text);
      },
      sendCaptchaImage: async (prompt) => {
        expect(prompt.image.byteLength).toBe(4);
        expect(prompt.url).toContain("captcha");
        resolveAsk();
      },
      verbose: false,
    });

    const promise = notifier.askCaptcha(
      { image, caption: "Введи капчу", url: "https://hh.ru/account/captcha?state=1" },
      5000,
    );
    await asked;
    expect(notifier.hasPendingCaptcha()).toBe(true);
    expect(notifier.resolveCaptcha("  абвгд  ")).toBe(true);
    await expect(promise).resolves.toBe("абвгд");
    expect(notifier.hasPendingCaptcha()).toBe(false);
  });

  it("returns null on cancel", async () => {
    const notifier = new Notifier();
    notifier.configure({
      sendText: async () => undefined,
      sendCaptchaImage: async () => undefined,
      verbose: false,
      fallbackDir: "/tmp/hh-auto-captcha-test",
    });

    const promise = notifier.askCaptcha(
      { image, caption: "c", url: "https://hh.ru/account/captcha?state=2" },
      5000,
    );
    for (let index = 0; index < 100 && !notifier.hasPendingCaptcha(); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(notifier.cancelCaptcha()).toBe(true);
    await expect(promise).resolves.toBeNull();
  });

  it("returns null on timeout", async () => {
    const notifier = new Notifier();
    notifier.configure({
      sendText: async () => undefined,
      sendCaptchaImage: async () => undefined,
      verbose: false,
      fallbackDir: "/tmp/hh-auto-captcha-test",
    });

    const promise = notifier.askCaptcha(
      { image, caption: "c", url: "https://hh.ru/account/captcha?state=3" },
      20,
    );
    await expect(promise).resolves.toBeNull();
  });
});
