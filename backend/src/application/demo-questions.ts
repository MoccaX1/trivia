import { validQuestionSet } from '../domain/match-engine.js';
import type { PrivateQuestion } from '../domain/match-engine.js';

// Fixed server-owned demo content. Choice IDs are unique across the entire ordered pack.
const content = [
  ['What is the capital of Vietnam?', ['Hanoi', 'Da Nang', 'Hue', 'Ho Chi Minh City'], 0],
  ['Which planet is known as the Red Planet?', ['Venus', 'Mars', 'Jupiter', 'Mercury'], 1],
  ['What is the chemical symbol for gold?', ['Ag', 'Fe', 'Au', 'Cu'], 2],
  ['How many sides does a hexagon have?', ['Five', 'Seven', 'Eight', 'Six'], 3],
  ['Which ocean is the largest?', ['Pacific', 'Atlantic', 'Indian', 'Arctic'], 0],
  ['Which organ pumps blood around the human body?', ['Liver', 'Heart', 'Lung', 'Kidney'], 1],
  [
    'Who wrote Pride and Prejudice?',
    ['Mary Shelley', 'George Eliot', 'Jane Austen', 'Virginia Woolf'],
    2,
  ],
  [
    'At standard atmospheric pressure, water freezes at what Celsius temperature?',
    ['100', '10', '-10', '0'],
    3,
  ],
  ['Which language runs natively in a web browser?', ['JavaScript', 'SQL', 'Bash', 'Rust'], 0],
  ['How many minutes are there in two hours?', ['60', '120', '90', '180'], 1],
] as const;

const pack: readonly PrivateQuestion[] = Object.freeze(
  content.map(([text, choices, answer], index) => {
    const id = `demo-q${index + 1}`;
    return Object.freeze({
      id,
      text,
      choices: Object.freeze(
        choices.map((text, choice) => Object.freeze({ id: `${id}-c${choice + 1}`, text })),
      ),
      correctChoiceId: `${id}-c${answer + 1}`,
    });
  }),
);

/** Synchronous readiness check before admission; no client-controlled selection or I/O. */
export function demoQuestions(): readonly PrivateQuestion[] {
  if (!validQuestionSet(pack)) throw new Error('Invalid server question pack');
  return pack;
}
