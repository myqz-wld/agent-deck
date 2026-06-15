import { describe, expect, it } from 'vitest';
import { formatAskAnswers } from '../../sdk-bridge-helpers';

describe('formatAskAnswers', () => {
  it('includes per-question notes without replacing selected options or other text', () => {
    const text = formatAskAnswers(
      [
        {
          question: 'Choose a path?',
          header: 'Path',
          multiSelect: false,
          options: [
            { label: 'A', description: 'Use A' },
            { label: 'B', description: 'Use B' },
          ],
        },
      ],
      {
        answers: [
          {
            question: 'Choose a path?',
            selected: ['A'],
            other: 'also consider C',
            note: '  keep rollback easy  ',
          },
        ],
      },
    );

    expect(text).toBe(
      'Q1: Choose a path?\nA: A | 其他：also consider C | 备注：keep rollback easy',
    );
  });

  it('omits blank notes', () => {
    const text = formatAskAnswers(
      [
        {
          question: 'Proceed?',
          header: 'Go',
          multiSelect: false,
          options: [
            { label: 'Yes', description: 'Proceed' },
            { label: 'No', description: 'Stop' },
          ],
        },
      ],
      {
        answers: [{ question: 'Proceed?', selected: ['Yes'], note: '   ' }],
      },
    );

    expect(text).toBe('Q1: Proceed?\nA: Yes');
  });
});
