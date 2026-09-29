// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownText } from './MarkdownText';

afterEach(cleanup);

function formulas(container: HTMLElement): string[] {
  return [...container.querySelectorAll('annotation[encoding="application/x-tex"]')]
    .map((node) => node.textContent ?? '');
}

describe('MarkdownText math rendering', () => {
  it('renders inline formulas alongside GFM and keeps accessible TeX source', () => {
    const { container } = render(<MarkdownText text={'**能量** $E = mc^2$\n\n- [x] 已验证'} />);
    expect(formulas(container)).toEqual(['E = mc^2']);
    expect(container.querySelector('strong')?.textContent).toBe('能量');
    expect(container.querySelector('input[type="checkbox"]')).toBeTruthy();
    expect(container.querySelector('.katex-display')).toBeNull();
  });

  it.each([
    '$$\n\\frac{a}{b} = \\sqrt{x}\n$$',
    '$$\\frac{a}{b} = \\sqrt{x}$$',
    '\\[\\frac{a}{b} = \\sqrt{x}\\]',
    '```math\n\\frac{a}{b} = \\sqrt{x}\n```',
  ])('renders display math with %s', (text) => {
    const { container } = render(<MarkdownText text={text} />);
    expect(formulas(container).map((value) => value.trim())).toEqual(['\\frac{a}{b} = \\sqrt{x}']);
    expect(container.querySelector('.katex-display')).toBeTruthy();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('parses backslash delimiters before Markdown consumes TeX escapes and underscores', () => {
    const text = String.raw`行内 \(a_i^2 + \frac{1}{2}\)。

\[
\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
\]`;
    const { container } = render(<MarkdownText text={text} />);
    expect(formulas(container).map((value) => value.trim())).toEqual([
      'a_i^2 + \\frac{1}{2}',
      '\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}',
    ]);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container.querySelector('.katex-error')).toBeNull();
  });

  it('keeps prices literal without swallowing a following real formula', () => {
    const text = String.raw`费用 $5 和 $10，折扣 $2。公式 $x+1$，数值 $2$；转义 \$20。`;
    const { container } = render(<MarkdownText text={text} />);
    expect(formulas(container)).toEqual(['x+1', '2']);
    expect(container.textContent).toContain('费用 $5 和 $10，折扣 $2。公式');
    expect(container.textContent).toContain('转义 $20。');
  });

  it('leaves code, escaped delimiters and link destinations untouched', () => {
    const text = [
      '`$x$ \\(y\\)`',
      '',
      '```js',
      'const example = "$x$ \\(y\\)";',
      '```',
      '',
      String.raw`\\(literal\\)`,
      '',
      '[example](https://example.test/$path$)',
    ].join('\n');
    const { container } = render(<MarkdownText text={text} />);
    expect(formulas(container)).toEqual([]);
    expect(container.querySelector('code')?.textContent).toBe('$x$ \\(y\\)');
    expect(container.textContent).toContain('const example = "$x$ \\(y\\)";');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.test/$path$');
  });

  it('retains malformed formula source while later equations still render', () => {
    const { container } = render(<MarkdownText text={String.raw`$\frac{$ 后续 $x^2$`} />);
    expect(container.querySelector('.katex-error')?.textContent).toBe('\\frac{');
    expect(formulas(container)).toEqual(['x^2']);
  });

  it('renders multiline TeX inside block quotes and lists', () => {
    const text = String.raw`> \[
> \sum_{i=1}^{n} i = \frac{n(n+1)}{2}
> \]

- 公式 \(x_i + y_i\)`;
    const { container } = render(<MarkdownText text={text} />);
    expect(formulas(container).map((value) => value.trim())).toEqual([
      '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
      'x_i + y_i',
    ]);
    expect(container.querySelector('blockquote .katex-display')).toBeTruthy();
    expect(container.querySelector('li .katex')).toBeTruthy();
  });

  it.each([String.raw`未完成 \(\frac{x}{y}`, String.raw`未完成 \[x^2`])(
    'keeps incomplete delimiters readable without failing the message: %s',
    (text) => {
      const { container } = render(<MarkdownText text={text} />);
      expect(container.textContent).toContain('未完成');
      expect(container.querySelector('.katex')).toBeNull();
    },
  );

  it('does not allow raw HTML or TeX commands to create active content', () => {
    const text = String.raw`<script>alert(1)</script>

$\href{javascript:alert(1)}{click}$

$\includegraphics{https://example.test/tracker.png}$`;
    const { container } = render(<MarkdownText text={text} />);
    expect(container.querySelector('script, img, a')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
