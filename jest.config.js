const { merge, mergeWith } = require('@outcome-co/devkit/dist/utils/mergeConfig')

const jestConfig = require('@outcome-co/devkit/dist/config/jest')

// We want to exclude graphql.js from the coverage during unit tests
// we only want coverage during integration tests
const additionalExcludes = [
    '!./src/test/**/*.ts'
]

if (process.env.TEST_ENV === 'test') {
    additionalExcludes.push('!./src/graphql.ts')
}

module.exports = merge(jestConfig, {
    collectCoverageFrom: mergeWith(additionalExcludes),
    // We want to allow Jest to transpile objectmodel, as it's ES6 and used in tests
    transformIgnorePatterns: ['node_modules/(?!(objectmodel)/)']
})
