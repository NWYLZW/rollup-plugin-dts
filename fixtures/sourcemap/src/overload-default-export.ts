export default function foo(a: number): number;
export default function foo(a: bigint): bigint;
export default function foo(): string;
export default function foo(): number | bigint | string {
  return "foo";
}
