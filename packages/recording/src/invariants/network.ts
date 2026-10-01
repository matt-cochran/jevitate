export interface NetworkObservable {
  /** URL glob over the full URL (`**` any run, `*` any run without `/`); a leading `/` globs path+query. */
  url: string;
  /** Only responses to this request method (default: any). */
  method?: string;
  /**
   * JSON path into the RESPONSE body, e.g. `$.entries[0].credits`. Exactly one of `json` and
   * `request`.
   */
  json?: string;
  /**
   * #295: JSON path into the REQUEST body the page sent (its JSON payload), e.g. `$.items[*]` — what a
   * save SENT, to compare with what a later read returns (`sameList(saved, reloaded)`). Read when the
   * request's response arrives (same "last matching exchange" rule as `json`). Values under keys that
   * name a credential (`password`, `token`, `secret`, `apiKey`, `otp`, `cvc`, card numbers, …) are
   * never read, and every value is redacted like any other observable.
   */
  request?: string;
  optional?: boolean;
}
