module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'popup.js',
    'content.js',
    'background.js',
    '!**/*.min.js',
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },
  testTimeout: 10000,
  verbose: true,
};
