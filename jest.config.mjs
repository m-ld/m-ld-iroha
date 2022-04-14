export default {
  // requires "js" to pass validation: https://github.com/facebook/jest/issues/12116
  moduleFileExtensions: ['mjs', 'js'],
  testRegex: `test\.mjs$`,
  moduleNameMapper: {
    '@m-ld/m-ld/dist/(.*)': '<rootDir>/node_modules/@m-ld/m-ld/dist/$1',
    '@m-ld/m-ld-iroha': '<rootDir>'
  }
};