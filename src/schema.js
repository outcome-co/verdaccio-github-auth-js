/* istanbul ignore file */
// This file is just used as a bridge between the graphql-schema and the code-generator script
const { schema } = require('@octokit/graphql-schema')
module.exports = schema.json
