export interface NetworkObservable {
  /** URL glob over the full URL (`**` any run, `*` any run without `/`); a leading `/` globs path+query. */
  url: string;
  /** Only responses to this request method (default: any). */
  method?: string;
  /** JSON path into the response body, e.g. `$.entries[0].credits`. */
  json: string;
  optional?: boolean;
}
