import MagicString, { type SourceMap } from "magic-string";
import { type MappedPosition, type MappingItem, SourceMapConsumer } from "source-map";

interface ExtendMS {
  trace: () => Promise<void>;
  updateByGenerated: (start: number, end: number, code: string) => Promise<void>;
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
}: {
  sourcemap?: SourceMap;
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
    async updateByGenerated(start, end, code) {
      if (!originalTextHelper) {
        ms.update(start, end, code);
        return;
      }
      const textHelper = getTextHelper(ms.toString());
      const [
        startLineAndColumn,
        endLineAndColumn,
        realEndLineAndColumn,
      ] = [
        textHelper.getLineAndColumnOfPosition(start),
        textHelper.getLineAndColumnOfPosition(end),
        textHelper.getLineAndColumnOfPosition(end - 1),
      ];

      const consumer = await new SourceMapConsumer(ms.generateMap());
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

      const originalStartLineAndColumn = consumer.originalPositionFor({
        ...startLineAndColumn,
      }) as MappedPosition;
      if (originalStartLineAndColumn.line === null || originalStartLineAndColumn.column === null) {
        throw new Error("Source map is invalid");
      }
      const originalStart = originalTextHelper.getPositionOfLineAndColmn(
        originalStartLineAndColumn.line,
        originalStartLineAndColumn.column,
      );

      const originalEndLineAndColumn = consumer.originalPositionFor({
        ...endLineAndColumn,
        bias: SourceMapConsumer.LEAST_UPPER_BOUND,
      }) as MappedPosition;
      if (originalEndLineAndColumn.line === null || originalEndLineAndColumn.column === null) {
        throw new Error("Source map is invalid");
      }
      const originalEnd = originalTextHelper.getPositionOfLineAndColmn(
        originalEndLineAndColumn.line,
        originalEndLineAndColumn.column,
      );

      const realOriginalEndLineAndColumn = consumer.originalPositionFor({
        ...realEndLineAndColumn,
        bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
      }) as MappedPosition;
      if (realOriginalEndLineAndColumn.line === null || realOriginalEndLineAndColumn.column === null) {
        throw new Error("Source map is invalid");
      }

      const generated = {
        start: consumer.generatedPositionFor(originalStartLineAndColumn),
        end: consumer.generatedPositionFor(realOriginalEndLineAndColumn),
      };

      const generatedContent = textHelper.getTextBetween({
        line: generated.start.line!,
        column: generated.start.column!,
      }, {
        line: generated.end.line!,
        column: generated.end.lastColumn!,
      });

      const generaredStart = textHelper.getPositionOfLineAndColmn(generated.start.line!, generated.start.column!);
      const startInGenerated = start - generaredStart;
      const endInGenerated = end - generaredStart;
      const reGeneratedContent = generatedContent.slice(0, startInGenerated) + code
        + generatedContent.slice(endInGenerated);

      // console.log({
      //   text: textHelper.getTextBetween(start, end),
      //   content: originalTextHelper.getTextBetween(originalStart, originalEnd),
      //   generatedContent,
      //   reGeneratedContent,
      // });

      ms.update(originalStart, originalEnd, reGeneratedContent);
    },
  };
  if (existingMap) {
    const [, code, mapBase64StrOrSourcemap] = existingMap === true
      ? [undefined, text, sourcemap]
      : existingMap;
    if (!code || !mapBase64StrOrSourcemap) {
      throw new Error("Invalid inline source map");
    }

    let map: SourceMap;
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
        if (prev.originalPos === data.originalPos) {
          ms.appendRight(prev.originalPos, generatedCode);
          return;
        }
        ms.overwrite(prev.originalPos, data.originalPos, generatedCode);
      },
    );
  } else {
    ms = new MagicString(text);
    textHelper = getTextHelper(text);
  }
  return [
    new Proxy(ms as MagicString & ExtendMS, {
      get(target, key: string) {
        if (!["toString"].includes(key) && key in extendMS) {
          return extendMS[key as keyof ExtendMS];
        }
        return Reflect.get(target, key);
      },
    }),
    { textHelper, originalTextHelper },
  ] as const;
};
