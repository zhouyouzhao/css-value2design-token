// src/lib/normalize.ts（简版）
export function normalizeCssValue(v: string): string | null {
  if (!v) return null;
  const s = v.trim();

  // var() 函数 -> 提取变量名并归一化
  // 例如: var(--color-primary) -> var(--color-primary)
  //      var(--spacing-xl, 20px) -> var(--spacing-xl)
  const varMatch = s.match(/^var\(\s*(--[a-zA-Z0-9-_]+)(?:\s*,\s*.*)?\s*\)$/i);
  if (varMatch) {
    return `var(${varMatch[1]})`;
  }

  // hex -> hex6/8 小写
  const hex = s.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) return canonicalHex(s);

  // rgb/rgba/hsl/hsla -> 去空格小写
  if (/^(rgb|rgba|hsl|hsla)\(/i.test(s))
    return s.replace(/\s+/g, "").toLowerCase();

  // 长度
  if (/^\d+(\.\d+)?(px|rem|em|%|vh|vw|dvh|svh|lvh)$/i.test(s)) {
    const m = s.match(/^(\d+(?:\.\d+)?)([a-z%]+)$/i)!;
    const num = Number(m[1]);
    const unit = m[2].toLowerCase();
    const n = Number.isInteger(num)
      ? String(num)
      : String(Number(num.toFixed(4)));
    return n + unit;
  }

  // 阴影/渐变：压缩空格/逗号
  if (
    /(box-shadow|drop-shadow|linear-gradient|radial-gradient|inset)/i.test(s) ||
    /,/.test(s)
  ) {
    return s
      .replace(/\s*,\s*/g, ",")
      .replace(/\s+/g, " ")
      .trim();
  }

  return s;
}

function canonicalHex(h: string): string {
  let s = h.toLowerCase();
  if (s.length === 4 || s.length === 5) {
    const cs = s.slice(1).split("");
    s = "#" + cs.map((c) => c + c).join("");
  }
  return s;
}
