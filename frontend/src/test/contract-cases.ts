import { it } from 'vitest'

// Pure contract matrices share one test setup. Every boundary still executes;
// failures include the exact input instead of creating a separate DOM per row.
type Arguments<T> = T extends readonly [...infer A] ? A : [T]
export function contractCases<T>(
  name: string,
  cases: readonly T[],
  check: (...args: Arguments<NoInfer<T>>) => void,
) {
  it(name.replace(/%[sdij]/g, 'boundary'), () => {
    for (const entry of cases) {
      try {
        check(...((Array.isArray(entry) ? entry : [entry]) as Arguments<T>))
      } catch (cause) {
        throw new Error(`Contract input: ${JSON.stringify(entry)}`, { cause })
      }
    }
  })
}
