import { describe, expect, it } from "vitest";
import { externalSchemeOf, isExternalSchemeUrl, urlSchemeOf } from "./external-scheme.js";

describe("external-scheme classifier (#375)", () => {
  it.each([
    ["sms:+15555550100?body=hi", "sms"],
    ["sms:%2B15555550100", "sms"],
    ["tel:+15555550100", "tel"],
    ["TEL:+15555550100", "tel"],
    ["mailto:someone@example.com", "mailto"],
    ["facetime:+15555550100", "facetime"],
    ["facetime-audio:+15555550100", "facetime-audio"],
    ["maps:?q=coffee", "maps"],
    ["geo:37.786971,-122.399677", "geo"],
    ["intent://scan/#Intent;scheme=zxing;end", "intent"],
    ["myapp://open/item/42", "myapp"],
    ["whatsapp://send?text=hi", "whatsapp"],
    ["  tel:911", "tel"],
  ])("%s is handed to the OS (%s)", (url, scheme) => {
    expect(externalSchemeOf(url)).toBe(scheme);
    expect(isExternalSchemeUrl(url)).toBe(true);
  });

  it.each([
    "http://127.0.0.1:8080/api",
    "https://app.example.com/%2B15555550100",
    "HTTPS://APP.EXAMPLE.COM/",
    "ws://127.0.0.1/socket",
    "wss://example.com/socket",
    "data:text/plain,hi",
    "blob:https://app.example.com/1234",
    "about:blank",
    "file:///tmp/x.html",
    "javascript:void(0)",
    "chrome-error://chromewebdata/",
    "chrome-extension://abc/page.html",
  ])("%s is loaded by the browser itself — never external", (url) => {
    expect(externalSchemeOf(url)).toBeUndefined();
    expect(isExternalSchemeUrl(url)).toBe(false);
  });

  it.each(["", "/%2B15555550100", "relative/path", "//cdn.example.com/x.js", "1tel:123", "+15555550100"])(
    "%j has no scheme — never external (fail closed)",
    (url) => {
      expect(isExternalSchemeUrl(url)).toBe(false);
    },
  );

  it("urlSchemeOf lowercases and drops the colon", () => {
    expect(urlSchemeOf("SMS:+1")).toBe("sms");
    expect(urlSchemeOf("no-scheme-here")).toBeUndefined();
  });
});
