import { describe, expect, it } from "vitest";
import { isSecretName } from "./assertion-refs.js";

describe("isSecretName errs on the side of matching", () => {
  it.each([
    // The checker's names (R5): caught by the old regex, or never caught.
    "passwort", "mot_de_passe", "motdepasse", "userpin", "mypin", "otpcode", "totpcode", "usertoken", "mytoken", "xtoken", "csrftoken", "xsrftoken", "mysecret", "secretvalue", "topsecret", "userpass", "loginpass", "mysession", "sessiondata", "authcookie", "cookiejar", "sessioncookie", "passkey", "passw0rd",
    "p_w_d", "kennwort", "contraseña", "contrasena", "senha", "clave", "mdp", "parola", "wachtwoord", "пароль", "密码", "パスワード", "pässword", "pincode", "PINCODE", "smscode", "sms_code", "verification_code", "verificationCode", "recovery_code", "backupCode", "2fa", "twoFactor", "two_factor_code", "tfa", "csrf", "xsrf", "adminpw", "userpw", "authcode", "authkey", "authheader", "sessid", "PHPSESSID", "connect.sid", "sid", "api.key", "key", "license_key", "encryption_key", "signing_key", "sharedKey", "ssh_key", "webhook_url", "connection_string", "dsn", "card_number", "cardNumber", "ccnumber", "credit_card", "iban", "signature", "hmac", "nonce", "magic_link", "reset_link", "invite_code", "security_answer", "s3cret", "t0ken", "saml", "assertion",
    // The plain ones.
    "password", "PASSWORD", "userPassword", "new_password2", "passwd", "pwd", "PWD", "userPWD", "pass", "pass word", "passcode", "passphrase", "secret", "secret1", "clientSecret", "token", "authToken", "apiKey", "api-key", "APIKey", "API key", "privateKey", "accessKey", "access_key", "auth", "authorization", "Authorization", "bearer", "jwt", "oauth2", "otp", "totp", "mfa_code", "pin", "PIN", "pin_code", "pinCode", "userSSN", "ssn", "cvv", "cvc", "session", "sessionId", "JSESSIONID", "sess", "cookie", "credentials", "cred", "creds",
    // Ordinary words it refuses, whose way out is a declared secret: false.
    "passengers", "token_count", "tokenCount", "max_tokens", "session_name", "footprint", "compass", "bypass_cache", "passport_country", "cookie_banner", "otp_channel", "hotpink", "tokenize", "secretary", "pinColor", "map_pin", "pins",
  ])("%s matches", (name) => expect(isSecretName(name)).toBe(true));

  it.each(["author", "authorName", "authors", "authored", "author_id", "shopping", "shipping_method", "opinion", "mapping", "spinner", "pinned", "classname", "businessName", "inside", "residence", "sesión", "keyboard", "monkey", "turkey", "laptop", "desktop", "stop_price", "tokyo", "sku", "orderId", "customer", "email", "note", ""])("%s does not", (name) => expect(isSecretName(name)).toBe(false));
});
