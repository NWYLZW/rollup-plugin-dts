# @jiek/rollup-plugin-dts

Forked from [rollup-plugin-dts](https://github.com/Swatinem/rollup-plugin-dts) and added some features.

- [x] monorepo
- [x] sourcemap
- [ ] keep import attributes
  - [x] static
  - [ ] dynamic
  - [ ] type resolution-mode
- [x] jsdocExplorer

## `jsdocExplorer`

You can use `jsdocExplorer` to customize the output of the jsdoc comments.

```js
const results = {};

export default {
  plugins: [
    dts({
      jsdocExplorer({ comment, tags, parent }, { ts, paths, output }) {
        const resolvedTags = tags.map((tag) => ({
          name: tag.tagName.escapedText,
          comment: typeof tag.comment === "string"
            ? tag.comment
            : tag.comment.map(n => {
              switch (true) {
                case ts.isJSDocLinkLike(n): {
                  /** @type {string} */
                  let type;
                  switch (true) {
                    case ts.isJSDocLinkCode(n): {
                      type = "code";
                      break;
                    }
                    case ts.isJSDocLinkPlain(n): {
                      type = "plain";
                      break;
                    }
                    default:
                      type = "like";
                  }
                  let text = n.name.escapedText;
                  if ("left" in n.name) {
                    text = n.name.left.escapedText;
                  }
                  if ("right" in n.name) {
                    text += ".";
                    text += n.name.right.escapedText;
                  }
                  text += n.text;
                  return {
                    type,
                    text,
                  };
                }
                default:
                  return n.text;
              }
            }),
        }));
        if (!results[output]) {
          results[output] = [];
        }
        results[output].push({
          comment,
          tags: resolvedTags,
          paths,
        });
      },
    }),
    {
      name: "write-results",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "jsdoc.json",
          source: JSON.stringify(results, null, 2),
        });
        // or generate a markdown file
      },
    },
  ],
};
```
