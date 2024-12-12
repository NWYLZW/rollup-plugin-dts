import { bar as cjsSubBar } from 'bar' with { 'external': 'true' }
import type { foo as CJSSub } from 'foo' with { 'resolution-mode': 'require' }
import type { foo as MJSSub } from 'foo' with { 'resolution-mode': 'import' }

export { cjsSubBar, CJSSub, MJSSub }
