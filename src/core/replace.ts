export function replaceWithVar(varName: string): string {
  const input = (varName || '').trim();

  // 已经是 var(...) 的情况，直接返回，避免二次包裹
  if (/^var\(/i.test(input)) return input;

  // 提取 token 名，容忍传入 "var(--xxx)"、"--xxx" 或 "xxx"
  const m = input.match(/--[a-z0-9\-_]+/i);
  const token = m ? m[0] : (input.startsWith('--') ? input : `--${input}`);

  return `var(${token})`;
}
