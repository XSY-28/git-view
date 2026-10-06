import type { Language } from '@git-view/contracts';
import { englishMessages } from './messages';

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(englishMessages).filter(([source]) => /\{\d+\}/.test(source)).map(([source, target]) => {
  const slots: number[] = [];
  const pieces = source.split(/(\{\d+\})/).map(piece => {
    if (/^\{\d+\}$/.test(piece)) { slots.push(Number(piece.slice(1, -1))); return '([\\s\\S]*?)'; }
    return escapePattern(piece);
  });
  return { regex: new RegExp(`^${pieces.join('')}$`), target, slots, specificity: source.replace(/\{\d+\}/g, '').length };
}).sort((a, b) => b.specificity - a.specificity);

/** Translate application messages, including host templates. Never use on file
 * contents, paths, branch names, commit messages, or raw Git diagnostics. */
export function translate(message: string, language: Language, values?: readonly (string | number)[]): string {
  if (values) {
    const template = language === 'en' ? englishMessages[message] ?? message : message;
    return template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ''));
  }
  return translateMessage(message, language);
}

function translateMessage(message: string, language: Language, depth = 0): string {
  if (language === 'zh-CN' || !message || depth > 5 || !/[\u4e00-\u9fff]/.test(message)) return message;
  const direct = englishMessages[message];
  if (direct !== undefined && !/\{\d+\}/.test(message)) return direct;
  for (const { regex, target, slots } of patterns) {
    const match = regex.exec(message);
    if (match) return target.replace(/\{(\d+)\}/g, (_, slot: string) => translateMessage(match[slots.indexOf(Number(slot)) + 1] ?? '', language, depth + 1));
  }
  // Error codes and the retained-result suffix are added by the presentation
  // layer. Localize the message independently, preserving the diagnostic code.
  const code = /^(.*)（([A-Z_]+)）$/.exec(message);
  if (code) return `${translateMessage(code[1]!, language, depth + 1)} (${code[2]})`;
  const retained = ' 显示上次结果。';
  if (message.endsWith(retained)) return translateMessage(message.slice(0, -retained.length), language, depth + 1) + englishMessages[retained];
  const wholeFile = ' 确认后仍将操作整个文件。';
  if (message.endsWith(wholeFile)) return translateMessage(message.slice(0, -wholeFile.length), language, depth + 1) + englishMessages[wholeFile];
  // Hosts prefix some errors with a path. Preserve that path verbatim and
  // localize only a recognized application message following the separator.
  const separator = message.indexOf('：');
  if (separator >= 0) {
    const suffix = message.slice(separator + 1);
    const localized = translateMessage(suffix, language, depth + 1);
    if (localized !== suffix) return `${message.slice(0, separator)}: ${localized}`;
  }
  return message;
}
