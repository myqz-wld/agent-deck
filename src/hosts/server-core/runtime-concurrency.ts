/** Runs a bounded fan-out and reports every cleanup failure after all workers settle. */
export async function mapServerCoreConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  consume: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const failures: unknown[] = [];
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (index < values.length) {
        const value = values[index++];
        try { await consume(value!); } catch (error) { failures.push(error); }
      }
    },
  ));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Provider session retirement failed');
  }
}
