# Issue 008: Test coverage

GitHub: https://github.com/sriharshaguthikonda/Prompt-queue/issues/8

## Status

Implemented with a runnable Jest/jsdom harness and focused helper-module coverage.

## Goal

Make the test command runnable and add focused coverage for recently split planning/parallel helper modules.

## Targets

- `package.json`: declare Jest/jsdom dev dependencies.
- `.gitignore`: ignore dependency/cache/generated files.
- `tests/popup-prompt-plan.test.js`: cover tab markers, line prompt mode, append/prepend markers.
- `tests/background-parallel-utils.test.js`: cover parallel group sanitizing and launch URL handling.

## Acceptance

- [x] `npm test -- --runInBand` runs after dependencies are installed.
- [x] New tests cover `popup-prompt-plan.js` and `background-parallel-utils.js`.
- [x] Existing test files are not broadened into brittle browser E2E claims.

## Evidence

- `npm test -- --runInBand`: 5 suites, 99 tests passed.
