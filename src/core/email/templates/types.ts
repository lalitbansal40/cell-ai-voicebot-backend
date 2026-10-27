export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Extra mail headers (e.g. `List-Unsubscribe`). */
  headers?: Record<string, string>;
}
