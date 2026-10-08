import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Adds `.openapi()` to zod schemas. Import `z` from here (not from 'zod') in any
// schema that is part of the API contract, so the extension is always loaded.
extendZodWithOpenApi(z);

export { z };
