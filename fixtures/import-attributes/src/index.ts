import { bar as externalCjsSubBar } from "bar" with { "external": "true" };

import type { foo as CJSSub } from "foo" with { "resolution-mode": "require" };

export { CJSSub, externalCjsSubBar };

export type { sub } from "foo/sub" with { "resolution-mode": "import" };
