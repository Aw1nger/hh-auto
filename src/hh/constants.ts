/** Константы hh.ru и публичные credentials Android-приложения. */

export const HH_BASE = "https://hh.ru";
export const HH_API = "https://api.hh.ru";
export const HH_SEARCH = "https://hh.ru/search/vacancy";
export const HH_NEGOTIATIONS = "https://hh.ru/applicant/negotiations";
export const HH_RESUMES = "https://hh.ru/applicant/resumes";

// Публичные credentials Android-приложения hh.ru. Используются всеми
// open-source клиентами; это не секрет конкретного пользователя.
export const CLIENT_ID =
  "HIOMIAS39CA9DICTA7JIO64LQKQJF5AGIK74G9ITJKLNEDAOH5FHS5G1JI7FOEGD";
export const CLIENT_SECRET =
  "V9M870DE342BGHFRUJ5FTCGCUA1482AN0DI8C5TFI9ULMA89H10N60NOP8I4JMVS";
export const REDIRECT_URI = "hhandroid://oauthresponse";

export const ANDROID_UA = "ru.hh.android/8.116 (Android 13; samsung SM-S908B)";
export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
export const ANDROID_WEBVIEW_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36";

export const CAPTCHA_SUCCESS_BACKURL = "hh://applicant/captchaSuccessBackUrl";

export const HH_ACCEPT_HTML =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
export const HH_ACCEPT_LANGUAGE = "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7";
