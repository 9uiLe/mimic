type TokenType = 'color' | 'dimension' | 'number' | 'fontWeight' | 'fontFamily' | 'typography';
type Token = { type: TokenType; value: unknown; description?: string };
const fields = { fontFamily: 'fontFamily', fontSize: 'dimension', fontWeight: 'fontWeight',
  letterSpacing: 'dimension', lineHeight: 'number' } as const;
const supported = new Set(['color', 'dimension', 'number', 'fontWeight', 'fontFamily', 'typography']);
const property = (name: string) => `--${name.replaceAll('.', '-').replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)}`;
const alias = (value: unknown) => typeof value === 'string' ? value.match(/^\{([^}]+)\}$/)?.[1] : undefined;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validates the repository token format and returns CSS without writing build outputs. */
export function compileDesignTokens(source: unknown) {
  if (!record(source)) throw new Error('Invalid token root');
  const tokens = new Map<string, Token>();
  const properties = new Set<string>();
  function walk(group: Record<string, unknown>, prefix = '') {
    for (const [key, item] of Object.entries(group)) {
      if (key.startsWith('$')) continue;
      const name = prefix ? `${prefix}.${key}` : key;
      if (!/^[a-zA-Z][a-zA-Z\d]*$|^\d+$/.test(key) || !record(item)) throw new Error(`Invalid token group: ${name}`);
      if (typeof item.type === 'string' || 'value' in item) {
        if (typeof item.type !== 'string' || !supported.has(item.type) || !('value' in item)
          || Object.keys(item).some(field => !['type', 'value', 'description'].includes(field))
          || ('description' in item && typeof item.description !== 'string')) throw new Error(`Invalid token: ${name}`);
        if (properties.has(property(name))) throw new Error(`Duplicate CSS token: ${name}`);
        properties.add(property(name));
        tokens.set(name, item as Token);
      } else walk(item, name);
    }
  }
  walk(source);
  if (!tokens.size) throw new Error('Token source is empty');
  function literalValue(value: unknown, type: TokenType, name: string): unknown {
    if (type === 'color' && typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)) return value;
    if (type === 'dimension' && typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:rem|px)$/.test(value)) return value;
    if ((type === 'number' || type === 'fontWeight') && typeof value === 'number' && Number.isFinite(value)
      && (type !== 'fontWeight' || (value >= 1 && value <= 1000))) return value;
    if (type === 'fontFamily' && Array.isArray(value) && value.length
      && value.every(family => typeof family === 'string' && /^[\w -]+$/.test(family))) return value;
    throw new Error(`Invalid ${type}: ${name}`);
  }
  function resolveValue(value: unknown, type: TokenType, name: string, trail: string[]): unknown {
    const reference = alias(value);
    if (reference) {
      if (!tokens.has(reference)) throw new Error(`Unknown token: ${reference}`);
      if (tokens.get(reference)!.type !== type) throw new Error(`Alias type mismatch: ${name}`);
      return resolve(reference, trail);
    }
    return literalValue(value, type, name);
  }
  function resolve(name: string, trail: string[] = []): unknown {
    if (trail.includes(name)) throw new Error(`Token cycle: ${[...trail, name].join(' → ')}`);
    const token = tokens.get(name)!;
    const nextTrail = [...trail, name];
    if (token.type !== 'typography' || alias(token.value)) return resolveValue(token.value, token.type, name, nextTrail);
    if (!record(token.value) || Object.keys(token.value).sort().join() !== Object.keys(fields).sort().join()) {
      throw new Error(`Incomplete typography: ${name}`);
    }
    const values = token.value;
    return Object.fromEntries(Object.entries(fields).map(([field, type]) =>
      [field, resolveValue(values[field], type, `${name}.${field}`, nextTrail)]));
  }
  const literal = (value: unknown, type: string): string => type === 'fontFamily'
    ? (value as string[]).map(family => family.includes(' ') ? JSON.stringify(family) : family).join(', ') : String(value);
  const declarations: string[] = [];
  const resolved: Record<string, unknown> = {};
  for (const [name, token] of tokens) {
    resolved[name] = resolve(name);
    if (token.type === 'typography') {
      for (const [field, type] of Object.entries(fields)) {
        const reference = alias(token.value);
        const value = reference ? `{${reference}.${field}}` : (token.value as Record<string, unknown>)[field];
        declarations.push(`  ${property(`${name}.${field}`)}: ${alias(value) ? `var(${property(alias(value)!)})` : literal(value, type)};`);
      }
    } else {
      const reference = alias(token.value);
      declarations.push(`  ${property(name)}: ${reference ? `var(${property(reference)})` : literal(token.value, token.type)};`);
    }
  }
  const typeClasses = [...tokens].filter(([, token]) => token.type === 'typography').map(([name]) => {
    const prefix = property(name);
    return `.type-${name.split('.').at(-1)} {\n` + Object.keys(fields).map(field => {
      const cssField = field.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
      return `  ${cssField}: var(${prefix}-${cssField});`;
    }).join('\n') + '\n}';
  });
  const css = `/* Generated from design/tokens.json by scripts/design-tokens.ts. */\n:root {\n${declarations.join('\n')}\n}\n${typeClasses.join('\n')}\n`;
  return { css, resolved };
}
