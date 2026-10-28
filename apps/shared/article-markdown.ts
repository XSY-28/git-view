import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Nodes } from 'mdast';
const parser = unified().use(remarkParse).use(remarkGfm);
function text(node: Nodes): string {
  if ('children' in node) return node.children.map(child => text(child)).join('');
  return 'value' in node ? node.value : node.type === 'image' ? node.alt ?? '' : '';
}
export function articleStructure(markdown: string) {
  const tree = parser.parse(markdown);
  const headings: { id: string; depth: number; text: string }[] = [];
  const images = new Set<string>(); const definitions = new Map<string, string>();
  visit(tree, 'definition', node => { definitions.set(node.identifier.toUpperCase(), node.url); });
  visit(tree, node => {
    if (node.type === 'heading') headings.push({ id: `section-${node.position?.start.offset ?? 0}`, depth: node.depth, text: text(node) });
    if (node.type === 'image') images.add(node.url);
    if (node.type === 'imageReference') { const url = definitions.get(node.identifier.toUpperCase()); if (url) images.add(url); }
  });
  return { headings, images: [...images] };
}
