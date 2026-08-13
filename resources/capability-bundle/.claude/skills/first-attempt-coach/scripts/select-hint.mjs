const allowedStates = new Set([
  'QUESTION_CREATED',
  'FIRST_ATTEMPT_RECORDING',
  'FIRST_ATTEMPT_CLOSED',
  'ASSISTANCE_ALLOWED',
]);

const input = JSON.parse(process.argv[2] ?? '{}');
if (!allowedStates.has(input.state)) {
  throw new Error('A valid host attempt state is required.');
}

const prompts = {
  QUESTION_CREATED: 'Take a moment, then give your first unaided response.',
  FIRST_ATTEMPT_RECORDING: 'Continue with any fragments you can retrieve; what part is blocked?',
  FIRST_ATTEMPT_CLOSED: 'Your first attempt is recorded. Shall we analyze where retrieval slowed down?',
  ASSISTANCE_ALLOWED: 'Start with a process cue, and reveal more only if the learner requests it.',
};

process.stdout.write(JSON.stringify({ state: input.state, prompt: prompts[input.state] }));
