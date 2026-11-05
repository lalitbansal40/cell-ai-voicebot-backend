export const DOCS_PATH = '/api/docs';
export const OPENAPI_JSON_PATH = '/api/v1/openapi.json';
export const PUBLIC_OPENAPI_JSON_PATH = '/api/v1/openapi.public.json';
export const POSTMAN_JSON_PATH = '/api/v1/postman.json';

/** The bar above Swagger UI (served as a file: the docs CSP allows only same-origin styles). */
export const DOCS_CSS = `.nn-bar{display:flex;gap:16px;align-items:center;padding:12px 24px;border-bottom:1px solid #e5e7eb;font-family:system-ui,sans-serif;font-size:14px}
.nn-bar strong{font-size:16px;margin-right:auto}
.nn-bar a{color:#1d4ed8;text-decoration:none}
.nn-bar a:hover{text-decoration:underline}
`;

/** `full` = every route (dev / staging); `public` = the Public API only (production). */
export type DocsMode = 'full' | 'public';

/** Swagger UI shell. No inline scripts — the docs CSP allows `script-src 'self'` only. */
export const renderDocsPage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NotifyNow API</title>
<link rel="stylesheet" href="${DOCS_PATH}/assets/swagger-ui.css">
<link rel="stylesheet" href="${DOCS_PATH}/page.css">
<link rel="icon" type="image/png" href="${DOCS_PATH}/assets/favicon-32x32.png">
</head>
<body>
<nav class="nn-bar" aria-label="API downloads">
<strong>NotifyNow API</strong>
<a href="${PUBLIC_OPENAPI_JSON_PATH}" download="notifynow-openapi.json">Download OpenAPI</a>
<a href="${POSTMAN_JSON_PATH}" download="notifynow-api.postman_collection.json">Download Postman collection</a>
</nav>
<div id="swagger-ui"></div>
<script src="${DOCS_PATH}/assets/swagger-ui-bundle.js"></script>
<script src="${DOCS_PATH}/assets/swagger-ui-standalone-preset.js"></script>
<script src="${DOCS_PATH}/init.js"></script>
</body>
</html>
`;

/** Boots Swagger UI against our spec (served as a file so CSP needs no 'unsafe-inline'). */
export const docsInitJs = (mode: DocsMode): string => {
  const specs =
    mode === 'public'
      ? [`  url: '${PUBLIC_OPENAPI_JSON_PATH}',`]
      : [
          '  urls: [',
          `    { name: 'Public API + guides', url: '${PUBLIC_OPENAPI_JSON_PATH}' },`,
          `    { name: 'All routes (dashboard)', url: '${OPENAPI_JSON_PATH}' },`,
          '  ],',
          "  'urls.primaryName': 'Public API + guides',",
          '  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],',
          "  layout: 'StandaloneLayout',",
        ];
  return [
    'window.ui = SwaggerUIBundle({',
    ...specs,
    "  dom_id: '#swagger-ui',",
    '  deepLinking: true,',
    '  displayRequestDuration: true,',
    '  tryItOutEnabled: true,',
    '  persistAuthorization: true,',
    '  filter: true,',
    "  docExpansion: 'none',",
    '  defaultModelsExpandDepth: 0,',
    '});',
    '',
  ].join('\n');
};
