import MagicString, { type SourceMap } from "magic-string";
import { type MappingItem, SourceMapConsumer } from "source-map";

interface ExtendMS {
  trace: () => Promise<void>;
  updateByGenerated: (
    start: number,
    end: number,
    code: string,
    options?: { overrideOriginalTextHelper?: ReturnType<typeof getTextHelper>; },
  ) => Promise<void>;
}

type LineAndColumn = { line: number; column: number; };

export function getTextHelper(text: string) {
  const lines = text.split("\n");
  return {
    raw: text,
    getPositionOfLineAndColmn(line, column) {
      line -= 1;
      return lines.slice(0, line).reduce((acc, line) => acc + line.length + 1, 0) + column;
    },
    getLineAndColumnOfPosition(pos) {
      const lines = text.split("\n");
      let line = 1;
      let column = 1;
      for (const lineContent of lines) {
        if (pos <= lineContent.length) {
          column = pos;
          break;
        }
        pos -= lineContent.length + 1;
        line++;
      }
      return { line, column };
    },
    getTextBetween(start, end): string {
      if (typeof start === "number") {
        if (typeof end === "number") {
          return text.slice(start, end);
        } else {
          end = this.getPositionOfLineAndColmn(end.line, end.column);
          return text.slice(start, end);
        }
      }
      if (typeof end === "number") {
        start = this.getPositionOfLineAndColmn(start.line, start.column);
        return text.slice(start, end);
      }
      let t = "";
      for (let i = start.line; i <= end.line && i <= lines.length; i++) {
        const lineText = lines[i - 1]!;
        const left = i === start.line ? start.column : 0;
        const right = i === end.line ? end.column + 1 : lineText.length;
        t += lineText.slice(left, right);
        if (i + 1 < end.line) {
          t += "\n";
        }
      }
      return t;
    },
  } satisfies {
    raw: string;
    getPositionOfLineAndColmn: (line: number, column: number) => number;
    getLineAndColumnOfPosition: (pos: number) => LineAndColumn;
    getTextBetween: {
      (start: number, end: number): string;
      (start: LineAndColumn, end: LineAndColumn): string;
    };
  };
}

export function forEachMS<T>(
  consumer: SourceMapConsumer,
  mappingResolve: (m: MappingItem) => T,
  callback: (prev?: T, data?: T) => void,
) {
  let prev: T | undefined;
  consumer.eachMapping(m => {
    using _ = {
      [Symbol.dispose]() {
        prev = data;
      },
    };
    const data = mappingResolve(m);
    callback(prev, data);
  });
  callback(prev);
}

const INLINE_SOURCE_MAP_REGEX = /(.*)\/\/# sourceMappingURL=data:application\/json;base64,([a-zA-Z0-9+/=]+)$/s;

export interface SourceMapHelper extends MagicString, ExtendMS {}

