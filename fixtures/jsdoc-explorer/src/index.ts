/**
 * This is description for Foo.
 * @example
 * const foo: Foo = {};
 */
export interface Foo {
  /**
   * @default 'foo'
   */
  name?: string;
}

/**
 * This is description for Bar.
 * @test-other-tag value
 */
export const bar = 1;

/** @test-other-tag value */
export const bor = 1;

/**
 * This is description for bmr.
 * @return {void}
 * This is description for return value.
 * And this is a link to {@link Foo}.
 * And this is a plain link to {@linkplain Foo}.
 * And this is a link with field to {@link Foo#name}.
 * And this is a link with field to {@link Foo.name}.
 * And this is not exist link to {@link NotExist}.
 * And this is an url link to {@link https://example.com}.
 * And this is an url link with text to {@link https://example.com|example}.
 * @param {string} a - This is
 * description for `a`.
 */
export function bmr(a: string): void {}

/** @a_for value */
export const bxr = 1;

/** @internal */
export const baz = 2;

/**
 * @internal
 */
export const qux = 3;

export namespace ns {
  /**
   * This is description for foo.
   * @example
   * console.log(foo);
   */
  export const foo = 1;
  export namespace a {
    /**
     * This is description for bar.
     * @example
     * console.log(bar);
     */
    export const bar = 1;
  }
}

export namespace ns.a {
  /**
   * This is description for foo.
   * @example
   * console.log(foo);
   */
  export const foo = 1;
}

export namespace ns.a.b.c {
  /**
   * This is description for foo.
   * @example
   * console.log(foo);
   */
  export const foo = 1;
}
