import type { ProbeMetrics, ProbeTimings } from './contracts'

interface SchemaNode {
  type?: string | string[]
  enum?: unknown[]
  const?: unknown
  required?: string[]
  properties?: Record<string, SchemaNode>
  additionalProperties?: boolean
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
}

export function emptyTimings(): ProbeTimings {
  return {
    planner: 0,
    search: 0,
    license_gate: 0,
    download_span: 0,
    decode_compose_span: 0,
    three_ready: 0,
    nine_ready: 0,
    clipboard: 0,
    export: 0,
    total: 0
  }
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

export function validateJsonSchemaSubset(
  value: unknown,
  schema: SchemaNode,
  path = '$'
): string[] {
  const errors: string[] = []
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type
  if (types && !types.some((type) => matchesType(value, type))) {
    return [`${path}:type`]
  }
  if (schema.enum && !schema.enum.some((entry) => Object.is(entry, value))) {
    errors.push(`${path}:enum`)
  }
  if ('const' in schema && !Object.is(schema.const, value)) errors.push(`${path}:const`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}:minLength`)
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) errors.push(`${path}:pattern`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}:minimum`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}:maximum`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const record = value as Record<string, unknown>
    for (const required of schema.required ?? []) {
      if (!(required in record)) errors.push(`${path}.${required}:required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) errors.push(`${path}.${key}:additionalProperty`)
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (key in record) errors.push(...validateJsonSchemaSubset(record[key], childSchema, `${path}.${key}`))
    }
  }
  return errors
}

export function assertMetricsMatchSchema(metrics: ProbeMetrics, schema: unknown): void {
  const errors = validateJsonSchemaSubset(metrics, schema as SchemaNode)
  if (errors.length > 0) throw new Error(`metrics_schema_invalid:${errors.join(',')}`)
}
