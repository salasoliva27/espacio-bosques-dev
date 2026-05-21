/**
 * Minimal Jest config for the backend.
 *
 * Added alongside the Reality Check feature so its pure helpers
 * (computeDelta, aggregateOutcome) can be unit-tested with `yarn test`.
 * The repo was missing any Jest config — `ts-jest` was declared as a dev
 * dep but never wired up.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  rootDir: 'src',
  moduleFileExtensions: ['ts', 'js'],
  // ts-jest with isolatedModules: avoids re-typechecking the whole project
  // for each test. The rest of the codebase has pre-existing TS errors
  // (CI has been red since Apr 7) that are intentionally not fixed here.
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
};
