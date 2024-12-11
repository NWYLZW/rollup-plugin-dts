import type { sub as CJSSub } from 'foo' with { 'resolution-mode': 'require' }
import type { sub as MJSSub } from 'foo' with { 'resolution-mode': 'import' }

export { CJSSub, MJSSub }
