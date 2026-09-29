import type { Root, RootContent } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Extension, State, Tokenizer } from 'micromark-util-types';
import type { Plugin } from 'unified';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    chatMath: 'chatMath';
    chatMathData: 'chatMathData';
  }
}

/** Parse chat-style TeX as Markdown syntax so code and link destinations stay literal. */
export const remarkChatMath: Plugin<[], Root> = function () {
  const data = this.data() as {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: (FromMarkdownExtension | FromMarkdownExtension[])[];
  };
  const syntax: Extension = {
    text: {
      36: { name: 'chatDollarMath', tokenize: tokenizeDollarMath },
      92: { name: 'chatLatexMath', tokenize: tokenizeLatexMath },
    },
  };
  const fromMarkdown: FromMarkdownExtension = {
    enter: {
      chatMath(token) {
        const raw = this.sliceSerialize(token);
        const size = raw.startsWith('$') ? 1 : 2;
        const value = raw.slice(size, -size);
        this.enter({
          type: 'inlineMath',
          value,
          data: {
            hName: 'code',
            hProperties: {
              className: ['language-math', raw.startsWith('\\[') ? 'math-display' : 'math-inline'],
            },
            hChildren: [{ type: 'text', value }],
          },
        }, token);
        this.buffer();
      },
    },
    exit: { chatMath(token) { this.resume(); this.exit(token); } },
  };
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);

  return (tree, file) => markDisplayMath(tree, String(file.value));
};

// Single dollars follow whitespace/digit boundaries to keep "$5 and $10" as prose
// and, crucially, avoid consuming the opening delimiter of a following real formula.
const tokenizeDollarMath: Tokenizer = (effects, ok, nok) => {
  let previousWasSpace = false;
  const start: State = (code) => {
    effects.enter('chatMath');
    effects.consume(code);
    return first;
  };
  const first: State = (code) => {
    if (code === null || code <= 32 || code === 36) return nok(code);
    return content(code);
  };
  const content: State = (code) => {
    if (code === null || code === -5 || code === -4 || code === -3) return nok(code);
    if (code === 36) {
      if (previousWasSpace) return nok(code);
      effects.consume(code);
      return afterClose;
    }
    previousWasSpace = code <= 32;
    effects.consume(code);
    return code === 92 ? escaped : content;
  };
  const escaped: State = (code) => {
    if (code === null || code < 0) return nok(code);
    previousWasSpace = code <= 32;
    effects.consume(code);
    return content;
  };
  const afterClose: State = (code) => {
    if (code === 36 || (code !== null && code >= 48 && code <= 57)) return nok(code);
    effects.exit('chatMath');
    return ok(code);
  };
  return start;
};

const tokenizeLatexMath: Tokenizer = (effects, ok, nok) => {
  let close = 0;
  const start: State = (code) => {
    effects.enter('chatMath');
    effects.consume(code);
    return opening;
  };
  const opening: State = (code) => {
    if (code !== 40 && code !== 91) return nok(code);
    close = code === 40 ? 41 : 93;
    effects.consume(code);
    return between;
  };
  const between: State = (code) => {
    if (code === null) return nok(code);
    if (code === -5 || code === -4 || code === -3) {
      // Micromark needs an individual line-ending token for each text chunk.
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return between;
    }
    effects.enter('chatMathData');
    return content(code);
  };
  const content: State = (code) => {
    if (code === null || code === -5 || code === -4 || code === -3) {
      effects.exit('chatMathData');
      return between(code);
    }
    effects.consume(code);
    return code === 92 ? afterSlash : content;
  };
  const afterSlash: State = (code) => {
    if (code === null) return nok(code);
    if (code < 0) return content(code);
    effects.consume(code);
    if (code === close) {
      effects.exit('chatMathData');
      effects.exit('chatMath');
      return ok;
    }
    return content;
  };
  return start;
};

// remark-math treats same-line $$...$$ as inline. Chat messages also use that
// spelling for display equations; keep the parser's value and change only layout.
function markDisplayMath(node: Root | RootContent, source: string): void {
  const offset = node.position?.start.offset;
  if (node.type === 'inlineMath' && offset !== undefined && source.startsWith('$$', offset)) {
    node.data = {
      ...node.data,
      hProperties: { ...node.data?.hProperties, className: ['language-math', 'math-display'] },
    };
  }
  if ('children' in node) {
    for (const child of node.children) markDisplayMath(child, source);
  }
}
