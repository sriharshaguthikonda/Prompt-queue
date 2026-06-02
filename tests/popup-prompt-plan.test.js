describe('popup prompt launch plan', () => {
  let mod;

  beforeAll(async () => {
    const path = require('path');
    mod = await global.loadEsmModule(path.join(__dirname, '..', 'popup-prompt-plan.js'));
  });

  it('splits tab groups with new-tab markers', () => {
    const plan = mod.buildPromptLaunchPlan('A\n---new tab---\nB\nC', '\n', '', '');
    expect(plan.hasTabMarkers).toBe(true);
    expect(plan.prompts).toEqual(['A', 'B', 'C']);
    expect(plan.tabPromptGroups).toEqual([['A'], ['B', 'C']]);
  });

  it('expands line prompt mode inside multi-line chunks', () => {
    const plan = mod.buildPromptLaunchPlan('---line prompt mode---\nA\n\nB', '\n\n', '', '');
    expect(plan.linePromptModeEnabled).toBe(true);
    expect(plan.prompts).toEqual(['A', 'B']);
  });

  it('applies append and prepend markers without global toggles', () => {
    const plan = mod.buildPromptLaunchPlan(
      '---prepend here---\nA\n---append here---\nB',
      '\n',
      'tail',
      'head',
    );
    expect(plan.prompts).toEqual(['head\n\nA\n\ntail', 'B']);
  });

  it('leaves exact duplicates unchanged by default', () => {
    const plan = mod.buildPromptLaunchPlan('A\nA', '\n', '', '');

    expect(plan.prompts).toEqual(['A', 'A']);
    expect(plan.duplicateChanged).toBe(0);
  });

  it('applies typo variants only when enabled', () => {
    const plan = mod.buildPromptLaunchPlan('A\nA', '\n', '', '', {
      enableDuplicateTypoVariants: true,
    });

    expect(plan.prompts[0]).toBe('A');
    expect(plan.prompts[1]).not.toBe('A');
    expect(plan.duplicateChanged).toBe(1);
  });
});
