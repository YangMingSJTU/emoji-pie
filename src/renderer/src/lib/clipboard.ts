export type TextClipboardWriter = (value: string) => Promise<void>

export async function writeTextWithFallback(
  value: string,
  primary: TextClipboardWriter | undefined,
  fallback: TextClipboardWriter
): Promise<void> {
  if (!primary) {
    await fallback(value)
    return
  }

  try {
    await primary(value)
  } catch (primaryError) {
    try {
      await fallback(value)
    } catch (fallbackError) {
      throw new AggregateError(
        [primaryError, fallbackError],
        '文本剪贴板写入失败'
      )
    }
  }
}
