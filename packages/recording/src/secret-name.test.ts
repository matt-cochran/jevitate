import { describe, expect, it } from "vitest";
import { isSecretName } from "./assertion-refs.js";

describe("isSecretName matches a name's segments, not its substrings", () => {
  it.each([
    "password", "PASSWORD", "userPassword", "new_password2", "mypassword", "passwd", "pwd", "pass", "passcode", "passphrase",
    "secret", "secret1", "clientSecret", "client_secret", "secrets", "token", "authToken", "authtoken", "access_token", "tokens",
    "apiKey", "api_key", "api-key", "apikey", "APIKey", "API key", "privateKey", "accessKey", "access_key",
    "auth", "authorization", "Authorization", "bearer", "jwt", "oauth2", "otp", "otpCode", "totp", "mfa_code", "pin", "PIN", "pin_code", "pinCode",
    "ssn", "cvv", "cvc", "session", "sessionId", "sessionid", "sess", "cookie", "cookies", "credential", "credentials", "creds",
  ])("%s is a credential", (name) => expect(isSecretName(name)).toBe(true));

  it.each([
    "passengers", "footprint", "compass", "bypass_cache", "passport_country", "spin", "hotpink", "author", "authorName",
    "secretary", "tokenize", "pinned", "sessional", "cookiecutter", "customer", "email", "sku", "note", "keyboard", "orderId", "",
  ])("%s is not", (name) => expect(isSecretName(name)).toBe(false));
});
