const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadUtils() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background-parallel-utils.js'), 'utf8');
  const context = { self: {} };
  vm.runInNewContext(source, context);
  return context.self.BackgroundParallelUtils;
}

describe('background parallel utilities', () => {
  let utils;

  beforeEach(() => {
    utils = loadUtils();
  });

  it('sanitizes nested prompt groups', () => {
    expect(utils.sanitizeParallelPromptGroups([
      [' first ', '', 42, 'second'],
      'bad',
      ['   '],
      ['third'],
    ])).toEqual([
      ['first', 'second'],
      ['third'],
    ]);
  });

  it('falls back to one prompt per group when no explicit groups are supplied', () => {
    expect(utils.resolveParallelPromptGroups(['A', 'B'], null)).toEqual([['A'], ['B']]);
  });

  it('rejects unsupported launch URLs through injected helper', () => {
    const result = utils.resolveParallelLaunchUrl('https://chatgpt.com/', {}, {
      sanitizeUrlOrEmpty: (value) => value,
      isSupportedUrl: () => false,
    });
    expect(result).toBeNull();
  });
});
