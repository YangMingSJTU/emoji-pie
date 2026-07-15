import { stableJson } from './hashing'

export const CORPUS_50_FORBIDDEN_VALUES = [
  '张三',
  '项目代号 X',
  '张三说项目代号 X 明天暂停'
] as const

export function redactPrivateTerms(value: string): string {
  return value
    .replace(/张三/giu, ' ')
    .replace(/项目代号\s*[A-Za-z0-9_-]+/giu, ' ')
}

export function findForbiddenValues(
  value: unknown,
  forbiddenValues: readonly string[] = CORPUS_50_FORBIDDEN_VALUES
): string[] {
  const serialized = typeof value === 'string' ? value : stableJson(value)
  const decoded = (() => {
    try {
      return decodeURIComponent(serialized)
    } catch {
      return serialized
    }
  })().toLocaleLowerCase()
  return forbiddenValues.filter((entry) => decoded.includes(entry.toLocaleLowerCase()))
}

export function assertNoForbiddenValues(
  value: unknown,
  forbiddenValues: readonly string[] = CORPUS_50_FORBIDDEN_VALUES
): void {
  const matches = findForbiddenValues(value, forbiddenValues)
  if (matches.length > 0) throw new Error('privacy_forbidden_value_detected')
}
