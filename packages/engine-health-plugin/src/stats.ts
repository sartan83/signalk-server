export interface Stats {
  mean: number
  stdDev: number
}

/** Moving average and (population) standard deviation of a set of readings. */
export function computeStats(values: number[]): Stats {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance =
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length
  return { mean, stdDev: Math.sqrt(variance) }
}

/** True when value lies outside mean ± stdDevMultiplier * stdDev. */
export function isAnomaly(
  value: number,
  stats: Stats,
  stdDevMultiplier: number
): boolean {
  const deviation = stdDevMultiplier * stats.stdDev
  return value > stats.mean + deviation || value < stats.mean - deviation
}