export const sourceMapHelper = async (text: string, {
  sourcemap,
  mock = false,
}: {
  sourcemap?: Omit<SourceMap, "toString" | "toUrl">;
  mock?: boolean;
} = {}) => {
  const existingMap = !!sourcemap || INLINE_SOURCE_MAP_REGEX.exec(text);
  let ms: MagicString;
  let textHelper: ReturnType<typeof getTextHelper>;
  let originalTextHelper: ReturnType<typeof getTextHelper> | undefined;
  const extendMS: ExtendMS = {
    async trace() {
      const textHelper = getTextHelper(ms.toString());
      forEachMS(
        await new SourceMapConsumer(ms.generateMap()),
        m => ({
          generatedPos: textHelper.getPositionOfLineAndColmn(m.generatedLine, m.generatedColumn),
          originalPos: originalTextHelper?.getPositionOfLineAndColmn(m.originalLine, m.originalColumn),
        }),
        (prev, data) => {
          if (prev === undefined && data) {
            console.log({
              a: "",
              b: textHelper.raw.slice(0, data.generatedPos),
            });
            return;
          }
          if (prev && data === undefined) {
            console.log({
              a: originalTextHelper?.raw.slice(prev.originalPos),
              b: textHelper.raw.slice(prev.generatedPos),
            });
            return;
          }
          if (prev === undefined || data === undefined) return;

          console.log({
            a: originalTextHelper?.raw.slice(prev.originalPos, data.originalPos),
            b: textHelper.getTextBetween(prev.generatedPos, data.generatedPos),
          });
        },
      );
    },
    async updateByGenerated(start, end, code, {
      overrideOriginalTextHelper = originalTextHelper,
    } = {}) {
      const originalTextHelper = overrideOriginalTextHelper;
      if (!originalTextHelper) {
        ms.update(start, end, code);
        return;
      }
      const textHelper = getTextHelper(ms.toString());
      const [
        startLineAndColumn,
        endLineAndColumn,
      ] = [
        textHelper.getLineAndColumnOfPosition(start),
        textHelper.getLineAndColumnOfPosition(end),
      ];
      // console.log({
      //   start,
      //   end,
      //   startLineAndColumn,
      //   endLineAndColumn,
      //   code: ms.toString(),
      // });

      const consumer = await new SourceMapConsumer(ms.generateMap({ hires: "boundary" }));
      // forEachMS(
      //   consumer,
      //   m => ({
      //     generatedPos: textHelper.getPositionOfLineAndColmn(m.generatedLine, m.generatedColumn),
      //     originalPos: originalTextHelper.getPositionOfLineAndColmn(m.originalLine, m.originalColumn),
      //   }),
      //   (prev, data) =>
      //     prev && data && console.log("fixModifiers", {
      //       a: originalTextHelper.getTextBetween(prev.originalPos, data.originalPos),
      //       b: textHelper.getTextBetween(prev.generatedPos, data.generatedPos),
      //     }),
      // );

      const mappings: {
        start?: MappingItem & {
          generated: number;
          original: number;
        };
        end?: MappingItem & {
          generated: number;
          original: number;
        };
      } = {};
      consumer.eachMapping(data => {
        if (data.generatedLine === null || data.generatedColumn === null) {
          return;
        }

        if (!mappings.start) {
          if (
            data.generatedLine < startLineAndColumn.line
            || (
              data.generatedColumn < startLineAndColumn.column
              && data.generatedLine < startLineAndColumn.line
            )
          ) {
            return;
          }

          const all = consumer.allGeneratedPositionsFor({
            source: data.source,
            line: data.originalLine,
            column: data.originalColumn,
          });
          if (all.length === 0) {
            throw new Error("No generated positions found");
          }

          const startPosition = all[0]!;
          mappings.start = {
            name: "",
            source: data.source,
            generated: textHelper.getPositionOfLineAndColmn(startPosition.line!, startPosition.column!),
            generatedLine: startPosition.line!,
            generatedColumn: startPosition.column!,
            original: originalTextHelper.getPositionOfLineAndColmn(data.originalLine, data.originalColumn),
            originalLine: data.originalLine,
            originalColumn: data.originalColumn,
          };
        }
        if (!mappings.end && mappings.start) {
          if (
            data.generatedLine < endLineAndColumn.line
            || data.generatedColumn <= endLineAndColumn.column
          ) {
            return;
          }

          const generated = textHelper.getPositionOfLineAndColmn(
            data.generatedLine,
            data.generatedColumn,
          ) - 1;
          const generatedLineAndColumn = textHelper.getLineAndColumnOfPosition(generated);
          const original = originalTextHelper.getPositionOfLineAndColmn(
            data.originalLine,
            data.originalColumn,
          ) - 1;
          const originalLineAndColumn = originalTextHelper.getLineAndColumnOfPosition(original);
          mappings.end = {
            name: "",
            source: data.source,
            generated,
            generatedLine: generatedLineAndColumn.line,
            generatedColumn: generatedLineAndColumn.column,
            original,
            originalLine: originalLineAndColumn.line,
            originalColumn: originalLineAndColumn.column,
          };
        }
      });
      if (!mappings.start) {
        throw new Error("No start mapping found");
      }
      if (!mappings.end) {
        const generatedLineAndColumn = textHelper.getLineAndColumnOfPosition(textHelper.raw.length);
        const originalLineAndColumn = originalTextHelper.getLineAndColumnOfPosition(originalTextHelper.raw.length);
        mappings.end = {
          name: "",
          source: mappings.start.source,
          generated: textHelper.raw.length,
          generatedLine: generatedLineAndColumn.line,
          generatedColumn: generatedLineAndColumn.column,
          original: originalTextHelper.raw.length,
          originalLine: originalLineAndColumn.line,
          originalColumn: originalLineAndColumn.column,
        };
      }

      const generatedContent = textHelper.raw.slice(mappings.start.generated, mappings.end.generated);

      const startInGenerated = start - mappings.start.generated;
      const endInGenerated = end - mappings.start.generated;
      const reGeneratedContent = generatedContent.slice(0, startInGenerated)
        + code
        + generatedContent.slice(endInGenerated);

      // console.log({
      //   text: textHelper.getTextBetween(start, end),
      //   content: originalTextHelper.raw.slice(mappings.start.original, mappings.end.original),
      //
      //   generatedContent,
      //   reGeneratedContent,
      // });

      ms.update(mappings.start.original, mappings.end.original, reGeneratedContent);
    },
  };
  if (existingMap) {
    const [, code, mapBase64StrOrSourcemap] = existingMap === true
      ? [undefined, text, sourcemap]
      : existingMap;
    if (!code || !mapBase64StrOrSourcemap) {
      throw new Error("Invalid inline source map");
    }

    let map: Omit<SourceMap, "toString" | "toUrl">;
    if (typeof mapBase64StrOrSourcemap === "string") {
      const mapStr = atob(mapBase64StrOrSourcemap);
      map = JSON.parse(mapStr);
    } else {
      map = mapBase64StrOrSourcemap;
    }
    const {
      sourcesContent: [originalText] = [],
    } = map;
    if (!originalText) {
      throw new Error("Inline source map must have sourcesContent");
    }

    textHelper = getTextHelper(code);
    originalTextHelper = getTextHelper(originalText);

    ms = new MagicString(originalText);

    const consumer = await new SourceMapConsumer(map);
    forEachMS(
      consumer,
      m => ({
        generatedPos: textHelper.getPositionOfLineAndColmn(m.generatedLine, m.generatedColumn),
        originalPos: originalTextHelper!.getPositionOfLineAndColmn(m.originalLine, m.originalColumn),
      }),
      (prev, data) => {
        if (prev === undefined && data) {
          if (data.generatedPos !== 0) {
            ms.prepend(textHelper.raw.slice(0, data.generatedPos));
          }
          if (data.originalPos !== 0) {
            ms.remove(0, data.originalPos);
          }
          return;
        }
        if (prev && data === undefined) {
          const generatedText = textHelper.raw.slice(prev.generatedPos);
          const length = originalTextHelper?.raw.length;
          if (length && (length > prev.originalPos)) {
            ms.overwrite(prev.originalPos, length, generatedText);
          } else {
            ms.append(generatedText);
          }
          return;
        }
        if (prev === undefined || data === undefined) return;

        const generatedCode = textHelper.raw.slice(prev.generatedPos, data.generatedPos);
        const { originalPos: prevOP } = prev;
        const { originalPos: dataOP } = data;
        const [line0, line1] = generatedCode.split("\n");
        if (line0) {
          if (prevOP === dataOP) {
            ms.appendRight(prevOP, line0);
          } else {
            ms.update(prevOP, dataOP, line0);
          }
          const newPos = prevOP + line0.length;
          if (originalTextHelper?.raw && originalTextHelper.raw.length > newPos) {
            ms.update(
              newPos,
              newPos + 1,
              "\n",
            );
          }
          if (line1) {
            ms.appendRight(dataOP, line1);
          }
        }
      },
    );
  } else {
    const initialText = text;
    ms = mock
      ? {
        original: initialText,

        clone() {
          return ms;
        },
        snip() {
          throw new Error("Mocked MagicString does not support snip");
        },

        lastChar() {
          return text[text.length - 1] ?? "";
        },
        lastLine() {
          let lastline = "";
          let i = text.length - 1;
          while (i >= 0 && text[i] !== "\n") {
            lastline = text[i] + lastline;
            i--;
          }
          return lastline;
        },

        update(start, end, content) {
          text = text.slice(0, start) + content + text.slice(end);
          return ms;
        },
        overwrite(start, end, content) {
          return ms.update(start, end, content);
        },
        slice(start, end) {
          return text.slice(start, end);
        },
        replace(regex, replacement) {
          // make ts happy
          if (typeof replacement === "string") {
            text = text.replace(regex, replacement);
          } else {
            text = text.replace(regex, replacement);
          }
          return ms;
        },
        replaceAll(regex, replacement) {
          // make ts happy
          if (typeof replacement === "string") {
            text = text.replaceAll(regex, replacement);
          } else {
            text = text.replaceAll(regex, replacement);
          }
          return ms;
        },
        reset(start: number, end: number) {
          text = text.slice(0, start) + initialText.slice(start, end) + text.slice(end);
          return ms;
        },

        append(content) {
          text += content;
          return ms;
        },
        prepend(content) {
          text = content + text;
          return ms;
        },
        move(start, end, index) {
          const content = text.slice(start, end);
          text = text.slice(0, start) + text.slice(end, index) + content + text.slice(index);
          return ms;
        },
        remove(start, end) {
          text = text.slice(0, start) + text.slice(end);
          return ms;
        },
        appendLeft(index, content) {
          text = text.slice(0, index) + content + text.slice(index);
          return ms;
        },
        appendRight(index, content) {
          text = text.slice(0, index) + content + text.slice(index);
          return ms;
        },
        prependLeft(index, content) {
          text = text.slice(0, index) + content + text.slice(index);
          return ms;
        },
        prependRight(index, content) {
          text = text.slice(0, index) + content + text.slice(index);
          return ms;
        },

        trim() {
          text = text.trim();
          return ms;
        },
        trimStart() {
          text = text.trimStart();
          return ms;
        },
        trimEnd() {
          text = text.trimEnd();
          return ms;
        },
        trimLines() {
          text = text.trim().replace(/\n\s+/g, "\n");
          return ms;
        },

        getIndentString() {
          throw new Error("Mocked MagicString does not support getIndentString");
        },
        indent() {
          throw new Error("Mocked MagicString does not support indent");
        },
        indentExclusionRanges: [],

        addSourcemapLocation() {
          return ms;
        },

        isEmpty() {
          return text === "";
        },
        length(): number {
          return text.length;
        },
        hasChanged() {
          return text !== initialText;
        },
        toString() {
          return text;
        },
        generateMap(): any {
          throw new Error("Mocked MagicString does not support generateMap");
        },
        generateDecodedMap(): any {
          throw new Error("Mocked MagicString does not support generateDecodedMap");
        },
      } satisfies MagicString
      : new MagicString(text, {
        indentExclusionRanges: [],
      });
    textHelper = getTextHelper(text);
  }
  const extMS = new Proxy(ms as MagicString & ExtendMS, {
    get(target, key: string) {
      if (!["toString"].includes(key) && key in extendMS) {
        if (mock) {
          return ({
            trace() {
              throw new Error("Mocked MagicString does not support trace");
            },
            async updateByGenerated(start, end, code) {
              ms.update(start, end, code);
            },
          } satisfies ExtendMS)[key as keyof ExtendMS];
        }
        return extendMS[key as keyof ExtendMS];
      }
      return Reflect.get(target, key);
    },
  });
  return [
    extMS,
    { textHelper, originalTextHelper },
  ] as const;
};
