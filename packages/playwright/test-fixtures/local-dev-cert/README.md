Test-only self-signed certificates (`cert.pem`/`key.pem` and a second, unrelated `other-*`) for `localhost` / `127.0.0.1` (#872 tests). Never trusted
anywhere; the private key is public on purpose. Regenerate with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 36500 \
      -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

(the same with `other-key.pem` / `other-cert.pem` for the second one)
