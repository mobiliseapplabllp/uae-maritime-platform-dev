/* Reading a SOAP answer.
 *
 * The one counterpart that mandates SOAP answers with an envelope, and the services that called it expect an object
 * with named fields — the same shape the recorded contract gives them. This reads the body of the envelope into that
 * object: the first element under Body is the answer, its children are its fields, a field with children of one
 * repeated name is a list, and a Fault comes back as `{ fault: { code, text } }`. Namespace prefixes are dropped and
 * attributes ignored: a contract of ours is fields and lists, and a parser that tried to be XML in full would be a
 * larger attack surface than the exchange deserves. Entities are decoded, nothing is evaluated. */

type Node = { name: string; children: Node[]; text: string };

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const localName = (raw: string) => raw.replace(/^[\w.-]+:/, '');

/** A small element parser: tags, text and self-closing tags; comments, declarations and CDATA are skipped or read as text. */
export function parseXml(text: string): Node | null {
  const src = text.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string)));
  const root: Node = { name: '', children: [], text: '' };
  const stack: Node[] = [root];
  const tag = /<\/?([\w.:-]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let depth = 0;
  while ((m = tag.exec(src))) {
    const [whole, name, selfClose, textRun] = m;
    if (textRun !== undefined) { const t = textRun.trim(); if (t) stack[stack.length - 1].text += unescape(t); continue; }
    if (whole.startsWith('</')) { if (stack.length > 1) { stack.pop(); depth -= 1; } continue; }
    const node: Node = { name: localName(name), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) { stack.push(node); depth += 1; if (depth > 64) return null; }
  }
  return root.children[0] ?? null;
}

/** An element as data: a leaf is its text, a parent is an object of its children, and a run of one repeated child name is a list. */
export function toData(node: Node): unknown {
  if (!node.children.length) return node.text;
  const names = new Set(node.children.map((c) => c.name));
  if (names.size === 1 && node.children.length > 1) return node.children.map(toData);
  const out: Record<string, unknown> = {};
  for (const c of node.children) {
    const v = toData(c);
    if (c.name in out) { const prev = out[c.name]; out[c.name] = Array.isArray(prev) ? [...prev, v] : [prev, v]; } else out[c.name] = v;
  }
  return out;
}

/** The answer inside a SOAP envelope, or null when the text is not one. A list-bearing field ("conditions") comes back as an array even when it holds one entry or none. */
export function parseSoapAnswer(text: string): unknown {
  if (!/<(?:[\w.-]+:)?Envelope[\s>]/.test(text)) return null;
  const root = parseXml(text);
  if (!root) return null;
  const body = root.name === 'Envelope' ? root.children.find((c) => c.name === 'Body') : null;
  if (!body) return null;
  const answer = body.children[0];
  if (!answer) return {};
  if (answer.name === 'Fault') {
    const code = answer.children.find((c) => c.name === 'faultcode')?.text ?? ''; const fs = answer.children.find((c) => c.name === 'faultstring')?.text ?? '';
    return { fault: { code, text: fs } };
  }
  const data = toData(answer);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = data as Record<string, unknown>;
  // a plural field that arrived with one child, or empty, is still a list
  for (const c of answer.children) {
    if (/s$/.test(c.name) && (c.children.length === 1 || (!c.children.length && !c.text))) {
      const v = out[c.name];
      out[c.name] = c.children.length ? [toData(c.children[0])] : Array.isArray(v) ? v : [];
    }
  }
  return out;
}
