import { describe, expect, it } from "bun:test";

import {
  extractCaptchaError,
  isHHCaptchaPage,
  parseCaptchaState,
} from "../src/hh/captcha";

const API_RESPONSE = JSON.stringify({
  errors: [
    {
      value: "captcha_required",
      captcha_url:
        "https://hh.ru/account/captcha?state=YeyJ73OhmlpVWfJL2k4ACuU62EUzQ7OOXpePTNMOORUTXXQ1D_vD0Nv-cbJDcmA3qGJoGVuFOQF6ox36CX1-K3j7RkoIjawU9HwOjYK50doqsV_rr9KckQPhDV3afOs8PH-kt_QST-Ehg-whzpvHOmar7-mMd6eOFVv1aHDGbbtZk_nN3DNhlPoUyTo%3D",
      type: "captcha_required",
    },
  ],
  request_id: "179312074607141dd8fb17add11b9005",
});

describe("hh captcha helpers", () => {
  it("extracts captcha url from an api.hh.ru 403 body", () => {
    const info = extractCaptchaError(API_RESPONSE);
    expect(info).not.toBeNull();
    expect(info?.url).toContain("https://hh.ru/account/captcha?state=");
    expect(info?.requestId).toBe("179312074607141dd8fb17add11b9005");
    expect(parseCaptchaState(info!.url)).toContain("YeyJ73");
  });

  it("accepts a captcha in the type field as well", () => {
    const info = extractCaptchaError(
      JSON.stringify({
        errors: [
          {
            type: "captcha_required",
            captcha_url: "https://hh.ru/account/captcha?state=abc",
          },
        ],
      }),
    );
    expect(info?.url).toBe("https://hh.ru/account/captcha?state=abc");
  });

  it("returns null for non-captcha bodies", () => {
    expect(extractCaptchaError('{"errors":[{"value":"already_applied"}]}')).toBeNull();
    expect(extractCaptchaError("")).toBeNull();
  });

  it("recognises a captcha page", () => {
    expect(isHHCaptchaPage("https://hh.ru/account/captcha?state=x")).toBe(true);
    expect(
      isHHCaptchaPage("https://hh.ru/account/captcha", '<img data-qa="account-captcha-picture">'),
    ).toBe(true);
    expect(isHHCaptchaPage("https://hh.ru/vacancy/1", "<html>vacancy</html>")).toBe(false);
  });
});
