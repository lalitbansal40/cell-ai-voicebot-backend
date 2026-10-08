export const DOCS_PATH = '/api/docs';
export const OPENAPI_JSON_PATH = '/api/v1/openapi.json';

/** Swagger UI shell. No inline scripts — the docs CSP allows `script-src 'self'` only. */
export const renderDocsPage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cell AI Voicebot API</title>
<link rel="stylesheet" href="${DOCS_PATH}/assets/swagger-ui.css">
<link rel="icon" type="image/png" href="${DOCS_PATH}/assets/favicon-32x32.png">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${DOCS_PATH}/assets/swagger-ui-bundle.js"></script>
<script src="${DOCS_PATH}/init.js"></script>
</body>
</html>
`;

/** Boots Swagger UI against our spec (served as a file so CSP needs no 'unsafe-inline'). */
export const DOCS_INIT_JS = `window.ui = SwaggerUIBundle({
  url: '${OPENAPI_JSON_PATH}',
  dom_id: '#swagger-ui',
  deepLinking: true,
  displayRequestDuration: true,
  tryItOutEnabled: true,
});
`;
